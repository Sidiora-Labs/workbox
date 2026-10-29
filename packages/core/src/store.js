import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newId } from '@workbox/protocol';
import { E, WorkboxError } from './errors.js';
import { States, Health, assertTransition } from './sandbox/state.js';

export const SCHEMA_VERSION = 4;

const TOKEN_DIGEST = /^sha256:[0-9a-f]{64}$/;
const KEY_DIGEST = /^[0-9a-f]{64}$/;
const MAX_PAGE = 1000;

/** The shortest interval between two `last_used_at` writes of one API key. */
export const KEY_TOUCH_INTERVAL_MS = 60_000;

const MIGRATIONS = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sandboxes (
    id TEXT PRIMARY KEY,
    name TEXT,
    state TEXT NOT NULL,
    state_reason TEXT,
    health TEXT NOT NULL DEFAULT 'UNKNOWN',
    rootfs TEXT NOT NULL,
    runtime TEXT NOT NULL,
    profile TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '{}',
    idempotency_key TEXT UNIQUE,
    pid INTEGER,
    boot_id TEXT,
    cgroup TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    ready_at INTEGER,
    deleted_at INTEGER,
    last_observed_at INTEGER
  );
  CREATE INDEX sandboxes_state ON sandboxes(state, created_at);
  CREATE TABLE transitions (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
    from_state TEXT,
    to_state TEXT NOT NULL,
    reason TEXT,
    at INTEGER NOT NULL
  );
  CREATE INDEX transitions_sandbox ON transitions(sandbox_id, seq);
  CREATE TABLE boots (
    boot_id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
    nonce_hash TEXT NOT NULL,
    nonce_consumed_at INTEGER,
    pid INTEGER,
    runner_version TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX boots_sandbox ON boots(sandbox_id, started_at);
  CREATE TABLE sessions (
    sandbox_id TEXT NOT NULL REFERENCES sandboxes(id),
    session_id TEXT NOT NULL,
    name TEXT,
    argv TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    exited_at INTEGER,
    exit_code INTEGER,
    exit_signal TEXT,
    PRIMARY KEY (sandbox_id, session_id)
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    sandbox_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT,
    causation TEXT,
    source TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX events_sandbox ON events(sandbox_id, seq);
  CREATE TABLE artifacts (
    sha256 TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    content_type TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE artifact_refs (
    sandbox_id TEXT NOT NULL,
    sha256 TEXT NOT NULL REFERENCES artifacts(sha256),
    name TEXT NOT NULL DEFAULT '',
    kind TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sandbox_id, sha256, name)
  );
  CREATE TABLE evidence (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    envelope TEXT NOT NULL,
    log_sha256 TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX evidence_sandbox ON evidence(sandbox_id, created_at);
  CREATE TABLE leases (
    sandbox_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    generation INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    renewed_at INTEGER,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    options TEXT,
    recommended TEXT,
    ref TEXT,
    status TEXT NOT NULL,
    answer TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    answered_at INTEGER,
    answered_by TEXT
  );
  CREATE INDEX asks_sandbox ON asks(sandbox_id, status, created_at);
  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    sandbox_id TEXT NOT NULL,
    name TEXT,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    envelope TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE presets (
    sandbox_id TEXT NOT NULL,
    name TEXT NOT NULL,
    manifest TEXT NOT NULL,
    installed_at INTEGER NOT NULL,
    PRIMARY KEY (sandbox_id, name)
  );
  CREATE TABLE secret_policy (
    sandbox_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    PRIMARY KEY (sandbox_id, ref)
  );
  `,
  // v2: lease tokens are kept only as SHA-256 digests. Rows the broker already hashed keep their
  // value; plaintext rows written directly through the v1 store are replaced by their digest.
  (db) => {
    const update = db.prepare(`UPDATE leases SET token = ? WHERE sandbox_id = ?`);
    for (const r of db.prepare(`SELECT sandbox_id, token FROM leases`).all())
      if (!TOKEN_DIGEST.test(r.token)) update.run(leaseDigest(r.token), r.sandbox_id);
  },
  // v3: stored API keys. Only the SHA-256 hex digest of a token is kept.
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_sha256 TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL,
    binding TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER,
    last_used_at INTEGER,
    created_by TEXT
  );
  CREATE INDEX api_keys_created ON api_keys(created_at, id);
  `,
  // v4: webhooks and their deliveries. A delivery keeps a snapshot of its event, so pruning the
  // event log never breaks a retry.
  `
  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    types TEXT NOT NULL,
    sandbox_id TEXT,
    labels TEXT,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    owner_key TEXT,
    binding TEXT,
    last_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    disabled_reason TEXT
  );
  CREATE INDEX webhooks_created ON webhooks(created_at, id);
  CREATE TABLE webhook_deliveries (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_seq INTEGER,
    event TEXT NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER,
    last_status INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX webhook_deliveries_due ON webhook_deliveries(status, next_at);
  CREATE INDEX webhook_deliveries_webhook ON webhook_deliveries(webhook_id, id);
  CREATE UNIQUE INDEX webhook_deliveries_event ON webhook_deliveries(webhook_id, event_seq)
    WHERE event_seq IS NOT NULL;
  `,
];

const SANDBOX_COLS = `id, name, state, state_reason, health, rootfs, runtime, profile, labels, idempotency_key, pid, boot_id, cgroup, version, created_at, updated_at, ready_at, deleted_at, last_observed_at`;

/**
 * Durable state for the host: SQLite in WAL mode, every mutation in a transaction.
 * Row objects are camelCase with JSON columns parsed; a JSON column that does not parse is an
 * E_INTERNAL naming its table and row. Lease tokens are stored as SHA-256 digests and every
 * secret comparison is constant-time.
 */
export class Store {
  /**
   * Open (creating if needed), run `PRAGMA integrity_check` and migrate. A file that is not a
   * database or fails the check is refused with E_INTERNAL; a newer schema with E_STATE.
   * @param {string} dbPath file path, or ':memory:'
   * @param {{clock?: () => number}} [opts]
   */
  static open(dbPath, opts = {}) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
      // SQLite gives the -wal and -shm files the database file's mode, so 0600 here covers all three.
      fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`])
        if (fs.existsSync(f)) fs.chmodSync(f, 0o600);
    }
    let db;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA secure_delete = ON');
      checkIntegrity(db, dbPath);
      const store = new Store(db, dbPath, opts.clock ?? Date.now);
      store.migrate();
      return store;
    } catch (e) {
      db?.close();
      if (e instanceof WorkboxError) throw e;
      throw E.internal(`store ${dbPath} cannot be opened: ${e.message}`, { path: dbPath });
    }
  }

  /**
   * @param {DatabaseSync} db
   * @param {string} dbPath
   * @param {() => number} clock
   */
  constructor(db, dbPath, clock) {
    this.db = db;
    this.path = dbPath;
    this.clock = clock;
    this.depth = 0;
    /** @type {Map<string, number>} key id -> when this process last wrote its last_used_at */
    this.keyTouches = new Map();
  }

  close() {
    this.db.close();
  }

  /**
   * Apply pending migrations; safe to call repeatedly. After a migration the WAL is checkpointed,
   * so values a migration rewrote (with secure_delete on) are gone from the files on disk.
   * @param {number} [target] stop at this schema version (default and maximum SCHEMA_VERSION)
   */
  migrate(target = SCHEMA_VERSION) {
    const hasMeta = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`)
      .get();
    let current = 0;
    if (hasMeta) {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
      current = row ? Number(row.value) : 0;
    }
    if (current > SCHEMA_VERSION)
      throw E.state(`database schema ${current} is newer than supported ${SCHEMA_VERSION}`, {
        current,
        supported: SCHEMA_VERSION,
      });
    const last = Math.min(target, SCHEMA_VERSION);
    for (let v = current; v < last; v++) {
      const step = MIGRATIONS[v];
      this.tx(() => {
        if (typeof step === 'function') step(this.db);
        else this.db.exec(step);
        this.db
          .prepare(
            `INSERT INTO meta(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          )
          .run(String(v + 1));
      });
    }
    if (current < last && this.path !== ':memory:') this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  get schemaVersion() {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
    return row ? Number(row.value) : 0;
  }

  /**
   * Run fn inside a transaction. Nested calls join the outer transaction.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  tx(fn) {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  // ── sandboxes ──

  /**
   * @param {{id?: string, name?: string, rootfs: string, runtime: string, profile: object, labels?: object, idempotencyKey?: string}} input
   */
  createSandbox(input) {
    const now = this.clock();
    const id = input.id ?? newId(now);
    return this.tx(() => {
      if (input.idempotencyKey) {
        const existing = this.getSandboxByIdempotencyKey(input.idempotencyKey);
        if (existing) return existing;
      }
      this.db
        .prepare(
          `INSERT INTO sandboxes (id, name, state, health, rootfs, runtime, profile, labels, idempotency_key, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.name ?? null,
          States.REQUESTED,
          Health.UNKNOWN,
          input.rootfs,
          input.runtime,
          JSON.stringify(input.profile ?? {}),
          JSON.stringify(input.labels ?? {}),
          input.idempotencyKey ?? null,
          now,
          now,
        );
      this.db
        .prepare(
          `INSERT INTO transitions (sandbox_id, from_state, to_state, reason, at) VALUES (?, NULL, ?, 'created', ?)`,
        )
        .run(id, States.REQUESTED, now);
      return this.getSandbox(id);
    });
  }

  /** @param {string} id */
  getSandbox(id) {
    const row = this.db.prepare(`SELECT ${SANDBOX_COLS} FROM sandboxes WHERE id = ?`).get(id);
    return row ? sandboxRow(row) : null;
  }

  /** @param {string} id */
  requireSandbox(id) {
    const s = this.getSandbox(id);
    if (!s) throw E.notFound(`sandbox ${id} not found`, { id });
    return s;
  }

  /** @param {string} key */
  getSandboxByIdempotencyKey(key) {
    const row = this.db
      .prepare(`SELECT ${SANDBOX_COLS} FROM sandboxes WHERE idempotency_key = ?`)
      .get(key);
    return row ? sandboxRow(row) : null;
  }

  /**
   * Cursor pagination ordered by id (time-ordered). `complete` is true when no further page exists.
   * With `binding`, only the sandboxes it makes visible are listed, filtered in SQL so every page
   * is full.
   * @param {{states?: string[], includeDeleted?: boolean, cursor?: string|null, limit?: number, binding?: Binding|null}} [opts]
   */
  listSandboxes(opts = {}) {
    const limit = pageSize(opts.limit, 50);
    const clauses = [];
    const params = [];
    if (opts.states && opts.states.length) {
      clauses.push(`state IN (${opts.states.map(() => '?').join(',')})`);
      params.push(...opts.states);
    } else if (!opts.includeDeleted) {
      clauses.push(`state != 'DELETED'`);
    }
    if (opts.cursor) {
      clauses.push('id > ?');
      params.push(opts.cursor);
    }
    if (opts.binding) {
      const filter = bindingFilter(opts.binding);
      clauses.push(filter.sql);
      params.push(...filter.params);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${SANDBOX_COLS} FROM sandboxes ${where} ORDER BY id LIMIT ?`)
      .all(...params, limit + 1);
    const complete = rows.length <= limit;
    const items = rows.slice(0, limit).map(sandboxRow);
    return { items, cursor: complete ? null : items[items.length - 1].id, complete };
  }

  /**
   * Move a sandbox to a new state, recording the transition. Optimistic concurrency through
   * expectedVersion; extra column updates through patch.
   * @param {string} id
   * @param {string} to
   * @param {string} reason
   * @param {{expectedVersion?: number, patch?: object}} [opts]
   */
  transition(id, to, reason, opts = {}) {
    return this.tx(() => {
      const current = this.requireSandbox(id);
      if (opts.expectedVersion !== undefined && current.version !== opts.expectedVersion) {
        throw E.conflict(
          `sandbox ${id} is at version ${current.version}, expected ${opts.expectedVersion}`,
          { id, version: current.version, expected: opts.expectedVersion },
        );
      }
      assertTransition(current.state, to);
      const now = this.clock();
      const patch = { ...(opts.patch ?? {}), state: to, stateReason: reason ?? null };
      if (to === States.READY) patch.readyAt = now;
      if (to === States.DELETED) patch.deletedAt = now;
      this._updateSandbox(id, patch, now, true);
      this.db
        .prepare(
          `INSERT INTO transitions (sandbox_id, from_state, to_state, reason, at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, current.state, to, reason ?? null, now);
      return this.getSandbox(id);
    });
  }

  /**
   * Update mutable columns (pid, bootId, cgroup, health, name, labels, profile, lastObservedAt).
   * @param {string} id
   * @param {object} patch
   */
  updateSandbox(id, patch) {
    return this.tx(() => {
      this.requireSandbox(id);
      this._updateSandbox(id, patch, this.clock(), false);
      return this.getSandbox(id);
    });
  }

  /**
   * Record an observation of health.
   * @param {string} id
   * @param {string} health one of Health
   */
  observe(id, health) {
    if (!(health in Health)) throw E.invalid(`unknown health ${health}`, { health });
    return this.updateSandbox(id, { health, lastObservedAt: this.clock() });
  }

  /**
   * At most `limit` transitions (default and cap 1000) after `afterSeq`, oldest first.
   * @param {string} id @param {{afterSeq?: number, limit?: number}} [opts]
   */
  listTransitions(id, opts = {}) {
    return this.db
      .prepare(
        `SELECT seq, sandbox_id, from_state, to_state, reason, at FROM transitions WHERE sandbox_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(id, opts.afterSeq ?? 0, pageSize(opts.limit, MAX_PAGE))
      .map((r) => ({
        seq: r.seq,
        sandboxId: r.sandbox_id,
        from: r.from_state,
        to: r.to_state,
        reason: r.reason,
        at: r.at,
      }));
  }

  _updateSandbox(id, patch, now, bumpVersion) {
    const map = {
      state: 'state',
      stateReason: 'state_reason',
      health: 'health',
      name: 'name',
      pid: 'pid',
      bootId: 'boot_id',
      cgroup: 'cgroup',
      readyAt: 'ready_at',
      deletedAt: 'deleted_at',
      lastObservedAt: 'last_observed_at',
    };
    const sets = ['updated_at = ?'];
    const params = [now];
    for (const [k, val] of Object.entries(patch)) {
      if (k === 'labels' || k === 'profile') {
        sets.push(`${k} = ?`);
        params.push(JSON.stringify(val));
      } else if (map[k]) {
        sets.push(`${map[k]} = ?`);
        params.push(val ?? null);
      } else {
        throw E.invalid(`cannot update sandbox column ${k}`, { column: k });
      }
    }
    if (bumpVersion) sets.push('version = version + 1');
    params.push(id);
    this.db.prepare(`UPDATE sandboxes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }

  // ── boots ──

  /** @param {{bootId: string, sandboxId: string, nonceHash: string, pid?: number}} input */
  createBoot(input) {
    const now = this.clock();
    this.tx(() => {
      this.requireSandbox(input.sandboxId);
      this.db
        .prepare(
          `INSERT INTO boots (boot_id, sandbox_id, nonce_hash, pid, started_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(input.bootId, input.sandboxId, input.nonceHash, input.pid ?? null, now);
      this._updateSandbox(
        input.sandboxId,
        { bootId: input.bootId, pid: input.pid ?? null },
        now,
        false,
      );
    });
    return this.getBoot(input.bootId);
  }

  /** @param {string} bootId */
  getBoot(bootId) {
    const r = this.db
      .prepare(
        `SELECT boot_id, sandbox_id, nonce_hash, nonce_consumed_at, pid, runner_version, started_at, ended_at FROM boots WHERE boot_id = ?`,
      )
      .get(bootId);
    return r ? bootRow(r) : null;
  }

  /**
   * Consume the single-use boot nonce.
   * @param {string} bootId
   * @param {string} nonceHash
   * @param {{runnerVersion?: string}} [info]
   * @returns {'consumed'|'already'|'mismatch'|'missing'}
   */
  consumeNonce(bootId, nonceHash, info = {}) {
    return this.tx(() => {
      const boot = this.getBoot(bootId);
      if (!boot) return 'missing';
      if (!safeEqual(boot.nonceHash, nonceHash)) return 'mismatch';
      if (boot.nonceConsumedAt !== null) return 'already';
      this.db
        .prepare(`UPDATE boots SET nonce_consumed_at = ?, runner_version = ? WHERE boot_id = ?`)
        .run(this.clock(), info.runnerVersion ?? null, bootId);
      return 'consumed';
    });
  }

  /** @param {string} bootId */
  endBoot(bootId) {
    this.db
      .prepare(`UPDATE boots SET ended_at = ? WHERE boot_id = ? AND ended_at IS NULL`)
      .run(this.clock(), bootId);
    return this.getBoot(bootId);
  }

  // ── sessions ──

  /** @param {string} sandboxId @param {{sessionId: string, name?: string, argv: string[], startedAt?: number}} s */
  upsertSession(sandboxId, s) {
    this.db
      .prepare(
        `INSERT INTO sessions (sandbox_id, session_id, name, argv, started_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(sandbox_id, session_id) DO UPDATE SET name = excluded.name, argv = excluded.argv`,
      )
      .run(
        sandboxId,
        s.sessionId,
        s.name ?? null,
        JSON.stringify(s.argv),
        s.startedAt ?? this.clock(),
      );
  }

  /** @param {string} sandboxId @param {string} sessionId @param {{code: number|null, signal: string|null, at?: number}} exit */
  sessionExited(sandboxId, sessionId, exit) {
    this.db
      .prepare(
        `UPDATE sessions SET exited_at = ?, exit_code = ?, exit_signal = ? WHERE sandbox_id = ? AND session_id = ?`,
      )
      .run(exit.at ?? this.clock(), exit.code, exit.signal, sandboxId, sessionId);
  }

  /**
   * At most `limit` sessions (default and cap 1000) in start order, after session `after`.
   * @param {string} sandboxId @param {{after?: string, limit?: number}} [opts]
   */
  listSessions(sandboxId, opts = {}) {
    const params = [sandboxId];
    let where = 'sandbox_id = ?';
    if (opts.after) {
      where += ` AND (started_at, session_id) > (SELECT started_at, session_id FROM sessions WHERE sandbox_id = ? AND session_id = ?)`;
      params.push(sandboxId, opts.after);
    }
    return this.db
      .prepare(
        `SELECT session_id, name, argv, started_at, exited_at, exit_code, exit_signal FROM sessions WHERE ${where} ORDER BY started_at, session_id LIMIT ?`,
      )
      .all(...params, pageSize(opts.limit, MAX_PAGE))
      .map((r) => ({
        sessionId: r.session_id,
        name: r.name,
        argv: parseColumn(r.argv, 'sessions', `${sandboxId}/${r.session_id}`, 'argv'),
        startedAt: r.started_at,
        exitedAt: r.exited_at,
        exitCode: r.exit_code,
        exitSignal: r.exit_signal,
      }));
  }

  // ── events ──

  /**
   * @param {string} sandboxId
   * @param {string} type
   * @param {object} [payload]
   * @param {{causation?: string, source?: string}} [opts]
   * @returns {number} the event sequence number
   */
  appendEvent(sandboxId, type, payload, opts = {}) {
    const r = this.db
      .prepare(
        `INSERT INTO events (sandbox_id, type, payload, causation, source, at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sandboxId,
        type,
        payload === undefined ? null : JSON.stringify(payload),
        opts.causation ?? null,
        opts.source ?? 'host',
        this.clock(),
      );
    return Number(r.lastInsertRowid);
  }

  /** One event by sequence number, or null. @param {number} seq */
  getEvent(seq) {
    const r = this.db.prepare(`SELECT ${EVENT_COLS} FROM events WHERE seq = ?`).get(seq);
    return r ? eventRow(r) : null;
  }

  /** @param {string} sandboxId @param {{afterSeq?: number, limit?: number}} [opts] */
  listEvents(sandboxId, opts = {}) {
    return this.db
      .prepare(
        `SELECT ${EVENT_COLS} FROM events WHERE sandbox_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(sandboxId, opts.afterSeq ?? 0, pageSize(opts.limit, 100))
      .map(eventRow);
  }

  /**
   * Events of every sandbox in `seq` order: at most `limit` (default 100, cap 1000) after
   * `afterSeq`. `types` holds exact types and `prefix.*` patterns, which match every type that
   * starts with `prefix.`; an absent or empty list matches every type.
   * @param {{afterSeq?: number, limit?: number, types?: string[], sandboxId?: string}} [opts]
   */
  listFleetEvents(opts = {}) {
    const clauses = ['seq > ?'];
    const params = [opts.afterSeq ?? 0];
    if (opts.sandboxId !== undefined) {
      clauses.push('sandbox_id = ?');
      params.push(opts.sandboxId);
    }
    const types = typeFilter(opts.types);
    if (types) {
      clauses.push(types.sql);
      params.push(...types.params);
    }
    return this.db
      .prepare(
        `SELECT ${EVENT_COLS} FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?`,
      )
      .all(...params, pageSize(opts.limit, 100))
      .map(eventRow);
  }

  /** Delete events recorded before `beforeAt` (ms). @param {number} beforeAt @returns {number} rows deleted */
  pruneEvents(beforeAt) {
    if (!Number.isFinite(beforeAt))
      throw E.invalid('beforeAt must be a time in milliseconds', { beforeAt });
    return Number(this.db.prepare(`DELETE FROM events WHERE at < ?`).run(beforeAt).changes);
  }

  // ── artifacts and evidence ──

  /** Idempotent by digest. @param {{sha256: string, size: number, contentType?: string}} a */
  putArtifact(a) {
    this.db
      .prepare(
        `INSERT INTO artifacts (sha256, size, content_type, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
      )
      .run(a.sha256, a.size, a.contentType ?? null, this.clock());
    return this.getArtifact(a.sha256);
  }

  /** @param {string} sha256 */
  getArtifact(sha256) {
    const r = this.db
      .prepare(`SELECT sha256, size, content_type, created_at FROM artifacts WHERE sha256 = ?`)
      .get(sha256);
    return r
      ? { sha256: r.sha256, size: r.size, contentType: r.content_type, createdAt: r.created_at }
      : null;
  }

  /** @param {string} sandboxId @param {string} sha256 @param {{name?: string, kind?: string}} [ref] */
  refArtifact(sandboxId, sha256, ref = {}) {
    if (!this.getArtifact(sha256)) throw E.notFound(`artifact ${sha256} not found`, { sha256 });
    this.db
      .prepare(
        `INSERT INTO artifact_refs (sandbox_id, sha256, name, kind, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(sandboxId, sha256, ref.name ?? '', ref.kind ?? null, this.clock());
  }

  /** Whether a sandbox references an artifact. @param {string} sandboxId @param {string} sha256 */
  hasArtifactRef(sandboxId, sha256) {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM artifact_refs WHERE sandbox_id = ? AND sha256 = ? LIMIT 1`)
        .get(sandboxId, sha256),
    );
  }

  /** @param {string} sandboxId @param {{limit?: number, cursor?: string|null}} [opts] */
  listArtifacts(sandboxId, opts = {}) {
    const limit = pageSize(opts.limit, 50);
    const params = [sandboxId];
    let where = 'r.sandbox_id = ?';
    if (opts.cursor) {
      where += ' AND (r.created_at || r.sha256 || r.name) > ?';
      params.push(opts.cursor);
    }
    const rows = this.db
      .prepare(
        `SELECT r.sha256, r.name, r.kind, r.created_at, a.size, a.content_type FROM artifact_refs r JOIN artifacts a ON a.sha256 = r.sha256 WHERE ${where} ORDER BY r.created_at, r.sha256, r.name LIMIT ?`,
      )
      .all(...params, limit + 1);
    const complete = rows.length <= limit;
    const items = rows.slice(0, limit).map((r) => ({
      sha256: r.sha256,
      name: r.name,
      kind: r.kind,
      size: r.size,
      contentType: r.content_type,
      createdAt: r.created_at,
    }));
    const last = items[items.length - 1];
    return {
      items,
      cursor: complete ? null : `${last.createdAt}${last.sha256}${last.name}`,
      complete,
    };
  }

  /** @param {{id?: string, sandboxId: string, envelope: object, logSha256?: string}} e */
  recordEvidence(e) {
    const id = e.id ?? newId(this.clock());
    this.db
      .prepare(
        `INSERT INTO evidence (id, sandbox_id, envelope, log_sha256, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, e.sandboxId, JSON.stringify(e.envelope), e.logSha256 ?? null, this.clock());
    return this.getEvidence(id);
  }

  /** @param {string} id */
  getEvidence(id) {
    const r = this.db
      .prepare(`SELECT id, sandbox_id, envelope, log_sha256, created_at FROM evidence WHERE id = ?`)
      .get(id);
    return r ? evidenceRow(r) : null;
  }

  /** @param {string} sandboxId @param {{limit?: number, cursor?: string|null}} [opts] */
  listEvidence(sandboxId, opts = {}) {
    const limit = pageSize(opts.limit, 50);
    const params = [sandboxId];
    let where = 'sandbox_id = ?';
    if (opts.cursor) {
      where += ' AND id > ?';
      params.push(opts.cursor);
    }
    const rows = this.db
      .prepare(
        `SELECT id, sandbox_id, envelope, log_sha256, created_at FROM evidence WHERE ${where} ORDER BY id LIMIT ?`,
      )
      .all(...params, limit + 1);
    const complete = rows.length <= limit;
    const items = rows.slice(0, limit).map(evidenceRow);
    return { items, cursor: complete ? null : items[items.length - 1].id, complete };
  }

  // ── leases ──

  /**
   * Issue or re-issue the lease. The plaintext token is stored only as its `sha256:` digest.
   * @param {string} sandboxId @param {{token: string, ttlMs: number}} l
   */
  issueLease(sandboxId, l) {
    return this.tx(() => {
      const now = this.clock();
      const prev = this.getLease(sandboxId);
      const generation = prev ? prev.generation + 1 : 1;
      this.db
        .prepare(
          `INSERT INTO leases (sandbox_id, token, generation, issued_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, NULL, ?)
           ON CONFLICT(sandbox_id) DO UPDATE SET token = excluded.token, generation = excluded.generation, issued_at = excluded.issued_at, renewed_at = NULL, expires_at = excluded.expires_at`,
        )
        .run(sandboxId, leaseDigest(l.token), generation, now, now + l.ttlMs);
      return this.getLease(sandboxId);
    });
  }

  /** @param {string} sandboxId */
  getLease(sandboxId) {
    const r = this.db
      .prepare(
        `SELECT sandbox_id, token, generation, issued_at, renewed_at, expires_at FROM leases WHERE sandbox_id = ?`,
      )
      .get(sandboxId);
    return r
      ? {
          sandboxId: r.sandbox_id,
          token: r.token,
          generation: r.generation,
          issuedAt: r.issued_at,
          renewedAt: r.renewed_at,
          expiresAt: r.expires_at,
        }
      : null;
  }

  /**
   * Renew when the presented plaintext token hashes to the stored digest (compared in constant
   * time) and the lease has not expired. Only the plaintext is accepted: the stored digest itself,
   * as anyone who can read the database sees it, is refused with the same E_DENIED as any wrong
   * token.
   * @param {string} sandboxId
   * @param {string} token the plaintext returned at issue
   * @param {number} ttlMs
   */
  renewLease(sandboxId, token, ttlMs) {
    return this.tx(() => {
      const lease = this.getLease(sandboxId);
      if (!lease) throw E.notFound(`sandbox ${sandboxId} has no lease`, { sandboxId });
      if (typeof token !== 'string' || !safeEqual(lease.token, leaseDigest(token)))
        throw E.denied('lease token mismatch', { sandboxId, generation: lease.generation });
      return this._extendLease(lease, ttlMs);
    });
  }

  /**
   * Renew for the sandbox itself, which its own broker channel authenticates (wb never holds the
   * token). No credential is taken, so nothing read from the database can be presented here.
   * @param {string} sandboxId
   * @param {number} ttlMs
   */
  extendLease(sandboxId, ttlMs) {
    return this.tx(() => {
      const lease = this.getLease(sandboxId);
      if (!lease) throw E.notFound(`sandbox ${sandboxId} has no lease`, { sandboxId });
      return this._extendLease(lease, ttlMs);
    });
  }

  /** @param {{sandboxId: string, expiresAt: number}} lease @param {number} ttlMs */
  _extendLease(lease, ttlMs) {
    const now = this.clock();
    if (lease.expiresAt <= now)
      throw E.state('lease expired', {
        sandboxId: lease.sandboxId,
        expiresAt: lease.expiresAt,
        now,
      });
    this.db
      .prepare(`UPDATE leases SET renewed_at = ?, expires_at = ? WHERE sandbox_id = ?`)
      .run(now, now + ttlMs, lease.sandboxId);
    return this.getLease(lease.sandboxId);
  }

  // ── asks ──

  /** @param {{id?: string, sandboxId: string, kind: string, title: string, body?: string, options?: string[], recommended?: string, ref?: string, timeoutMs?: number}} a */
  createAsk(a) {
    const now = this.clock();
    const id = a.id ?? newId(now);
    this.db
      .prepare(
        `INSERT INTO asks (id, sandbox_id, kind, title, body, options, recommended, ref, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
      .run(
        id,
        a.sandboxId,
        a.kind,
        a.title,
        a.body ?? null,
        a.options ? JSON.stringify(a.options) : null,
        a.recommended ?? null,
        a.ref ?? null,
        now,
        a.timeoutMs ? now + a.timeoutMs : null,
      );
    return this.getAsk(id);
  }

  /** @param {string} id */
  getAsk(id) {
    const r = this.db.prepare(`SELECT * FROM asks WHERE id = ?`).get(id);
    return r ? askRow(r) : null;
  }

  /**
   * At most `limit` asks (default 100, cap 1000) in creation order, after ask `after`. With
   * `binding`, only asks of the sandboxes it makes visible.
   * @param {{sandboxId?: string, status?: 'open'|'answered'|'expired'|'all', after?: string, limit?: number, binding?: Binding|null}} [opts]
   */
  listAsks(opts = {}) {
    const clauses = [];
    const params = [];
    if (opts.sandboxId) {
      clauses.push('sandbox_id = ?');
      params.push(opts.sandboxId);
    }
    if (opts.binding) {
      const filter = bindingFilter(opts.binding, { sandboxColumn: 'sandbox_id' });
      clauses.push(filter.sql);
      params.push(...filter.params);
    }
    if (opts.status && opts.status !== 'all') {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.after) {
      clauses.push('(created_at, id) > (SELECT created_at, id FROM asks WHERE id = ?)');
      params.push(opts.after);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT * FROM asks ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...params, pageSize(opts.limit, 100))
      .map(askRow);
  }

  /** @param {string} id @param {{answer: unknown, by?: string}} input */
  answerAsk(id, input) {
    return this.tx(() => {
      const ask = this.getAsk(id);
      if (!ask) throw E.notFound(`ask ${id} not found`, { id });
      if (ask.status !== 'open')
        throw E.state(`ask ${id} is ${ask.status}`, { id, status: ask.status });
      this.db
        .prepare(
          `UPDATE asks SET status = 'answered', answer = ?, answered_at = ?, answered_by = ? WHERE id = ?`,
        )
        .run(JSON.stringify(input.answer), this.clock(), input.by ?? null, id);
      return this.getAsk(id);
    });
  }

  /** Mark open asks past their deadline as expired. @returns {number} count */
  expireAsks() {
    const r = this.db
      .prepare(
        `UPDATE asks SET status = 'expired' WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(this.clock());
    return Number(r.changes);
  }

  // ── checkpoints, presets, secret policy ──

  /** @param {{id?: string, sandboxId: string, name?: string, sha256: string, size: number, envelope: object}} c */
  addCheckpoint(c) {
    const now = this.clock();
    const id = c.id ?? newId(now);
    this.db
      .prepare(
        `INSERT INTO checkpoints (id, sandbox_id, name, sha256, size, envelope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.sandboxId, c.name ?? null, c.sha256, c.size, JSON.stringify(c.envelope), now);
    return this.getCheckpoint(id);
  }

  /** @param {string} id */
  getCheckpoint(id) {
    const r = this.db.prepare(`SELECT * FROM checkpoints WHERE id = ?`).get(id);
    return r ? checkpointRow(r) : null;
  }

  /**
   * At most `limit` checkpoints (default and cap 1000) in creation order, after checkpoint `after`.
   * @param {string} sandboxId @param {{after?: string, limit?: number}} [opts]
   */
  listCheckpoints(sandboxId, opts = {}) {
    const params = [sandboxId];
    let where = 'sandbox_id = ?';
    if (opts.after) {
      where += ' AND (created_at, id) > (SELECT created_at, id FROM checkpoints WHERE id = ?)';
      params.push(opts.after);
    }
    return this.db
      .prepare(`SELECT * FROM checkpoints WHERE ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...params, pageSize(opts.limit, MAX_PAGE))
      .map(checkpointRow);
  }

  /** @param {string} sandboxId @param {string} name @param {object} manifest */
  upsertPreset(sandboxId, name, manifest) {
    this.db
      .prepare(
        `INSERT INTO presets (sandbox_id, name, manifest, installed_at) VALUES (?, ?, ?, ?) ON CONFLICT(sandbox_id, name) DO UPDATE SET manifest = excluded.manifest, installed_at = excluded.installed_at`,
      )
      .run(sandboxId, name, JSON.stringify(manifest), this.clock());
  }

  /**
   * At most `limit` presets (default and cap 1000) by name, after preset `after`.
   * @param {string} sandboxId @param {{after?: string, limit?: number}} [opts]
   */
  listPresets(sandboxId, opts = {}) {
    return this.db
      .prepare(
        `SELECT name, manifest, installed_at FROM presets WHERE sandbox_id = ? AND name > ? ORDER BY name LIMIT ?`,
      )
      .all(sandboxId, opts.after ?? '', pageSize(opts.limit, MAX_PAGE))
      .map((r) => ({
        name: r.name,
        manifest: parseColumn(r.manifest, 'presets', `${sandboxId}/${r.name}`, 'manifest'),
        installedAt: r.installed_at,
      }));
  }

  /** Replace the set of secret references a sandbox may resolve. @param {string} sandboxId @param {string[]} refs */
  setSecretPolicy(sandboxId, refs) {
    this.tx(() => {
      this.db.prepare(`DELETE FROM secret_policy WHERE sandbox_id = ?`).run(sandboxId);
      const ins = this.db.prepare(`INSERT INTO secret_policy (sandbox_id, ref) VALUES (?, ?)`);
      for (const ref of new Set(refs)) ins.run(sandboxId, ref);
    });
  }

  /** @param {string} sandboxId @returns {string[]} */
  getSecretPolicy(sandboxId) {
    return this.db
      .prepare(`SELECT ref FROM secret_policy WHERE sandbox_id = ? ORDER BY ref`)
      .all(sandboxId)
      .map((r) => r.ref);
  }

  // ── api keys ──

  /**
   * Store an API key. Only the token's SHA-256 hex digest is kept; an id or digest already stored
   * is an E_CONFLICT. The returned row never carries the digest.
   * `ttlMs` sets the expiry relative to the stored `createdAt`; otherwise `expiresAt` is used.
   * @param {{id?: string, name: string, tokenSha256: string, scopes: string[], binding?: Binding|null, ttlMs?: number, expiresAt?: number|null, createdBy?: string|null}} k
   * @returns {ApiKeyRow}
   */
  createApiKey(k) {
    if (typeof k.tokenSha256 !== 'string' || !KEY_DIGEST.test(k.tokenSha256))
      throw E.invalid('tokenSha256 must be a SHA-256 hex digest', { field: 'tokenSha256' });
    const now = this.clock();
    const id = k.id ?? `key_${newId(now)}`;
    return this.tx(() => {
      const taken = this.db
        .prepare(`SELECT id FROM api_keys WHERE id = ? OR token_sha256 = ?`)
        .get(id, k.tokenSha256);
      if (taken) throw E.conflict('an API key with this id or token already exists', { id });
      this.db
        .prepare(
          `INSERT INTO api_keys (id, name, token_sha256, scopes, binding, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          k.name,
          k.tokenSha256,
          JSON.stringify(k.scopes),
          k.binding ? JSON.stringify(k.binding) : null,
          now,
          k.ttlMs ? now + k.ttlMs : (k.expiresAt ?? null),
          k.createdBy ?? null,
        );
      return this.getApiKey(id);
    });
  }

  /** @param {string} id @returns {ApiKeyRow|null} */
  getApiKey(id) {
    const r = this.db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE id = ?`).get(id);
    return r ? apiKeyRow(r) : null;
  }

  /**
   * The key whose token hashes to `digest`, revoked and expired ones included.
   * @param {string} digest SHA-256 hex of the token
   * @returns {ApiKeyRow|null}
   */
  getApiKeyByDigest(digest) {
    const r = this.db
      .prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE token_sha256 = ?`)
      .get(String(digest));
    return r ? apiKeyRow(r) : null;
  }

  /**
   * At most `limit` keys (default and cap 1000) in creation order, after key `after`.
   * @param {{after?: string, limit?: number}} [opts]
   * @returns {ApiKeyRow[]}
   */
  listApiKeys(opts = {}) {
    const params = [];
    let where = '';
    if (opts.after) {
      where = 'WHERE (created_at, id) > (SELECT created_at, id FROM api_keys WHERE id = ?)';
      params.push(opts.after);
    }
    return this.db
      .prepare(`SELECT ${KEY_COLS} FROM api_keys ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...params, pageSize(opts.limit, MAX_PAGE))
      .map(apiKeyRow);
  }

  /**
   * Revoke a key; it stops authenticating at once. Revoking a revoked key keeps the first
   * revocation time. An unknown id is E_NOT_FOUND.
   * @param {string} id
   * @returns {ApiKeyRow}
   */
  revokeApiKey(id) {
    return this.tx(() => {
      if (!this.getApiKey(id)) throw E.notFound(`key ${id} not found`, { id });
      this.db
        .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
        .run(this.clock(), id);
      return this.getApiKey(id);
    });
  }

  /**
   * Record that a key was used. Writes at most once per `minIntervalMs` per key, within this
   * process and across processes sharing the database.
   * @param {string} id
   * @param {number} [minIntervalMs] default KEY_TOUCH_INTERVAL_MS
   * @returns {boolean} true when last_used_at was written
   */
  touchApiKey(id, minIntervalMs = KEY_TOUCH_INTERVAL_MS) {
    const now = this.clock();
    const last = this.keyTouches.get(id);
    if (last !== undefined && now - last < minIntervalMs) return false;
    this.keyTouches.set(id, now);
    const r = this.db
      .prepare(
        `UPDATE api_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
      )
      .run(now, id, now - minIntervalMs);
    return Number(r.changes) > 0;
  }

  // ── webhooks ──

  /**
   * Store a webhook. Its cursor starts at the newest logged event, so it receives only events
   * logged after it. The secret is kept for signing and is never part of a returned row.
   * @param {{url: string, secret: string, types?: string[], sandboxId?: string|null, labels?: Record<string, string>|null, description?: string|null, ownerKey?: string|null, binding?: Binding|null}} w
   * @returns {WebhookRow}
   */
  createWebhook(w) {
    if (typeof w.url !== 'string' || w.url === '')
      throw E.invalid('url is required', { field: 'url' });
    if (typeof w.secret !== 'string' || w.secret === '')
      throw E.invalid('secret is required', { field: 'secret' });
    typeFilter(w.types);
    const now = this.clock();
    const id = `wh_${newId(now)}`;
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO webhooks (id, url, secret, types, sandbox_id, labels, description, enabled, owner_key, binding, last_seq, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, (SELECT COALESCE(MAX(seq), 0) FROM events), ?, ?)`,
        )
        .run(
          id,
          w.url,
          w.secret,
          JSON.stringify(w.types ?? []),
          w.sandboxId ?? null,
          w.labels && Object.keys(w.labels).length ? JSON.stringify(w.labels) : null,
          w.description ?? null,
          w.ownerKey ?? null,
          w.binding ? JSON.stringify(w.binding) : null,
          now,
          now,
        );
      return this.getWebhook(id);
    });
  }

  /** @param {string} id @returns {WebhookRow|null} */
  getWebhook(id) {
    const r = this.db.prepare(`SELECT ${WEBHOOK_COLS} FROM webhooks WHERE id = ?`).get(id);
    return r ? webhookRow(r) : null;
  }

  /** The signing secret of a webhook, or null when there is no such webhook. @param {string} id */
  getWebhookSecret(id) {
    const r = this.db.prepare(`SELECT secret FROM webhooks WHERE id = ?`).get(id);
    return r ? r.secret : null;
  }

  /**
   * At most `limit` webhooks (default and cap 1000) in creation order, after webhook `after`;
   * with `ownerKey`, only those that principal created.
   * @param {{ownerKey?: string, after?: string, limit?: number}} [opts]
   * @returns {WebhookRow[]}
   */
  listWebhooks(opts = {}) {
    const clauses = [];
    const params = [];
    if (opts.ownerKey !== undefined) {
      clauses.push('owner_key = ?');
      params.push(opts.ownerKey);
    }
    if (opts.after) {
      clauses.push('(created_at, id) > (SELECT created_at, id FROM webhooks WHERE id = ?)');
      params.push(opts.after);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .prepare(`SELECT ${WEBHOOK_COLS} FROM webhooks ${where} ORDER BY created_at, id LIMIT ?`)
      .all(...params, pageSize(opts.limit, MAX_PAGE))
      .map(webhookRow);
  }

  /**
   * Change a webhook. `enabled: true` clears `disabledReason`; `enabled: false` records the given
   * `disabledReason` (or none). An unknown id is E_NOT_FOUND.
   * @param {string} id
   * @param {{url?: string, secret?: string, types?: string[], description?: string|null, enabled?: boolean, disabledReason?: string|null}} patch
   * @returns {WebhookRow}
   */
  updateWebhook(id, patch) {
    const sets = [];
    const params = [];
    const set = (column, value) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.url !== undefined) set('url', patch.url);
    if (patch.secret !== undefined) set('secret', patch.secret);
    if (patch.types !== undefined) {
      typeFilter(patch.types);
      set('types', JSON.stringify(patch.types));
    }
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.enabled !== undefined) {
      set('enabled', patch.enabled ? 1 : 0);
      set('disabled_reason', patch.enabled ? null : (patch.disabledReason ?? null));
    }
    return this.tx(() => {
      if (!this.getWebhook(id)) throw E.notFound(`webhook ${id} not found`, { webhookId: id });
      set('updated_at', this.clock());
      this.db.prepare(`UPDATE webhooks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      return this.getWebhook(id);
    });
  }

  /**
   * Delete a webhook and its deliveries. An unknown id is E_NOT_FOUND.
   * @param {string} id
   * @returns {WebhookRow} the deleted webhook
   */
  deleteWebhook(id) {
    return this.tx(() => {
      const row = this.getWebhook(id);
      if (!row) throw E.notFound(`webhook ${id} not found`, { webhookId: id });
      this.db.prepare(`DELETE FROM webhook_deliveries WHERE webhook_id = ?`).run(id);
      this.db.prepare(`DELETE FROM webhooks WHERE id = ?`).run(id);
      return row;
    });
  }

  /**
   * Enabled webhooks whose owner can still act: a webhook owned by a stored key that is revoked
   * or expired is left out.
   * @returns {WebhookRow[]}
   */
  listActiveWebhooks() {
    return this.db
      .prepare(
        `SELECT ${WEBHOOK_COLS} FROM webhooks w WHERE ${ACTIVE_WEBHOOK} ORDER BY created_at, id`,
      )
      .all(this.clock())
      .map(webhookRow);
  }

  /**
   * Queue a delivery for every event after the webhook's cursor that it matches (its types, its
   * sandbox, its labels and the binding copied from its creator) and advance the cursor, in one
   * transaction. At most `limit` events (default and cap 1000) per call; `more` says another call
   * has events left.
   * @param {string} id
   * @param {{limit?: number}} [opts]
   * @returns {{queued: number, more: boolean}}
   */
  enqueueWebhookEvents(id, opts = {}) {
    const limit = pageSize(opts.limit, MAX_PAGE);
    return this.tx(() => {
      const w = this.db
        .prepare(
          `SELECT id, types, sandbox_id, labels, binding, last_seq FROM webhooks WHERE id = ?`,
        )
        .get(id);
      if (!w) return { queued: 0, more: false };
      const top = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS top FROM events`).get().top;
      if (top <= w.last_seq) return { queued: 0, more: false };
      const clauses = ['seq > ?', 'seq <= ?'];
      const params = [w.last_seq, top];
      const add = (filter) => {
        if (!filter) return;
        clauses.push(filter.sql);
        params.push(...filter.params);
      };
      if (w.sandbox_id !== null) add({ sql: 'sandbox_id = ?', params: [w.sandbox_id] });
      add(typeFilter(parseColumn(w.types, 'webhooks', id, 'types')));
      if (w.labels !== null)
        add(
          bindingFilter(
            { labels: parseColumn(w.labels, 'webhooks', id, 'labels') },
            { sandboxColumn: 'sandbox_id' },
          ),
        );
      if (w.binding !== null)
        add(
          bindingFilter(parseColumn(w.binding, 'webhooks', id, 'binding'), {
            sandboxColumn: 'sandbox_id',
          }),
        );
      const rows = this.db
        .prepare(
          `SELECT ${EVENT_COLS} FROM events WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?`,
        )
        .all(...params, limit)
        .map(eventRow);
      const now = this.clock();
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO webhook_deliveries (id, webhook_id, event_seq, event, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
      );
      let queued = 0;
      for (const e of rows)
        queued += Number(
          insert.run(`msg_${newId(now)}`, id, e.seq, JSON.stringify(e), now, now).changes,
        );
      const more = rows.length === limit;
      this.db
        .prepare(`UPDATE webhooks SET last_seq = ? WHERE id = ?`)
        .run(more ? rows[rows.length - 1].seq : top, id);
      return { queued, more };
    });
  }

  /**
   * Queue one delivery of `event` outside the event log (a test delivery). An unknown webhook is
   * E_NOT_FOUND.
   * @param {string} webhookId
   * @param {WebhookEvent} event
   * @returns {WebhookDeliveryRow}
   */
  queueWebhookDelivery(webhookId, event) {
    return this.tx(() => {
      if (!this.getWebhook(webhookId))
        throw E.notFound(`webhook ${webhookId} not found`, { webhookId });
      const now = this.clock();
      const id = `msg_${newId(now)}`;
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (id, webhook_id, event_seq, event, status, attempts, next_at, created_at) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          id,
          webhookId,
          Number.isInteger(event.seq) ? event.seq : null,
          JSON.stringify(event),
          now,
          now,
        );
      return this.getWebhookDelivery(id);
    });
  }

  /**
   * Take up to `limit` deliveries that are due, of active webhooks (see listActiveWebhooks), and
   * hold each for `leaseMs` by moving its `nextAt` forward: a process that dies mid-request
   * leaves the delivery to be sent again once the lease ends.
   * @param {{limit?: number, leaseMs: number}} opts
   * @returns {WebhookDeliveryRow[]} the rows as they were before the lease
   */
  claimWebhookDeliveries(opts) {
    const now = this.clock();
    return this.tx(() => {
      const rows = this.db
        .prepare(
          `SELECT ${DELIVERY_COLS_D} FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.status = 'pending' AND d.next_at <= ? AND ${ACTIVE_WEBHOOK} ORDER BY d.next_at, d.id LIMIT ?`,
        )
        .all(now, now, pageSize(opts.limit, 100))
        .map(deliveryRow);
      const lease = this.db.prepare(`UPDATE webhook_deliveries SET next_at = ? WHERE id = ?`);
      for (const d of rows) lease.run(now + opts.leaseMs, d.id);
      return rows;
    });
  }

  /** When the next pending delivery of an active webhook is due (ms), or null. @returns {number|null} */
  nextWebhookDeliveryAt() {
    const r = this.db
      .prepare(
        `SELECT MIN(d.next_at) AS at FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id WHERE d.status = 'pending' AND ${ACTIVE_WEBHOOK}`,
      )
      .get(this.clock());
    return r.at ?? null;
  }

  /**
   * Record one delivery attempt: it counts toward `attempts`, and `status` is where it leaves the
   * delivery (`pending` with the next attempt's `nextAt`, `delivered` or `failed`).
   * @param {string} id
   * @param {{status: 'pending'|'delivered'|'failed', nextAt?: number|null, lastStatus?: number|null, lastError?: string|null}} outcome
   * @returns {WebhookDeliveryRow}
   */
  recordWebhookAttempt(id, outcome) {
    if (!DELIVERY_STATUSES.includes(outcome.status))
      throw E.invalid(`unknown delivery status ${outcome.status}`, { status: outcome.status });
    const now = this.clock();
    const r = this.db
      .prepare(
        `UPDATE webhook_deliveries SET attempts = attempts + 1, status = ?, next_at = ?, last_status = ?, last_error = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ?`,
      )
      .run(
        outcome.status,
        outcome.status === 'pending' ? (outcome.nextAt ?? now) : null,
        outcome.lastStatus ?? null,
        outcome.lastError ?? null,
        outcome.status,
        now,
        id,
      );
    if (!Number(r.changes)) throw E.notFound(`delivery ${id} not found`, { deliveryId: id });
    return this.getWebhookDelivery(id);
  }

  /** @param {string} id @returns {WebhookDeliveryRow|null} */
  getWebhookDelivery(id) {
    const r = this.db
      .prepare(`SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE id = ?`)
      .get(id);
    return r ? deliveryRow(r) : null;
  }

  /**
   * One page of a webhook's deliveries, newest first; pass the returned `cursor` back for the
   * next. `status` keeps only deliveries in that state.
   * @param {string} webhookId
   * @param {{status?: 'pending'|'delivered'|'failed', limit?: number, cursor?: string|null}} [opts]
   * @returns {{items: WebhookDeliveryRow[], cursor: string|null, complete: boolean}}
   */
  listWebhookDeliveries(webhookId, opts = {}) {
    const limit = pageSize(opts.limit, 50);
    const clauses = ['webhook_id = ?'];
    const params = [webhookId];
    if (opts.status !== undefined) {
      if (!DELIVERY_STATUSES.includes(opts.status))
        throw E.invalid(`status must be one of ${DELIVERY_STATUSES.join(', ')}`, {
          status: opts.status,
        });
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.cursor) {
      clauses.push('id < ?');
      params.push(opts.cursor);
    }
    const rows = this.db
      .prepare(
        `SELECT ${DELIVERY_COLS} FROM webhook_deliveries WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit + 1);
    const complete = rows.length <= limit;
    const items = rows.slice(0, limit).map(deliveryRow);
    return { items, cursor: complete ? null : items[items.length - 1].id, complete };
  }

  /**
   * Send a delivery again as soon as possible, whatever its state. Its attempt count is kept: a
   * delivery past its last retry gets this one attempt. An unknown id is E_NOT_FOUND.
   * @param {string} id
   * @returns {WebhookDeliveryRow}
   */
  retryWebhookDelivery(id) {
    const r = this.db
      .prepare(`UPDATE webhook_deliveries SET status = 'pending', next_at = ? WHERE id = ?`)
      .run(this.clock(), id);
    if (!Number(r.changes)) throw E.notFound(`delivery ${id} not found`, { deliveryId: id });
    return this.getWebhookDelivery(id);
  }
}

/**
 * Sandboxes a bound API key may see: those whose id is listed, and those carrying every label.
 * @typedef {{labels?: Record<string, string>, sandboxIds?: string[]}} Binding
 */

/**
 * @typedef {object} ApiKeyRow
 * @property {string} id
 * @property {string} name
 * @property {string[]} scopes
 * @property {Binding|null} binding
 * @property {number} createdAt
 * @property {number|null} expiresAt
 * @property {number|null} revokedAt
 * @property {number|null} lastUsedAt
 * @property {string|null} createdBy
 */

/**
 * @typedef {object} WebhookRow
 * @property {string} id
 * @property {string} url
 * @property {string[]} types event types and `prefix.*` patterns; empty matches every type
 * @property {string|null} sandboxId only this sandbox's events
 * @property {Record<string, string>|null} labels only events of sandboxes carrying every label
 * @property {string|null} description
 * @property {boolean} enabled
 * @property {string|null} disabledReason why the webhook was disabled, when it was not by request
 * @property {string|null} ownerKey the principal that created it
 * @property {Binding|null} binding the creator's binding, which limits the events it receives
 * @property {number} lastSeq the event seq it has queued deliveries up to
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * An event as a webhook delivers it: an event log row, or a test event with a null `seq` and
 * `sandboxId`.
 * @typedef {{seq: number|null, sandboxId: string|null, type: string, source: string, payload: object|null, causation: string|null, at: number}} WebhookEvent
 */

/**
 * @typedef {object} WebhookDeliveryRow
 * @property {string} id the `webhook-id` header, the same on every attempt
 * @property {string} webhookId
 * @property {number|null} eventSeq null for a test delivery
 * @property {WebhookEvent} event the event as it was when queued
 * @property {'pending'|'delivered'|'failed'} status
 * @property {number} attempts
 * @property {number|null} nextAt when a pending delivery is next attempted
 * @property {number|null} lastStatus HTTP status of the last attempt, null when none answered
 * @property {string|null} lastError
 * @property {number} createdAt
 * @property {number|null} deliveredAt
 */

/**
 * A SQL condition selecting the sandboxes a binding makes visible: an id in `sandboxIds`, or
 * every `labels` entry equal to the sandbox's label of that name. A binding with neither selects
 * nothing; no binding selects everything. Without `sandboxColumn` the condition reads the `id`
 * and `labels` columns of a query over `sandboxes`; with it, it limits that column of another
 * table to the ids of visible sandboxes.
 * @param {Binding|null|undefined} binding
 * @param {{sandboxColumn?: string}} [opts]
 * @returns {{sql: string, params: string[]}}
 */
export function bindingFilter(binding, opts = {}) {
  if (!binding) return { sql: '1', params: [] };
  const alternatives = [];
  const params = [];
  const ids = binding.sandboxIds ?? [];
  if (ids.length) {
    alternatives.push(`sandboxes.id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  const labels = Object.entries(binding.labels ?? {});
  if (labels.length) {
    const each = labels.map(
      () =>
        'EXISTS (SELECT 1 FROM json_each(sandboxes.labels) AS l WHERE l.key = ? AND l.value = ?)',
    );
    alternatives.push(`(${each.join(' AND ')})`);
    for (const [k, val] of labels) params.push(k, val);
  }
  const cond = alternatives.length ? `(${alternatives.join(' OR ')})` : '0';
  if (!opts.sandboxColumn) return { sql: cond, params };
  return {
    sql: `${opts.sandboxColumn} IN (SELECT sandboxes.id FROM sandboxes WHERE ${cond})`,
    params,
  };
}

Store.bindingFilter = bindingFilter;

const KEY_COLS = `id, name, scopes, binding, created_at, expires_at, revoked_at, last_used_at, created_by`;

const WEBHOOK_COLS = `id, url, types, sandbox_id, labels, description, enabled, owner_key, binding, last_seq, created_at, updated_at, disabled_reason`;

const DELIVERY_COLS = `id, webhook_id, event_seq, event, status, attempts, next_at, last_status, last_error, created_at, delivered_at`;
const DELIVERY_COLS_D = DELIVERY_COLS.split(', ')
  .map((c) => `d.${c}`)
  .join(', ');

/** The states of a webhook delivery. */
const DELIVERY_STATUSES = Object.freeze(['pending', 'delivered', 'failed']);

/** A webhook (aliased `w`) that is enabled and whose owner is not a revoked or expired stored key. */
const ACTIVE_WEBHOOK = `w.enabled = 1 AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.id = w.owner_key AND (k.revoked_at IS NOT NULL OR (k.expires_at IS NOT NULL AND k.expires_at <= ?)))`;

const digestOf = (s) => createHash('sha256').update(s).digest();

/** Constant-time equality of two secrets: both sides are digested to 32 bytes first, so neither
 * the content nor the length of the stored value leaks through timing. */
function safeEqual(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return timingSafeEqual(digestOf(sa), digestOf(sb)) && sa.length > 0 && sb.length > 0;
}

/** The at-rest form of a plaintext lease token. Never passes a digest through as already hashed. */
function leaseDigest(token) {
  return `sha256:${digestOf(String(token ?? '')).toString('hex')}`;
}

function pageSize(limit, fallback) {
  const n = Number.isFinite(limit) ? limit : fallback;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_PAGE);
}

/** JSON.parse a column; a corrupt value is an E_INTERNAL naming the table, row and column. */
function parseColumn(text, table, id, column) {
  try {
    return JSON.parse(text);
  } catch {
    throw E.internal(`corrupt ${column} in ${table} row ${id}`, { table, id, column });
  }
}

const EVENT_COLS = 'seq, sandbox_id, type, source, payload, causation, at';

function eventRow(r) {
  return {
    seq: r.seq,
    sandboxId: r.sandbox_id,
    type: r.type,
    source: r.source,
    payload: r.payload === null ? null : parseColumn(r.payload, 'events', r.seq, 'payload'),
    causation: r.causation,
    at: r.at,
  };
}

/**
 * SQL for a list of event type patterns, or null when the list matches everything.
 * @param {string[]|undefined} types
 * @returns {{sql: string, params: (string|number)[]}|null}
 */
function typeFilter(types) {
  if (types === undefined || types === null) return null;
  if (!Array.isArray(types) || types.some((t) => typeof t !== 'string' || t.length === 0))
    throw E.invalid('types must be an array of event types or prefix.* patterns', { types });
  if (types.length === 0) return null;
  const ors = [];
  const params = [];
  for (const t of new Set(types)) {
    if (t.endsWith('.*')) {
      const prefix = t.slice(0, -1);
      ors.push('substr(type, 1, ?) = ?');
      params.push(prefix.length, prefix);
    } else {
      ors.push('type = ?');
      params.push(t);
    }
  }
  return { sql: `(${ors.join(' OR ')})`, params };
}

function checkIntegrity(db, dbPath) {
  const problems = db
    .prepare('PRAGMA integrity_check')
    .all()
    .map((r) => r.integrity_check)
    .filter((m) => m !== 'ok');
  if (problems.length)
    throw E.internal(`store ${dbPath} failed integrity_check`, {
      path: dbPath,
      problems: problems.slice(0, 10),
    });
}

function sandboxRow(r) {
  return {
    id: r.id,
    name: r.name,
    state: r.state,
    stateReason: r.state_reason,
    health: r.health,
    rootfs: r.rootfs,
    runtime: r.runtime,
    profile: parseColumn(r.profile, 'sandboxes', r.id, 'profile'),
    labels: parseColumn(r.labels, 'sandboxes', r.id, 'labels'),
    idempotencyKey: r.idempotency_key,
    pid: r.pid,
    bootId: r.boot_id,
    cgroup: r.cgroup,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    readyAt: r.ready_at,
    deletedAt: r.deleted_at,
    lastObservedAt: r.last_observed_at,
  };
}

function bootRow(r) {
  return {
    bootId: r.boot_id,
    sandboxId: r.sandbox_id,
    nonceHash: r.nonce_hash,
    nonceConsumedAt: r.nonce_consumed_at,
    pid: r.pid,
    runnerVersion: r.runner_version,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

function askRow(r) {
  return {
    id: r.id,
    sandboxId: r.sandbox_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    options: r.options ? parseColumn(r.options, 'asks', r.id, 'options') : null,
    recommended: r.recommended,
    ref: r.ref,
    status: r.status,
    answer: r.answer === null ? null : parseColumn(r.answer, 'asks', r.id, 'answer'),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    answeredAt: r.answered_at,
    answeredBy: r.answered_by,
  };
}

function checkpointRow(r) {
  return {
    id: r.id,
    sandboxId: r.sandbox_id,
    name: r.name,
    sha256: r.sha256,
    size: r.size,
    envelope: parseColumn(r.envelope, 'checkpoints', r.id, 'envelope'),
    createdAt: r.created_at,
  };
}

function apiKeyRow(r) {
  return {
    id: r.id,
    name: r.name,
    scopes: parseColumn(r.scopes, 'api_keys', r.id, 'scopes'),
    binding: r.binding === null ? null : parseColumn(r.binding, 'api_keys', r.id, 'binding'),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    lastUsedAt: r.last_used_at,
    createdBy: r.created_by,
  };
}

function webhookRow(r) {
  return {
    id: r.id,
    url: r.url,
    types: parseColumn(r.types, 'webhooks', r.id, 'types'),
    sandboxId: r.sandbox_id,
    labels: r.labels === null ? null : parseColumn(r.labels, 'webhooks', r.id, 'labels'),
    description: r.description,
    enabled: r.enabled === 1,
    disabledReason: r.disabled_reason,
    ownerKey: r.owner_key,
    binding: r.binding === null ? null : parseColumn(r.binding, 'webhooks', r.id, 'binding'),
    lastSeq: r.last_seq,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function deliveryRow(r) {
  return {
    id: r.id,
    webhookId: r.webhook_id,
    eventSeq: r.event_seq,
    event: parseColumn(r.event, 'webhook_deliveries', r.id, 'event'),
    status: r.status,
    attempts: r.attempts,
    nextAt: r.next_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
  };
}

function evidenceRow(r) {
  return {
    id: r.id,
    sandboxId: r.sandbox_id,
    envelope: parseColumn(r.envelope, 'evidence', r.id, 'envelope'),
    logSha256: r.log_sha256,
    createdAt: r.created_at,
  };
}
