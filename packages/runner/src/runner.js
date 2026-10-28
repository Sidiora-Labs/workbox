import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { EventEmitter, once } from 'node:events';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Peer,
  ProtocolError,
  Codes,
  PROTOCOL_VERSION,
  validateParams,
  methodNames,
} from '@workbox/protocol';
import { selfChecks } from './checks.js';
import { createLog } from './log.js';
import { SessionManager } from './sessions.js';
import { createFs } from './fs.js';

export const RUNNER_VERSION = '0.1.0-alpha.1';

/**
 * @typedef {object} Boot
 * @property {string} bootId
 * @property {string} nonce
 * @property {string} sandboxId
 * @property {number} protocol
 * @property {string} [runtime]
 */

/**
 * The in-box supervisor. Serves one unix socket for both the host (control channel) and local
 * clients such as wb. Holds a boot barrier: nothing runs until the host sends runner.go.
 *
 * Emits: 'listening', 'control' (peer attached), 'detached', 'ready', 'stopped'.
 */
export class Runner extends EventEmitter {
  /**
   * @param {{socketPath: string, boot: Boot, log?: ReturnType<typeof createLog>, clock?: () => number, checks?: typeof selfChecks}} opts
   */
  constructor(opts) {
    super();
    this.socketPath = opts.socketPath;
    this.boot = opts.boot;
    this.log = opts.log ?? createLog();
    this.clock = opts.clock ?? Date.now;
    this.runChecks = opts.checks ?? selfChecks;
    this.startedAt = this.clock();
    this.phase = 'boot';
    /** @type {Peer|null} */
    this.control = null;
    this.nonceGiven = false;
    /** @type {Set<Peer>} */
    this.peers = new Set();
    this.server = null;
    this.env = {};
    this.network = { mode: 'none' };
    this.checks = null;
    this.sessions = new SessionManager({
      log: this.log,
      clock: this.clock,
      defaultSpoolBytes: opts.spoolBytes,
      stopGraceMs: opts.stopGraceMs,
      baseEnv: () => ({ ...process.env, ...this.env }),
    });
    this.maxPeers = opts.maxPeers ?? 64;
    this.fs = createFs({ root: opts.fsRoot });
    this.sessions.on('started', (info) => this._toControl('session.started', info));
    this.sessions.on('exit', (info) => this._toControl('session.exit', info));
  }

  _toControl(method, params) {
    if (this.control && !this.control.closed)
      this.control.notify(method, params).catch(() => undefined);
  }

  /** Bind the socket and accept connections. */
  async start() {
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // no stale socket
    }
    this.server = net.createServer((socket) => this._accept(socket));
    this.server.listen(this.socketPath);
    await once(this.server, 'listening');
    fs.chmodSync(this.socketPath, 0o600);
    this.log.info('listening', {
      socket: this.socketPath,
      bootId: this.boot.bootId,
      pid: process.pid,
    });
    this.emit('listening');
  }

  /**
   * Close the socket and every peer, then emit 'stopped'.
   * @param {{reason?: string}} [opts]
   */
  async stop(opts = {}) {
    if (this.phase === 'stopped') return;
    this.phase = 'stopping';
    this.log.info('stopping', { reason: opts.reason ?? 'requested' });
    await this.sessions.stopAll({ graceMs: opts.graceMs });
    for (const peer of this.peers) peer.close();
    this.peers.clear();
    this.control = null;
    if (this.server) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
    }
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // already gone
    }
    this.phase = 'stopped';
    this.emit('stopped');
  }

  /** Snapshot for runner.status. */
  status() {
    return {
      runnerVersion: RUNNER_VERSION,
      protocol: PROTOCOL_VERSION,
      phase: this.phase,
      pid: process.pid,
      bootId: this.boot.bootId,
      sandboxId: this.boot.sandboxId,
      uptimeMs: this.clock() - this.startedAt,
      hostname: os.hostname(),
      connections: this.peers.size,
      control: this.control !== null,
      sessions: this.sessions.liveCount,
      network: this.network,
    };
  }

  // ── connections ──

  _accept(socket) {
    if (this.peers.size >= this.maxPeers) {
      socket.destroy();
      return;
    }
    const peer = new Peer(socket, { name: 'runner-peer' });
    peer.role = 'local';
    this.peers.add(peer);
    peer.on('close', () => {
      this.peers.delete(peer);
      if (this.control === peer) {
        this.control = null;
        this.log.warn('control channel detached');
        this.emit('detached');
      }
    });
    peer.on('handlerError', (e, method) => this.log.error('handler failed', { method, err: e }));
    peer.on('protocolError', (e) => this.log.warn('protocol error', { err: e }));
    this._register(peer);
  }

  _register(peer) {
    const guarded = (method, fn) =>
      peer.handle(method, (params, ctx) => fn(validateParams(method, params), ctx));
    guarded('runner.hello', (p) => this._hello(peer, p));
    guarded('runner.go', (p) => this._go(peer, p));
    guarded('runner.status', () => this.status());
    guarded('runner.shutdown', (p) => {
      this._requireControl(peer);
      setImmediate(() => this.stop({ reason: 'runner.shutdown', graceMs: p.graceMs }));
      return { stopping: true };
    });
    const ready = (fn) => (p, ctx) => {
      this._requireReady();
      return fn(p, ctx);
    };
    guarded(
      'session.start',
      ready((p) => this._sessionStart(p)),
    );
    guarded(
      'session.list',
      ready(() => ({ sessions: this.sessions.list() })),
    );
    guarded(
      'session.attach',
      ready((p) => this.sessions.attach(p.sessionId, peer, p.fromSeq ?? 0)),
    );
    guarded(
      'session.detach',
      ready((p) => this.sessions.detach(p.sessionId, peer)),
    );
    guarded(
      'session.input',
      ready((p) => this.sessions.input(p.sessionId, p)),
    );
    guarded(
      'session.signal',
      ready((p) => this.sessions.signal(p.sessionId, p.signal)),
    );
    guarded(
      'session.stop',
      ready((p) => this.sessions.stop(p.sessionId, { graceMs: p.graceMs })),
    );
    guarded(
      'session.resize',
      ready((p) => this.sessions.resize(p.sessionId, p.rows, p.cols)),
    );
    guarded(
      'session.remove',
      ready((p) => this.sessions.remove(p.sessionId)),
    );
    guarded(
      'fs.read',
      ready((p) => this.fs.read(p)),
    );
    guarded(
      'fs.write',
      ready((p) => this.fs.write(p)),
    );
    guarded(
      'fs.list',
      ready((p) => this.fs.list(p)),
    );
    guarded(
      'fs.stat',
      ready((p) => this.fs.stat(p)),
    );
    guarded(
      'fs.mkdir',
      ready((p) => this.fs.mkdir(p)),
    );
    guarded(
      'fs.remove',
      ready((p) => this.fs.remove(p)),
    );
    for (const method of methodNames().filter((m) => m.startsWith('broker.'))) {
      guarded(
        method,
        ready((p) => this._relay(peer, method, p)),
      );
    }
  }

  async _sessionStart(p) {
    if (!p.secretRefs?.length) return this.sessions.start(p);
    if (!this.control || this.control.closed)
      throw new ProtocolError(Codes.UNAVAILABLE, 'no control channel for secret resolution');
    const resolved = await this.control.request(
      'broker.secret.resolve',
      { refs: p.secretRefs },
      { timeoutMs: 10_000 },
    );
    return this.sessions.start({ ...p, secretEnv: resolved.env ?? {} });
  }

  _relay(peer, method, params) {
    if (method === 'broker.secret.resolve' && peer !== this.control)
      throw new ProtocolError(Codes.DENIED, 'secret resolution is runner-internal only');
    if (!this.control || this.control.closed)
      throw new ProtocolError(Codes.UNAVAILABLE, 'no control channel for broker relay');
    if (peer === this.control)
      throw new ProtocolError(Codes.DENIED, 'broker methods are served by the host, not relayed');
    return this.control.request(method, params, { timeoutMs: 30_000 });
  }

  _requireControl(peer) {
    if (peer !== this.control)
      throw new ProtocolError(Codes.DENIED, 'only the control channel may do this');
  }

  _requireReady() {
    if (this.phase !== 'ready')
      throw new ProtocolError(Codes.STATE, `runner is ${this.phase}, not ready`, {
        phase: this.phase,
      });
  }

  _hello(peer, p) {
    if (p.protocol !== PROTOCOL_VERSION) {
      throw new ProtocolError(
        Codes.UNSUPPORTED,
        `protocol ${p.protocol} unsupported, runner speaks ${PROTOCOL_VERSION}`,
        { supported: PROTOCOL_VERSION },
      );
    }
    const role = p.role ?? 'local';
    let nonce = null;
    if (role === 'host') {
      if (this.boot.hostTokenHash) {
        const given = p.hostToken
          ? createHash('sha256').update(p.hostToken).digest()
          : Buffer.alloc(0);
        const want = Buffer.from(this.boot.hostTokenHash, 'hex');
        if (given.length !== want.length || !timingSafeEqual(given, want))
          throw new ProtocolError(Codes.DENIED, 'invalid host token');
      }
      if (this.control && this.control !== peer)
        throw new ProtocolError(Codes.BUSY, 'a control channel is already attached');
      this.control = peer;
      peer.role = 'host';
      if (!this.nonceGiven) {
        nonce = this.boot.nonce;
        this.nonceGiven = true;
        this.boot = { ...this.boot, nonce: null };
      }
      this.log.info('control channel attached', { firstTime: nonce !== null });
      this.emit('control', peer);
    }
    return { ...this.status(), role, nonce };
  }

  async _go(peer, p) {
    this._requireControl(peer);
    if (this.phase === 'ready') return { ready: true, checks: this.checks, alreadyReady: true };
    if (this.phase !== 'boot')
      throw new ProtocolError(Codes.STATE, `runner is ${this.phase}`, { phase: this.phase });
    if (p.env) this.env = { ...p.env };
    if (p.network) this.network = { ...p.network };
    this.checks = await this.runChecks();
    this.phase = 'ready';
    this.log.info('ready', { ok: this.checks.ok, problems: this.checks.problems });
    this.emit('ready', this.checks);
    return { ready: true, checks: this.checks };
  }
}
