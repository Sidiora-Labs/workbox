import path from 'node:path';
import { EventEmitter } from 'node:events';
import { E } from '../errors.js';
import { States, Health, isLive } from './state.js';
import { Supervisor } from './supervisor.js';
import { exec as execCommand } from './exec.js';
import {
  registerBrokerHandlers,
  issueLease,
  answerAskHost,
  checkpointRestore,
  notifyAsk,
  publicAsk,
} from '../broker/index.js';
import { secretRedactor } from '../secrets.js';
import { sandboxDirs } from '../host/launch.js';
import { SandboxNet } from '../host/netns.js';
import { normalizeAllowEntry } from '../host/proxy.js';
import { buildSeccompProgram } from '../host/seccomp.js';

/**
 * The fleet manager (task 1.6): owns every Supervisor, creates/destroys sandboxes, reconciles
 * after a daemon restart (rediscover from store + cgroup, reconnect, never relaunch implicitly),
 * and fans supervisor/runner events out to server/CLI consumers.
 *
 * Emits: 'sandbox' (row), 'health' ({sandboxId, health}), 'event' ({sandboxId, method, params}),
 * 'ask' (ask row).
 */
export class Manager extends EventEmitter {
  /**
   * @param {object} deps
   * @param {import('../config.js').Config} deps.config
   * @param {import('../store.js').Store} deps.store
   * @param {import('../host/cgroup.js').CgroupManager} deps.cgroups
   * @param {import('../host/rootfs.js').RootfsManager} deps.rootfs
   * @param {import('../host/runtime.js').RuntimeManager} deps.runtime
   * @param {import('../audit.js').Audit} [deps.audit]
   * @param {import('../log.js').Logger} [deps.logger]
   * @param {import('../secrets.js').SecretProvider} [deps.secrets]
   * @param {boolean} [deps.enableNetwork] install nft (every mode) and attach slirp + proxy (egress/allowlist)
   * @param {string[]} [deps.netResolver] DNS servers the sandbox proxies resolve with (default: system)
   * @param {string} [deps.proxyHost] IPv4 the sandbox proxies bind to on the host-only dummy link workbox0 (default 198.18.0.1)
   * @param {boolean} [deps.enableSeccomp] supply the seccomp program at launch (default true on x64)
   * @param {number} [deps.maxSandboxes] admission cap (0/absent = unlimited)
   * @param {Array<{name: string, deliver: (ask: object) => unknown}>} [deps.askChannels] ask notifiers
   * @param {(deps: object) => Supervisor} [deps.supervisorFactory] test seam
   */
  constructor(deps) {
    super();
    this.config = deps.config;
    this.store = deps.store;
    this.cgroups = deps.cgroups;
    this.rootfs = deps.rootfs;
    this.runtime = deps.runtime;
    this.audit = deps.audit ?? null;
    this.logger = deps.logger;
    this.secrets = deps.secrets ?? null;
    this.enableNetwork = deps.enableNetwork ?? true;
    this.netResolver = deps.netResolver;
    this.proxyHost = deps.proxyHost;
    this.enableSeccomp = deps.enableSeccomp ?? process.arch === 'x64';
    this.maxSandboxes = deps.maxSandboxes ?? 0;
    this.askChannels = deps.askChannels ?? [];
    if (this.audit && this.secrets)
      this.audit.redactor = secretRedactor(this.secrets, this.audit.redactor);
    this.supervisorFactory = deps.supervisorFactory ?? ((d) => new Supervisor(d));
    /** @type {Map<string, Supervisor>} */
    this.supervisors = new Map();
    /** @type {Map<string, SandboxNet>} */
    this.nets = new Map();
  }

  /** @param {object} sandbox store row */
  _makeSupervisor(sandbox) {
    let sup = this.supervisors.get(sandbox.id);
    if (sup) return sup;
    sup = this.supervisorFactory({
      config: this.config,
      store: this.store,
      cgroups: this.cgroups,
      rootfs: this.rootfs,
      runtime: this.runtime,
      audit: this.audit ?? undefined,
      logger: this.logger,
      sandbox,
      hooks: {
        beforeGo: (s) => this._beforeGo(s),
        afterStop: (s) => this._afterStop(s),
      },
    });
    sup.registerPeerHandlers?.((peer, s) => registerBrokerHandlers(peer, this.brokerContextFor(s)));
    sup.on('state', (row) => this.emit('sandbox', row));
    sup.on('health', (health) => this.emit('health', { sandboxId: sandbox.id, health }));
    sup.on('event', (method, params) => {
      this._trackSession(sandbox.id, method, params);
      this.emit('event', { sandboxId: sandbox.id, method, params });
    });
    this.supervisors.set(sandbox.id, sup);
    return sup;
  }

  _trackSession(sandboxId, method, params) {
    try {
      if (method === 'session.started' && params?.sessionId)
        this.store.upsertSession(sandboxId, params);
      if (method === 'session.exit' && params?.sessionId)
        this.store.sessionExited(sandboxId, params.sessionId, params);
    } catch {
      // session bookkeeping must never break the event fan-out
    }
  }

  async _beforeGo(sup) {
    const mode = sup.networkMode;
    if (this.enableSeccomp) {
      try {
        sup.seccompProgram = buildSeccompProgram();
      } catch {
        sup.seccompProgram = null;
      }
    }
    if (!this.enableNetwork) return { network: { mode } };
    const pid = sup.sandbox.pid;
    if (!pid) throw E.state(`sandbox ${sup.id} has no pid before go`, { sandboxId: sup.id });
    const sbNet = new SandboxNet({
      pid,
      sandboxId: sup.id,
      policy: this.networkPolicy(sup),
      audit: this.audit ?? undefined,
      resolver: this.netResolver,
      proxyHost: this.proxyHost,
    });
    this.nets.get(sup.id)?.stop();
    this.nets.set(sup.id, sbNet);
    try {
      const { env, proxy } = await sbNet.start();
      return { env, network: proxy ? { mode, proxy } : { mode } };
    } catch (e) {
      sbNet.stop();
      this.nets.delete(sup.id);
      throw e;
    }
  }

  /** Effective network policy of a supervised sandbox. @param {Supervisor} sup */
  networkPolicy(sup) {
    const net = sup.profile.network ?? {};
    return {
      mode: sup.networkMode,
      allow: net.allow ?? this.config.network.allow ?? [],
      ports: net.ports ?? [],
    };
  }

  async _afterStop(sup) {
    this.nets.get(sup.id)?.stop();
    this.nets.delete(sup.id);
  }

  /** Broker context bound to one sandbox. @param {Supervisor} sup */
  brokerContextFor(sup) {
    const dirs = sandboxDirs(this.config.paths.sandboxes, sup.id);
    const sandbox = this.store.getSandbox(sup.id) ?? sup.sandbox;
    return {
      store: this.store,
      audit: this.audit ?? undefined,
      sandboxId: sup.id,
      outboxDir: path.join(dirs.run, 'outbox'),
      inboxDir: path.join(dirs.run, 'inbox'),
      artifactsDir: this.config.paths.artifacts,
      checkpointsDir: this.config.paths.checkpoints,
      upperDir: dirs.upper,
      cgroupPath: sup.cgroupPath,
      uidRange: this.config.uid,
      secrets: this.secrets ?? undefined,
      limits: sup.limits,
      network: sandbox.profile?.network ?? this.config.network,
      netState: () => this.nets.get(sup.id) ?? null,
      leaseTtlMs: this.config.lease.ttlMs,
      usage: () => {
        try {
          return this.cgroups.exists(sup.cgroupPath) ? this.cgroups.stats(sup.cgroupPath) : {};
        } catch {
          return {};
        }
      },
      onAsk: (ask) => {
        this.emit('ask', ask);
        notifyAsk(
          { audit: this.audit ?? undefined, sandboxId: sup.id },
          this.askChannels,
          publicAsk(ask),
        );
      },
    };
  }

  /**
   * The sandbox an earlier create with the same idempotency key made, or null when there is none.
   * The store's contract returns the existing row for a key; the API surface is stricter: reusing
   * a key with a different profile is a conflict, never a silent substitution, and a replay
   * answers as the original did, so a create whose launch failed stays a failure and a client
   * retrying the original 503 never receives the quarantined row as a success.
   * @param {{idempotencyKey?: string}} input
   */
  _replay(input) {
    if (!input.idempotencyKey) return null;
    const existing = this.store.getSandboxByIdempotencyKey(input.idempotencyKey);
    if (!existing || existing.state === States.DELETED) return null;
    const want = sandboxInput(this.config, input);
    const same =
      existing.rootfs === want.rootfs &&
      existing.runtime === want.runtime &&
      JSON.stringify(existing.profile ?? {}) === JSON.stringify(want.profile ?? {});
    if (!same)
      throw E.conflict('idempotency key already used with a different sandbox profile', {
        idempotencyKey: input.idempotencyKey,
        existingId: existing.id,
      });
    if (existing.state === States.QUARANTINED && existing.readyAt === null)
      throw E.quarantined(`sandbox ${existing.id} failed to launch: ${existing.stateReason}`, {
        id: existing.id,
        idempotencyKey: input.idempotencyKey,
        stateReason: existing.stateReason,
      });
    return this.get(existing.id);
  }

  /**
   * Create and launch a sandbox.
   * @param {{name?: string, rootfs?: string, runtime?: string, profile?: object, labels?: object, idempotencyKey?: string, secretRefs?: string[], fromCheckpoint?: string}} [input]
   *   `fromCheckpoint` restores that checkpoint into the new sandbox's upper before launch.
   */
  async create(input = {}) {
    validateCreate(input);
    const replayed = this._replay(input);
    if (replayed) return replayed;
    if (this.maxSandboxes > 0) {
      const live = this.store
        .listSandboxes({ limit: 1000 })
        .items.filter((s) => isLive(s.state)).length;
      if (live >= this.maxSandboxes)
        throw E.limit(`sandbox capacity reached (${this.maxSandboxes})`, {
          max: this.maxSandboxes,
        });
    }
    const row = this.store.createSandbox(sandboxInput(this.config, input));
    if (input.secretRefs?.length) this.store.setSecretPolicy(row.id, input.secretRefs);
    else if (input.profile?.secretRefs?.length)
      this.store.setSecretPolicy(row.id, input.profile.secretRefs);
    issueLease({ store: this.store, sandboxId: row.id, leaseTtlMs: this.config.lease.ttlMs });
    const sup = this._makeSupervisor(row);
    if (input.fromCheckpoint)
      await checkpointRestore(
        this.brokerContextFor(sup),
        input.fromCheckpoint,
        sandboxDirs(this.config.paths.sandboxes, row.id).upper,
      );
    const ready = await sup.launch();
    this.audit?.append({
      actor: 'manager',
      action: 'sandbox.create',
      sandboxId: row.id,
      data: { name: row.name },
    });
    return ready;
  }

  /** @param {string} id */
  get(id) {
    return this.store.requireSandbox(id);
  }

  /** @param {string} id */
  inspect(id) {
    const s = this.get(id);
    return {
      id: s.id,
      name: s.name,
      desired: s.state,
      stateReason: s.stateReason,
      health: s.health,
      lastObservedAt: s.lastObservedAt,
      rootfs: s.rootfs,
      runtime: s.runtime,
      profile: s.profile,
      labels: s.labels,
      pid: s.pid,
      bootId: s.bootId,
      cgroup: s.cgroup,
      version: s.version,
      createdAt: s.createdAt,
      readyAt: s.readyAt,
      deletedAt: s.deletedAt,
    };
  }

  /**
   * Sessions of a sandbox. With a live control channel this is the runner's own list, recorded in
   * the store so a later restart still knows about them; without one it is the store's record.
   * @param {string} id
   * @returns {Promise<{source: 'runner'|'store', sessions: object[]}>}
   */
  async sessions(id) {
    const sup = this.supervisor(id);
    if (!sup.peer || sup.peer.closed)
      return { source: 'store', sessions: this.store.listSessions(id) };
    const { sessions } = await sup.request('session.list', {});
    for (const s of sessions) {
      this._trackSession(id, 'session.started', s);
      if (s.exited) this._trackSession(id, 'session.exit', { ...s.exited, sessionId: s.sessionId });
    }
    return { source: 'runner', sessions };
  }

  /** Recorded state transitions of a sandbox, oldest first. @param {string} id */
  transitions(id) {
    this.get(id);
    return this.store.listTransitions(id);
  }

  /** @param {{cursor?: string, limit?: number, includeDeleted?: boolean, states?: string[]}} [opts] */
  list(opts = {}) {
    return this.store.listSandboxes(opts);
  }

  /** @param {string} id @returns {Supervisor} */
  supervisor(id) {
    const sup = this.supervisors.get(id) ?? this._makeSupervisor(this.get(id));
    return sup;
  }

  /** @param {string} id @param {object} opts exec options */
  exec(id, opts) {
    return execCommand(this.supervisor(id), opts);
  }

  /** @param {string} id @param {string} method @param {object} [params] @param {object} [opts] */
  request(id, method, params, opts) {
    return this.supervisor(id).request(method, params, opts);
  }

  /** @param {string} id @param {string} [reason] */
  drain(id, reason) {
    return this.supervisor(id).drain(reason);
  }

  /** @param {string} id @param {{timeoutMs?: number, reason?: string}} [opts] */
  async destroy(id, opts = {}) {
    const sup = this.supervisor(id);
    try {
      return await sup.destroy(opts);
    } finally {
      this.nets.get(id)?.stop();
      this.nets.delete(id);
      if (this.store.getSandbox(id)?.state === States.DELETED) this.supervisors.delete(id);
    }
  }

  /**
   * Rediscover every non-DELETED sandbox from store + cgroup after a restart. Live sandboxes are
   * reattached; empty-cgroup sandboxes are observed ABSENT and never relaunched.
   * @returns {Promise<{attached: string[], absent: string[], suspect: string[], quarantined: string[]}>}
   */
  async reconcile() {
    const out = { attached: [], absent: [], suspect: [], quarantined: [] };
    const { items } = this.store.listSandboxes({ limit: 1000 });
    for (const row of items) {
      if (row.state === States.DELETED) continue;
      const sup = this._makeSupervisor(row);
      try {
        const health = await sup.attach();
        if (health === Health.HEALTHY) out.attached.push(row.id);
        else if (health === Health.ABSENT) out.absent.push(row.id);
        else out.suspect.push(row.id);
      } catch {
        out.quarantined.push(row.id);
      }
    }
    this.audit?.append({ actor: 'manager', action: 'reconcile', data: { ...out } });
    return out;
  }

  /** Answer an ask (host-only path). @param {string} askId @param {{answer: unknown, by?: string}} input */
  answerAsk(askId, input) {
    const ask = this.store.getAsk(askId);
    if (!ask) throw E.notFound(`ask ${askId} not found`, { askId });
    const ctx = this.brokerContextFor(this.supervisor(ask.sandboxId));
    const answered = answerAskHost(ctx, askId, input);
    const sup = this.supervisors.get(ask.sandboxId);
    sup?.peer?.notify?.('ask.answered', { askId, answer: input.answer }).catch(() => undefined);
    return answered;
  }

  /** Restore a checkpoint into a new or existing sandbox's upper. @param {string} sandboxId @param {string} checkpointId */
  async restoreCheckpoint(sandboxId, checkpointId) {
    const dirs = sandboxDirs(this.config.paths.sandboxes, sandboxId);
    const ctx = this.brokerContextFor(this.supervisor(sandboxId));
    return checkpointRestore(ctx, checkpointId, dirs.upper);
  }

  /** Proxy env of a running sandbox (exposed for CLI/server reporting). @param {string} id */
  networkEnv(id) {
    this.get(id);
    return { ...(this.nets.get(id)?.env ?? {}) };
  }

  /** Detach from every sandbox without touching them (daemon shutdown). */
  close() {
    for (const net of this.nets.values()) net.stop();
    this.nets.clear();
    for (const sup of this.supervisors.values()) sup.close();
    this.supervisors.clear();
  }
}

/** @param {import('../config.js').Config} config @param {object} input */
export function sandboxInput(config, input) {
  return {
    name: input.name,
    rootfs: input.rootfs ?? config.rootfs,
    runtime: input.runtime ?? config.runtime,
    profile: input.profile ?? {},
    labels: input.labels ?? {},
    idempotencyKey: input.idempotencyKey,
  };
}

/** Strict create-input validation (spec gap defaults, plan §4). @param {object} input */
export function validateCreate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw E.invalid('create input must be an object');
  const allowed = new Set([
    'name',
    'rootfs',
    'runtime',
    'profile',
    'labels',
    'idempotencyKey',
    'secretRefs',
    'fromCheckpoint',
  ]);
  for (const k of Object.keys(input))
    if (!allowed.has(k)) throw E.invalid(`unknown create field ${k}`, { field: k });
  if (input.fromCheckpoint !== undefined && typeof input.fromCheckpoint !== 'string')
    throw E.invalid('fromCheckpoint must be a checkpoint id', { field: 'fromCheckpoint' });
  if (
    input.name !== undefined &&
    (typeof input.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.name))
  )
    throw E.invalid('name must be a simple identifier', { field: 'name' });
  const net = input.profile?.network;
  if (net !== undefined) {
    if (!['none', 'egress', 'allowlist'].includes(net.mode))
      throw E.invalid('profile.network.mode is invalid', { field: 'profile.network.mode' });
    if (net.allow !== undefined && !validAllow(net.allow))
      throw E.invalid('profile.network.allow must be hostnames, *.domains or CIDRs', {
        field: 'profile.network.allow',
      });
    if (
      net.ports !== undefined &&
      (!Array.isArray(net.ports) ||
        net.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))
    )
      throw E.invalid('profile.network.ports must be ports in 1..65535', {
        field: 'profile.network.ports',
      });
  }
  return input;
}

function validAllow(allow) {
  if (!Array.isArray(allow)) return false;
  try {
    allow.forEach((h) => normalizeAllowEntry(h));
    return true;
  } catch {
    return false;
  }
}
