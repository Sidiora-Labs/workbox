import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Peer, PROTOCOL_VERSION } from '@workbox/protocol';
import { E, WorkboxError } from '../errors.js';
import { nullLogger } from '../log.js';
import { States, Health } from './state.js';
import { exec as execCommand } from './exec.js';
import { buildSeccompProgram } from '../host/seccomp.js';
import { NET_DEFAULTS } from '../host/netns.js';
import {
  sandboxDirs,
  ensureRootAccess,
  prepareDirs,
  writeBootFile,
  hashNonce,
  spawnSandbox,
  readHostToken,
  readLaunchLog,
  rotateLaunchLog,
  removeDirs,
  hostMountsFor,
  RUNNER_SOCKET,
  pidAlive,
  CAPABILITY_MASK,
} from '../host/launch.js';

export const DEFAULT_HEALTH_INTERVAL_MS = 2000;

/**
 * Compare the runner's self-checks with what the host demanded.
 * @param {object|null} checks the runner.go result's checks
 * @param {{uid: {base: number, count: number}}} expect
 * @returns {{ok: boolean, problems: string[]}}
 */
export function evaluateChecks(checks, expect) {
  if (!checks || typeof checks !== 'object')
    return { ok: false, problems: ['runner returned no checks'] };
  const problems = [
    ...(Array.isArray(checks.problems) ? checks.problems : []),
    ...capabilityProblems(checks),
    ...mapProblems(checks, expect.uid),
  ];
  if (checks.mountDenied !== true) problems.push('mount(2) not denied inside the sandbox');
  if (expect.seccomp && checks.seccomp !== 2)
    problems.push(`seccomp mode ${checks.seccomp} != 2 (filter)`);
  if (
    !expect.seccomp &&
    checks.seccomp !== undefined &&
    checks.seccomp !== null &&
    checks.seccomp !== 0 &&
    checks.seccomp !== 2
  )
    problems.push(`unexpected seccomp mode ${checks.seccomp}`);
  if (checks.pid !== 2) problems.push(`runner pid ${checks.pid} != 2`);
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

function capabilityProblems(checks) {
  const problems = [];
  if (checks.caps?.eff !== CAPABILITY_MASK)
    problems.push(`effective capabilities ${checks.caps?.eff} != ${CAPABILITY_MASK}`);
  if (checks.caps?.bnd !== CAPABILITY_MASK)
    problems.push(`bounding capabilities ${checks.caps?.bnd} != ${CAPABILITY_MASK}`);
  if (checks.noNewPrivs !== true) problems.push('no_new_privs not set');
  return problems;
}

function mapProblems(checks, uid) {
  const problems = [];
  for (const [key, label] of [
    ['uidMap', 'uid'],
    ['gidMap', 'gid'],
  ]) {
    const map = Array.isArray(checks[key]) ? checks[key] : [];
    const ok =
      map.length === 1 &&
      map[0].inner === 0 &&
      map[0].outer === uid.base &&
      map[0].count === uid.count;
    if (!ok) problems.push(`${label} map ${JSON.stringify(map)} != [0 ${uid.base} ${uid.count}]`);
  }
  return problems;
}

/**
 * Connect to a unix socket, retrying until the deadline. `alive()` lets the caller abort early
 * when the process behind the socket has died.
 * @param {string} socketPath
 * @param {{timeoutMs?: number, pollMs?: number, alive?: () => boolean}} [opts]
 * @returns {Promise<net.Socket>}
 */
export async function connectWithRetry(socketPath, opts = {}) {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  const poll = opts.pollMs ?? 50;
  let lastError = 'socket not created';
  for (;;) {
    if (fs.existsSync(socketPath)) {
      const socket = net.connect(socketPath);
      try {
        await once(socket, 'connect');
        return socket;
      } catch (e) {
        lastError = e.message;
        socket.destroy();
      }
    }
    if (opts.alive && !opts.alive())
      throw E.unavailable(`process exited before the runner socket accepted: ${lastError}`, {
        socketPath,
      });
    if (Date.now() >= deadline)
      throw E.timeout(
        `runner socket ${socketPath} not accepting after ${opts.timeoutMs ?? 20_000} ms: ${lastError}`,
        { socketPath },
      );
    await sleep(poll);
  }
}

/**
 * Host-side supervisor of one sandbox: launches the chain, performs the boot handshake, holds the
 * control channel, observes health and tears everything down.
 *
 * Emits: 'state' (row, {from, to, reason}), 'health' (health, {from, to, reason}) when health
 * changes, 'detached', 'event' (method, params) for runner events.
 */
export class Supervisor extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config.js').Config} deps.config
   * @param {import('../store.js').Store} deps.store
   * @param {import('../host/cgroup.js').CgroupManager} deps.cgroups
   * @param {import('../host/rootfs.js').RootfsManager} deps.rootfs
   * @param {import('../host/runtime.js').RuntimeManager} deps.runtime
   * @param {object} deps.sandbox the store row
   * @param {import('../log.js').Logger} [deps.logger]
   * @param {import('../audit.js').Audit} [deps.audit]
   * @param {{beforeGo?: (sup: Supervisor) => Promise<{env?: Record<string,string>, network?: object}|void>, afterStop?: (sup: Supervisor) => Promise<void>}} [deps.hooks]
   */
  constructor(deps) {
    super();
    this.config = deps.config;
    this.store = deps.store;
    this.cgroups = deps.cgroups;
    this.rootfs = deps.rootfs;
    this.runtime = deps.runtime;
    this.audit = deps.audit ?? null;
    this.hooks = deps.hooks ?? {};
    this.sandbox = deps.sandbox;
    this.log = (deps.logger ?? nullLogger()).child(`sandbox.${this.sandbox.id.slice(-6)}`);
    this.dirs = sandboxDirs(this.config.paths.sandboxes, this.sandbox.id);
    this.cgroupPath = this.cgroups.childPath(this.sandbox.id);
    /** @type {Peer|null} */
    this.peer = null;
    this.hello = null;
    this.checks = null;
    this.healthTimer = null;
    this.closed = false;
    this.hostToken = null;
    this.peerHandlers = null;
  }

  /**
   * Register handlers (e.g. broker methods) on every control peer, present and future.
   * @param {(peer: Peer, sup: Supervisor) => void} fn
   */
  registerPeerHandlers(fn) {
    this.peerHandlers = fn;
    if (this.peer) fn(this.peer, this);
  }

  /**
   * Run a command to completion in this sandbox.
   * @param {Parameters<typeof execCommand>[1]} opts
   */
  exec(opts) {
    return execCommand(this, opts);
  }

  get id() {
    return this.sandbox.id;
  }

  get socketPath() {
    return path.join(this.dirs.run, RUNNER_SOCKET);
  }

  get profile() {
    return this.sandbox.profile ?? {};
  }

  get limits() {
    return { ...this.config.limits, ...(this.profile.limits ?? {}) };
  }

  get networkMode() {
    return this.profile.network?.mode ?? this.config.network.mode;
  }

  _buildSeccomp() {
    if (this.seccompProgram !== undefined) return this.seccompProgram;
    if (process.arch !== 'x64') return null;
    try {
      return buildSeccompProgram();
    } catch {
      return null;
    }
  }

  /** Refresh the cached row from the store. */
  refresh() {
    this.sandbox = this.store.requireSandbox(this.id);
    return this.sandbox;
  }

  _transition(to, reason, patch) {
    const from = this.store.getSandbox(this.id)?.state ?? null;
    this.sandbox = this.store.transition(this.id, to, reason, patch ? { patch } : {});
    this.log.info('state', { to, reason });
    this.emit('state', this.sandbox, { from, to, reason: reason ?? null });
    return this.sandbox;
  }

  _observe(health, reason) {
    const from = this.sandbox.health;
    if (from !== health) {
      this.log.info('health', reason ? { health, reason } : { health });
      this.emit('health', health, { from, to: health, reason: reason ?? null });
    }
    this.sandbox = this.store.observe(this.id, health);
  }

  _audit(action, data) {
    if (this.audit) this.audit.append({ actor: 'supervisor', action, sandboxId: this.id, data });
  }

  /**
   * REQUESTED -> PROVISIONING -> BOOTSTRAPPING -> READY. A failure after the processes exist
   * quarantines the sandbox and stops its processes, keeping directories and launch.log.
   * @returns {Promise<object>} the READY row
   */
  async launch() {
    if (this.sandbox.state !== States.REQUESTED)
      throw E.state(`sandbox ${this.id} is ${this.sandbox.state}, cannot launch`, {
        state: this.sandbox.state,
      });
    const rootfsManifest = this.rootfs.require(this.sandbox.rootfs);
    const runtimeManifest = this.runtime.require(this.sandbox.runtime);
    const runtimeDir = this.runtime.dir(runtimeManifest.version);
    const rootfsDir = this.rootfs.dir(rootfsManifest.name);
    this._transition(States.PROVISIONING, 'launch', { cgroup: this.cgroupPath });
    try {
      this.cgroups.ensureParent();
      if (this.cgroups.exists(this.cgroupPath)) await this.cgroups.remove(this.cgroupPath);
      this.cgroups.create(this.id, this.limits);
      const hostname =
        this.sandbox.name && /^[A-Za-z0-9-]{1,63}$/.test(this.sandbox.name)
          ? this.sandbox.name
          : `wb-${this.id.slice(-8).toLowerCase()}`;
      ensureRootAccess(this.config.paths.root, this.config.uid.base);
      prepareDirs(this.dirs, {
        uidBase: this.config.uid.base,
        hostname,
        nameservers: this.networkMode === 'none' ? [] : [NET_DEFAULTS.dns],
        address: this.networkMode === 'none' ? undefined : NET_DEFAULTS.address,
      });
      const boot = writeBootFile(this.dirs, {
        sandboxId: this.id,
        uidBase: this.config.uid.base,
        runtimeVersion: runtimeManifest.version,
      });
      this.hostToken = boot.hostToken ?? null;
      this.seccompProgram = this._buildSeccomp();
      const { pid } = spawnSandbox({
        sandboxId: this.id,
        hostname,
        rootfsDir,
        runtimeDir,
        dirs: this.dirs,
        cgroupPath: this.cgroupPath,
        uid: this.config.uid,
        env: this.profile.env ?? {},
        seccompProgram: this.seccompProgram ?? undefined,
      });
      this.store.createBoot({
        bootId: boot.bootId,
        sandboxId: this.id,
        nonceHash: boot.nonceHash,
        pid,
      });
      this.sandbox = this.store.getSandbox(this.id);
      this.log.info('spawned', { pid, bootId: boot.bootId });
      this._audit('sandbox.launch', {
        pid,
        bootId: boot.bootId,
        rootfs: rootfsManifest.digest,
        runtime: runtimeManifest.version,
      });

      const socket = await connectWithRetry(this.socketPath, {
        timeoutMs: this.config.bootTimeoutMs,
        alive: () => pidAlive(pid),
      });
      this._attachPeer(socket);
      const hello = await this.peer.request(
        'runner.hello',
        { protocol: PROTOCOL_VERSION, role: 'host', hostToken: this.hostToken ?? undefined },
        { timeoutMs: 10_000 },
      );
      this.hello = hello;
      if (hello.bootId !== boot.bootId)
        throw E.quarantined(`runner reported boot ${hello.bootId}, expected ${boot.bootId}`, {
          expected: boot.bootId,
          actual: hello.bootId,
        });
      if (typeof hello.nonce !== 'string')
        throw E.quarantined('runner did not present its boot nonce on first contact', {
          bootId: hello.bootId,
        });
      const consumed = this.store.consumeNonce(boot.bootId, hashNonce(hello.nonce), {
        runnerVersion: hello.runnerVersion,
      });
      if (consumed !== 'consumed')
        throw E.quarantined(`boot nonce ${consumed}`, { bootId: boot.bootId, result: consumed });
      this._transition(States.BOOTSTRAPPING, 'runner hello', { bootId: boot.bootId });

      const extra = (await this.hooks.beforeGo?.(this)) ?? {};
      const go = await this.peer.request(
        'runner.go',
        { env: { ...(extra.env ?? {}) }, network: extra.network ?? { mode: this.networkMode } },
        { timeoutMs: 30_000 },
      );
      this.checks = go.checks;
      const verdict = evaluateChecks(go.checks, {
        uid: this.config.uid,
        seccomp: Boolean(this.seccompProgram),
      });
      if (!verdict.ok)
        throw E.quarantined(`sandbox self-checks failed: ${verdict.problems.join('; ')}`, {
          problems: verdict.problems,
        });
      this._transition(States.READY, 'runner ready');
      this._observe(Health.HEALTHY);
      this._audit('sandbox.ready', { bootId: boot.bootId, pid });
      this.startHealthPoll();
      return this.sandbox;
    } catch (e) {
      const err = WorkboxError.from(e);
      const log = readLaunchLog(this.dirs);
      this.log.error('launch failed', { err, launchLog: log.slice(-2000) });
      await this._quarantine(`launch failed: ${err.message}`, {
        code: err.code,
        launchLog: log.slice(-4000),
      });
      throw err;
    }
  }

  /**
   * Reattach to a running sandbox after a daemon restart. Returns the observed health.
   * @returns {Promise<string>}
   */
  async attach() {
    this.refresh();
    this.hostToken = this.hostToken ?? readHostToken(this.dirs);
    const procs = this.cgroups.exists(this.cgroupPath) ? this.cgroups.procs(this.cgroupPath) : [];
    if (procs.length === 0) {
      this._observe(Health.ABSENT);
      return Health.ABSENT;
    }
    try {
      const socket = await connectWithRetry(this.socketPath, {
        timeoutMs: 5000,
        alive: () => this.cgroups.procs(this.cgroupPath).length > 0,
      });
      this._attachPeer(socket);
      const hello = await this.peer.request(
        'runner.hello',
        { protocol: PROTOCOL_VERSION, role: 'host', hostToken: this.hostToken ?? undefined },
        { timeoutMs: 10_000 },
      );
      this.hello = hello;
      if (hello.bootId !== this.sandbox.bootId)
        throw E.quarantined(
          `runner boot ${hello.bootId} does not match record ${this.sandbox.bootId}`,
          { expected: this.sandbox.bootId, actual: hello.bootId },
        );
      if (hello.nonce !== null) {
        const consumed = this.store.consumeNonce(hello.bootId, hashNonce(hello.nonce));
        if (consumed !== 'consumed')
          throw E.quarantined(`boot nonce ${consumed} on reattach`, {
            bootId: hello.bootId,
            result: consumed,
          });
      }
      // The network died with the daemon that started it; a failure to restore it leaves the
      // sandbox SUSPECT rather than quarantined, since its rules still fail closed.
      let extra = {};
      try {
        extra = (await this.hooks.afterAttach?.(this)) ?? {};
      } catch (e) {
        this.log.warn('network not restored', { err: e });
      }
      if (hello.phase === 'boot' && this.sandbox.state === States.BOOTSTRAPPING) {
        const go = await this.peer.request(
          'runner.go',
          {
            env: { ...(extra.env ?? {}) },
            network: extra.network ?? { mode: this.networkMode },
          },
          { timeoutMs: 30_000 },
        );
        this.checks = go.checks;
        const verdict = evaluateChecks(go.checks, {
          uid: this.config.uid,
          seccomp: Boolean(this.seccompProgram),
        });
        if (!verdict.ok)
          throw E.quarantined(`sandbox self-checks failed: ${verdict.problems.join('; ')}`, {
            problems: verdict.problems,
          });
        this._transition(States.READY, 'runner ready after reattach');
      }
      const health = this.observeHealth();
      this._audit('sandbox.attach', { bootId: hello.bootId, phase: hello.phase, health });
      this.startHealthPoll();
      return health;
    } catch (e) {
      const err = WorkboxError.from(e);
      if (err.code === 'E_QUARANTINED') {
        await this._quarantine(err.message, err.data);
        throw err;
      }
      this.log.warn('attach failed', { err });
      this._observe(Health.SUSPECT);
      return Health.SUSPECT;
    }
  }

  /**
   * Forward a request to the runner over the control channel.
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   */
  request(method, params, opts) {
    if (!this.peer || this.peer.closed)
      throw E.unavailable(`sandbox ${this.id} has no control channel`, { id: this.id });
    return this.peer.request(method, params, opts);
  }

  /**
   * Current health from the cgroup, the control channel and the network the sandbox was given,
   * recorded in the store: HEALTHY needs all three; a live sandbox missing either of the others
   * is SUSPECT.
   */
  observeHealth() {
    const alive =
      this.cgroups.exists(this.cgroupPath) && this.cgroups.procs(this.cgroupPath).length > 0;
    let health = Health.ABSENT;
    let reason;
    if (alive && (!this.peer || this.peer.closed)) {
      health = Health.SUSPECT;
      reason = 'control channel closed';
    } else if (alive && !(this.hooks.networkAlive?.(this) ?? true)) {
      health = Health.SUSPECT;
      reason = 'network down';
    } else if (alive) health = Health.HEALTHY;
    this._observe(health, reason);
    return health;
  }

  /**
   * Poll health every `intervalMs`; each tick also keeps launch.log under its cap, which costs one
   * stat while the log is small, so a long-lived sandbox's log is bounded between launches.
   * @param {number} [intervalMs]
   */
  startHealthPoll(intervalMs = DEFAULT_HEALTH_INTERVAL_MS) {
    this.stopHealthPoll();
    this.healthTimer = setInterval(() => {
      try {
        this.observeHealth();
      } catch (e) {
        this.log.warn('health poll failed', { err: e });
      }
      try {
        if (rotateLaunchLog(this.dirs)) this.log.info('launch.log rotated', { log: this.dirs.log });
      } catch (e) {
        this.log.warn('launch.log rotation failed', { err: e });
      }
    }, intervalMs);
    this.healthTimer.unref();
  }

  stopHealthPoll() {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  /** Stop new work; processes keep running until destroy. */
  drain(reason = 'drain requested') {
    this._transition(States.DRAINING, reason);
    this._audit('sandbox.drain', { reason });
    return this.sandbox;
  }

  /**
   * Kill the cgroup, wait for it to empty, remove directories, record DELETED. A cgroup that will
   * not empty leaves the row in DELETING with the reason.
   * @param {{timeoutMs?: number, reason?: string}} [opts]
   */
  async destroy(opts = {}) {
    this.refresh();
    if (this.sandbox.state === States.DELETED) return this.sandbox;
    if (this.sandbox.state !== States.DELETING)
      this._transition(States.DELETING, opts.reason ?? 'destroy requested');
    this.stopHealthPoll();
    this.closePeer();
    try {
      await this.hooks.afterStop?.(this);
      if (this.cgroups.exists(this.cgroupPath))
        await this.cgroups.remove(this.cgroupPath, { timeoutMs: opts.timeoutMs ?? 15_000 });
      if (this.sandbox.bootId) this.store.endBoot(this.sandbox.bootId);
      removeDirs(this.dirs);
      const leaked = hostMountsFor(this.dirs);
      if (leaked.length)
        throw E.state(`host mounts still reference the sandbox: ${leaked.join(', ')}`, {
          mounts: leaked,
        });
      this._observe(Health.ABSENT);
      this._transition(States.DELETED, 'cgroup removed and directories deleted');
      this._audit('sandbox.destroy', { reason: opts.reason ?? 'destroy requested' });
      this.closed = true;
      return this.sandbox;
    } catch (e) {
      const err = WorkboxError.from(e);
      this.log.error('destroy incomplete', { err });
      this.sandbox = this.store.updateSandbox(this.id, {
        stateReason: `destroy incomplete: ${err.message}`,
      });
      throw err;
    }
  }

  /** Detach from the runner without affecting the sandbox (daemon shutdown). */
  close() {
    this.stopHealthPoll();
    this.closePeer();
    this.closed = true;
  }

  closePeer() {
    if (this.peer) {
      this.peer.removeAllListeners('close');
      this.peer.close();
      this.peer = null;
    }
  }

  _attachPeer(socket) {
    this.closePeer();
    this.peer = new Peer(socket, { name: `host->${this.id.slice(-6)}` });
    if (this.peerHandlers) this.peerHandlers(this.peer, this);
    this.peer.on('event', (method, params) => this.emit('event', method, params));
    this.peer.on('close', () => {
      this.log.warn('control channel closed');
      this.emit('detached');
      if (!this.closed && this.sandbox.state !== States.DELETED) {
        try {
          this.observeHealth();
        } catch {
          // store may be closed during shutdown
        }
      }
    });
  }

  async _quarantine(reason, data) {
    this.stopHealthPoll();
    this.closePeer();
    try {
      if (this.cgroups.exists(this.cgroupPath)) {
        this.cgroups.kill(this.cgroupPath);
        await this.cgroups.waitEmpty(this.cgroupPath, { timeoutMs: 5000 });
      }
    } catch (e) {
      this.log.warn('kill during quarantine failed', { err: e });
    }
    this.refresh();
    if (
      this.sandbox.state !== States.QUARANTINED &&
      this.sandbox.state !== States.DELETED &&
      this.sandbox.state !== States.DELETING
    ) {
      this._transition(States.QUARANTINED, reason);
    }
    this._observe(Health.SUSPECT);
    this._audit('sandbox.quarantine', { reason, ...(data ?? {}) });
  }
}
