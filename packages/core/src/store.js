import fs from 'node:fs';
import path from 'node:path';
import { timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { newId } from '@workbox/protocol';
import { E, WorkboxError } from './errors.js';
import { States, Health, assertTransition } from './sandbox/state.js';

export const SCHEMA_VERSION = 2;

const TOKEN_DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_PAGE = 1000;

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
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
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
   * @param {{states?: string[], includeDeleted?: boolean, cursor?: string|null, limit?: number}} [opts]
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

  /** @param {string} sandboxId @param {{afterSeq?: number, limit?: number}} [opts] */
  listEvents(sandboxId, opts = {}) {
    return this.db
      .prepare(
        `SELECT seq, type, payload, causation, source, at FROM events WHERE sandbox_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      )
      .all(sandboxId, opts.afterSeq ?? 0, pageSize(opts.limit, 100))
      .map((r) => ({
        seq: r.seq,
        type: r.type,
        payload: r.payload === null ? null : parseColumn(r.payload, 'events', r.seq, 'payload'),
        causation: r.causation,
        source: r.source,
        at: r.at,
      }));
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
   * At most `limit` asks (default 100, cap 1000) in creation order, after ask `after`.
   * @param {{sandboxId?: string, status?: 'open'|'answered'|'expired'|'all', after?: string, limit?: number}} [opts]
   */
  listAsks(opts = {}) {
    const clauses = [];
    const params = [];
    if (opts.sandboxId) {
      clauses.push('sandbox_id = ?');
      params.push(opts.sandboxId);
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
}

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

function evidenceRow(r) {
  return {
    id: r.id,
    sandboxId: r.sandbox_id,
    envelope: parseColumn(r.envelope, 'evidence', r.id, 'envelope'),
    logSha256: r.log_sha256,
    createdAt: r.created_at,
  };
}
