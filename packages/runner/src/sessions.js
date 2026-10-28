import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { ProtocolError, Codes, newId } from '@workbox/protocol';
import { RingSpool, DEFAULT_SPOOL_BYTES } from './spool.js';
import { spawnPty, resizePty } from './pty.js';

export const DEFAULT_STOP_GRACE_MS = 5000;

/** errno of a failed spawn -> protocol code */
const SPAWN_ERRORS = Object.freeze({
  ENOENT: Codes.NOT_FOUND,
  EACCES: Codes.DENIED,
  EPERM: Codes.DENIED,
});

/** Injected values shorter than this are not redacted: doing so would destroy ordinary output. */
export const MIN_REDACT_LENGTH = 6;

/**
 * Redaction table for a session's injected secret env, longest value first.
 * @param {Record<string, string>|undefined} secretEnv
 * @returns {Array<{value: Buffer, marker: Buffer}>}
 */
export function redactions(secretEnv) {
  return Object.entries(secretEnv ?? {})
    .filter(([, v]) => typeof v === 'string' && v.length >= MIN_REDACT_LENGTH)
    .sort(([, a], [, b]) => b.length - a.length)
    .map(([name, v]) => ({ value: Buffer.from(v), marker: Buffer.from(`[REDACTED:${name}]`) }));
}

/**
 * Replace every occurrence of a registered value in one output chunk, byte-wise.
 * @param {Buffer} data @param {Array<{value: Buffer, marker: Buffer}>} table
 * @returns {Buffer}
 */
export function redactChunk(data, table) {
  let out = data;
  for (const { value, marker } of table ?? []) {
    let i = out.indexOf(value);
    if (i === -1) continue;
    const parts = [];
    let from = 0;
    while (i !== -1) {
      parts.push(out.subarray(from, i), marker);
      from = i + value.length;
      i = out.indexOf(value, from);
    }
    parts.push(out.subarray(from));
    out = Buffer.concat(parts);
  }
  return out;
}

/**
 * @typedef {object} Session
 * @property {string} sessionId
 * @property {string|null} name
 * @property {string[]} argv
 * @property {string} cwd
 * @property {number} pid
 * @property {number} startedAt
 * @property {{code: number|null, signal: string|null, at: number}|null} exited
 * @property {RingSpool} spool
 * @property {Set<import('@workbox/protocol').Peer>} subscribers
 * @property {import('node:child_process').ChildProcess} child
 * @property {boolean} stdinClosed
 */

/**
 * Durable sessions inside the box. Each session is a child process in its own process group with
 * a ring spool of output; subscribers receive output as `session.output` events, everyone on the
 * control channel receives `session.started` and `session.exit`.
 *
 * Emits: 'started' (info), 'exit' (info), 'output' ({sessionId, stream, seq, data}).
 */
export class SessionManager extends EventEmitter {
  /**
   * @param {{log?: {info: Function, warn: Function, error: Function, debug: Function}, clock?: () => number, defaultSpoolBytes?: number, stopGraceMs?: number, baseEnv?: () => Record<string, string>}} [opts]
   */
  constructor(opts = {}) {
    super();
    this.log = opts.log ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.clock = opts.clock ?? Date.now;
    this.defaultSpoolBytes = opts.defaultSpoolBytes ?? DEFAULT_SPOOL_BYTES;
    this.stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
    this.baseEnv = opts.baseEnv ?? (() => ({ ...process.env }));
    this.maxSessions = opts.maxSessions ?? 256;
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
  }

  /**
   * @param {{argv: string[], cwd?: string, env?: Record<string,string>, inheritEnv?: boolean, uid?: number, gid?: number, name?: string, pty?: boolean, spoolBytes?: number, secretRefs?: string[], secretEnv?: Record<string,string>}} params
   * @returns {Promise<{sessionId: string, pid: number, name: string|null, startedAt: number}>}
   */
  async start(params) {
    if (this.sessions.size >= this.maxSessions)
      throw new ProtocolError(Codes.LIMIT, `too many sessions (max ${this.maxSessions})`);
    if (params.secretRefs && params.secretRefs.length && !params.secretEnv)
      throw new ProtocolError(
        Codes.UNSUPPORTED,
        'secret injection is not available in this runner',
      );
    const cwd = params.cwd ?? process.cwd();
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
      throw new ProtocolError(Codes.NOT_FOUND, `cwd ${cwd} is not a directory`, { cwd });
    const env = {
      ...(params.inheritEnv === false ? {} : this.baseEnv()),
      ...(params.env ?? {}),
      ...(params.secretEnv ?? {}),
    };
    const sessionId = newId(this.clock());
    let child;
    try {
      child = params.pty
        ? spawnPty(params.argv, {
            cwd,
            env,
            uid: params.uid,
            gid: params.gid,
            rows: params.rows,
            cols: params.cols,
          })
        : spawn(params.argv[0], params.argv.slice(1), {
            cwd,
            env,
            uid: params.uid,
            gid: params.gid,
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: true,
          });
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      const code = SPAWN_ERRORS[e.code] ?? Codes.INVALID_PARAMS;
      throw new ProtocolError(code, `cannot start ${params.argv[0]}: ${e.message}`, {
        argv: params.argv,
        errno: e.code,
      });
    }
    const spawned = await new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (e) => reject(e));
    }).catch((e) => {
      const code = SPAWN_ERRORS[e.code] ?? Codes.INVALID_PARAMS;
      throw new ProtocolError(code, `cannot start ${params.argv[0]}: ${e.message}`, {
        argv: params.argv,
        errno: e.code,
      });
    });
    if (!spawned) throw new ProtocolError(Codes.INTERNAL, 'spawn did not report');
    const startedAt = this.clock();
    /** @type {Session} */
    const session = {
      sessionId,
      name: params.name ?? null,
      argv: params.argv,
      cwd,
      pid: child.pid,
      startedAt,
      exited: null,
      spool: new RingSpool({ capacityBytes: params.spoolBytes ?? this.defaultSpoolBytes }),
      subscribers: new Set(),
      child,
      pty: Boolean(params.pty),
      stdinClosed: false,
      redact: redactions(params.secretEnv),
    };
    this.sessions.set(sessionId, session);
    child.stdout.on('data', (d) => this._output(session, session.pty ? 'pty' : 'stdout', d));
    if (child.stderr) child.stderr.on('data', (d) => this._output(session, 'stderr', d));
    child.stdin.on('error', (e) => this.log.debug('stdin error', { sessionId, err: e }));
    child.on('close', (code, signal) => {
      session.exited = { code, signal, at: this.clock() };
      const info = { sessionId, code, signal, seq: session.spool.nextSeq, at: session.exited.at };
      this.log.info('session exit', info);
      for (const peer of session.subscribers)
        peer.notify('session.exit', info).catch(() => undefined);
      session.subscribers.clear();
      this.emit('exit', info);
    });
    const info = { sessionId, name: session.name, pid: child.pid, argv: params.argv, startedAt };
    this.log.info('session started', info);
    this.emit('started', info);
    return info;
  }

  _output(session, stream, raw) {
    const data = redactChunk(raw, session.redact);
    const seq = session.spool.append(stream, data, this.clock());
    const event = { sessionId: session.sessionId, stream, seq, data: data.toString('base64') };
    for (const peer of session.subscribers)
      peer.notify('session.output', event).catch(() => undefined);
    this.emit('output', event);
  }

  /** @param {string} sessionId @returns {Session} */
  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s)
      throw new ProtocolError(Codes.NOT_FOUND, `session ${sessionId} not found`, { sessionId });
    return s;
  }

  list() {
    return [...this.sessions.values()].map((s) => this.describe(s));
  }

  /** @param {Session} s */
  describe(s) {
    return {
      sessionId: s.sessionId,
      name: s.name,
      pid: s.pid,
      argv: s.argv,
      cwd: s.cwd,
      startedAt: s.startedAt,
      exited: s.exited,
      seq: s.spool.nextSeq,
      spool: s.spool.stats(),
      attached: s.subscribers.size,
    };
  }

  /**
   * Replay retained output to the peer from `fromSeq`, then keep it subscribed.
   * @param {string} sessionId
   * @param {import('@workbox/protocol').Peer} peer
   * @param {number} [fromSeq]
   */
  async attach(sessionId, peer, fromSeq = 0) {
    const s = this.get(sessionId);
    // Subscribe first with a watermark so output produced during replay is delivered live
    // (seq >= watermark) and never lost; replay covers only seq < watermark.
    const watermark = s.spool.nextSeq;
    if (!s.exited) {
      s.subscribers.add(peer);
      peer.once('close', () => s.subscribers.delete(peer));
    }
    const { chunks, gap } = s.spool.replayFrom(fromSeq);
    const replay = chunks.filter((c) => c.seq < watermark);
    for (const c of replay)
      await peer.notify('session.output', {
        sessionId,
        stream: c.stream,
        seq: c.seq,
        data: c.data.toString('base64'),
      });
    if (s.exited) {
      await peer.notify('session.exit', {
        sessionId,
        code: s.exited.code,
        signal: s.exited.signal,
        seq: s.spool.nextSeq,
        at: s.exited.at,
      });
    }
    return {
      sessionId,
      seq: s.spool.nextSeq,
      replayedFrom: replay.length ? replay[0].seq : s.spool.nextSeq,
      replayed: replay.length,
      gap,
      truncated: replay.some((c) => c.truncated === true),
      exited: s.exited,
    };
  }

  /**
   * Resize a PTY session.
   * @param {string} sessionId @param {number} rows @param {number} cols
   */
  resize(sessionId, rows, cols) {
    const s = this.get(sessionId);
    if (!s.pty)
      throw new ProtocolError(Codes.UNSUPPORTED, 'session is not a pty session', { sessionId });
    if (s.exited)
      throw new ProtocolError(Codes.STATE, `session ${sessionId} has exited`, { sessionId });
    const size = resizePty(s.child, rows, cols);
    return { sessionId, ...size };
  }

  /** @param {string} sessionId @param {import('@workbox/protocol').Peer} peer */
  detach(sessionId, peer) {
    const s = this.get(sessionId);
    const had = s.subscribers.delete(peer);
    return { sessionId, detached: had };
  }

  /**
   * @param {string} sessionId
   * @param {{data?: string, eof?: boolean}} input base64 data
   */
  async input(sessionId, input) {
    const s = this.get(sessionId);
    if (s.exited)
      throw new ProtocolError(Codes.STATE, `session ${sessionId} has exited`, { sessionId });
    if (s.stdinClosed)
      throw new ProtocolError(Codes.STATE, `session ${sessionId} stdin is closed`, { sessionId });
    let bytes = 0;
    if (input.data) {
      const buf = Buffer.from(input.data, 'base64');
      bytes = buf.length;
      await new Promise((resolve, reject) => {
        s.child.stdin.write(buf, (e) =>
          e
            ? reject(new ProtocolError(Codes.UNAVAILABLE, `stdin write failed: ${e.message}`))
            : resolve(),
        );
      });
    }
    if (input.eof) {
      s.stdinClosed = true;
      s.child.stdin.end();
    }
    return { sessionId, bytes, eof: Boolean(input.eof) };
  }

  /**
   * Signal the session's process group.
   * @param {string} sessionId
   * @param {string} signal
   */
  signal(sessionId, signal) {
    const s = this.get(sessionId);
    if (s.exited)
      throw new ProtocolError(Codes.STATE, `session ${sessionId} has exited`, { sessionId });
    try {
      process.kill(-s.pid, signal);
    } catch (e) {
      if (e.code === 'ESRCH')
        throw new ProtocolError(Codes.STATE, `session ${sessionId} process group is gone`, {
          sessionId,
        });
      throw new ProtocolError(Codes.INVALID_PARAMS, `cannot send ${signal}: ${e.message}`, {
        signal,
      });
    }
    return { sessionId, signal };
  }

  /**
   * SIGTERM, then SIGKILL after the grace period; resolves with the exit.
   * @param {string} sessionId
   * @param {{graceMs?: number}} [opts]
   */
  async stop(sessionId, opts = {}) {
    const s = this.get(sessionId);
    if (s.exited) return { sessionId, exited: s.exited, escalated: false };
    const grace = opts.graceMs ?? this.stopGraceMs;
    const exited = new Promise((resolve) => {
      s.child.once('close', resolve);
    });
    this.signal(sessionId, 'SIGTERM');
    let escalated = false;
    const timer = setTimeout(() => {
      if (!s.exited) {
        escalated = true;
        try {
          process.kill(-s.pid, 'SIGKILL');
        } catch {
          // gone between check and kill
        }
      }
    }, grace);
    await exited;
    clearTimeout(timer);
    return { sessionId, exited: s.exited, escalated };
  }

  /** Forget an exited session and release its spool. @param {string} sessionId */
  remove(sessionId) {
    const s = this.get(sessionId);
    if (!s.exited)
      throw new ProtocolError(Codes.STATE, `session ${sessionId} is still running`, { sessionId });
    s.spool.clear();
    this.sessions.delete(sessionId);
    return { sessionId, removed: true };
  }

  /** Stop every live session. @param {{graceMs?: number}} [opts] */
  async stopAll(opts = {}) {
    const live = [...this.sessions.values()].filter((s) => !s.exited);
    await Promise.all(live.map((s) => this.stop(s.sessionId, opts)));
    return live.length;
  }

  get liveCount() {
    return [...this.sessions.values()].filter((s) => !s.exited).length;
  }
}
