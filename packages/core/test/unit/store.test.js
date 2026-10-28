import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../../src/store.js';
import { tmpDir, fakeClock } from '../helpers/tmp.js';

const base = { rootfs: 'minimal', runtime: 'current', profile: { limits: { pids: 10 } } };

function openTmp() {
  const t = tmpDir();
  const clock = fakeClock();
  const store = Store.open(path.join(t.dir, 'db', 'workbox.db'), { clock });
  return { store, clock, cleanup: () => (store.close(), t.cleanup()), dir: t.dir };
}

test('open creates the directory, migrates once and is idempotent', () => {
  const { store, cleanup, dir } = openTmp();
  try {
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    store.migrate();
    assert.equal(store.schemaVersion, SCHEMA_VERSION);
    assert.ok(fs.existsSync(path.join(dir, 'db', 'workbox.db')));
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    const mem = Store.open(':memory:');
    assert.equal(mem.schemaVersion, SCHEMA_VERSION);
    mem.db.prepare(`UPDATE meta SET value = '99' WHERE key = 'schema_version'`).run();
    assert.throws(
      () => mem.migrate(),
      (e) => e.code === 'E_STATE',
    );
    mem.close();
  } finally {
    cleanup();
  }
});

test('sandbox create, get, idempotency and listing with cursors', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const a = store.createSandbox({
      ...base,
      name: 'a',
      labels: { team: 'x' },
      idempotencyKey: 'k1',
    });
    assert.equal(a.state, 'REQUESTED');
    assert.equal(a.health, 'UNKNOWN');
    assert.equal(a.version, 1);
    assert.deepEqual(a.labels, { team: 'x' });
    assert.deepEqual(a.profile, base.profile);
    assert.equal(a.createdAt, clock());
    assert.equal(store.createSandbox({ ...base, idempotencyKey: 'k1' }).id, a.id);
    assert.equal(store.getSandboxByIdempotencyKey('k1').id, a.id);
    assert.equal(store.getSandbox('nope'), null);
    assert.throws(
      () => store.requireSandbox('nope'),
      (e) => e.code === 'E_NOT_FOUND',
    );
    const ids = [a.id];
    for (let i = 0; i < 4; i++) {
      clock.advance(1);
      ids.push(store.createSandbox({ ...base, name: `s${i}` }).id);
    }
    const p1 = store.listSandboxes({ limit: 2 });
    assert.equal(p1.items.length, 2);
    assert.equal(p1.complete, false);
    assert.equal(p1.cursor, p1.items[1].id);
    const p2 = store.listSandboxes({ limit: 2, cursor: p1.cursor });
    const p3 = store.listSandboxes({ limit: 2, cursor: p2.cursor });
    assert.deepEqual(
      [...p1.items, ...p2.items, ...p3.items].map((s) => s.id),
      ids,
    );
    assert.equal(p3.complete, true);
    assert.equal(p3.cursor, null);
    store.transition(ids[1], 'DELETING', 'test');
    store.transition(ids[1], 'DELETED', 'test');
    assert.equal(store.listSandboxes().items.length, 4);
    assert.equal(store.listSandboxes({ includeDeleted: true }).items.length, 5);
    assert.deepEqual(
      store.listSandboxes({ states: ['DELETED'] }).items.map((s) => s.id),
      [ids[1]],
    );
    assert.equal(store.listSandboxes({ limit: 0 }).items.length, 1);
  } finally {
    cleanup();
  }
});

test('transitions are validated, versioned and recorded', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    assert.throws(
      () => store.transition(s.id, 'READY', 'skip'),
      (e) => e.code === 'E_STATE' && e.data.from === 'REQUESTED',
    );
    const p = store.transition(s.id, 'PROVISIONING', 'launch', {
      expectedVersion: 1,
      patch: { pid: 4242, cgroup: '/sys/fs/cgroup/workbox/x' },
    });
    assert.equal(p.state, 'PROVISIONING');
    assert.equal(p.version, 2);
    assert.equal(p.pid, 4242);
    assert.equal(p.stateReason, 'launch');
    assert.throws(
      () => store.transition(s.id, 'BOOTSTRAPPING', 'x', { expectedVersion: 1 }),
      (e) => e.code === 'E_CONFLICT' && e.data.version === 2,
    );
    clock.advance(5);
    store.transition(s.id, 'BOOTSTRAPPING', 'runner hello');
    clock.advance(5);
    const r = store.transition(s.id, 'READY', 'runner ready');
    assert.equal(r.readyAt, clock());
    assert.throws(
      () => store.transition(s.id, 'PROVISIONING', 'back'),
      (e) => e.code === 'E_STATE',
    );
    assert.throws(
      () => store.transition(s.id, 'DELETING', 'bye', { patch: { bogus: 1 } }),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    const t = store.listTransitions(s.id);
    assert.deepEqual(
      t.map((x) => [x.from, x.to, x.reason]),
      [
        [null, 'REQUESTED', 'created'],
        ['REQUESTED', 'PROVISIONING', 'launch'],
        ['PROVISIONING', 'BOOTSTRAPPING', 'runner hello'],
        ['BOOTSTRAPPING', 'READY', 'runner ready'],
      ],
    );
    assert.ok(t.every((x) => typeof x.at === 'number' && x.sandboxId === s.id));
    const o = store.observe(s.id, 'HEALTHY');
    assert.equal(o.health, 'HEALTHY');
    assert.equal(o.lastObservedAt, clock());
    assert.throws(
      () => store.observe(s.id, 'FINE'),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    const u = store.updateSandbox(s.id, { name: 'renamed', labels: { a: 1 }, profile: { x: 2 } });
    assert.equal(u.name, 'renamed');
    assert.deepEqual(u.labels, { a: 1 });
    assert.deepEqual(u.profile, { x: 2 });
    assert.equal(u.version, 4);
    store.transition(s.id, 'DRAINING', 'drain');
    store.transition(s.id, 'DELETING', 'delete');
    const d = store.transition(s.id, 'DELETED', 'gone');
    assert.equal(d.deletedAt, clock());
  } finally {
    cleanup();
  }
});

test('boots and single-use nonces', () => {
  const { store, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    assert.throws(
      () => store.createBoot({ bootId: 'b0', sandboxId: 'missing', nonceHash: 'h' }),
      (e) => e.code === 'E_NOT_FOUND',
    );
    const b = store.createBoot({ bootId: 'b1', sandboxId: s.id, nonceHash: 'hash1', pid: 77 });
    assert.equal(b.nonceConsumedAt, null);
    assert.equal(store.getSandbox(s.id).bootId, 'b1');
    assert.equal(store.getSandbox(s.id).pid, 77);
    assert.equal(store.consumeNonce('b1', 'wrong'), 'mismatch');
    assert.equal(store.consumeNonce('b1', ''), 'mismatch');
    assert.equal(store.consumeNonce('b1', 'hash1hash1'), 'mismatch');
    assert.equal(store.consumeNonce('b9', 'hash1'), 'missing');
    assert.equal(store.consumeNonce('b1', 'hash1', { runnerVersion: '0.1.0' }), 'consumed');
    assert.equal(store.consumeNonce('b1', 'hash1'), 'already');
    const after = store.getBoot('b1');
    assert.ok(after.nonceConsumedAt > 0);
    assert.equal(after.runnerVersion, '0.1.0');
    assert.ok(store.endBoot('b1').endedAt > 0);
    assert.equal(store.getBoot('nope'), null);
  } finally {
    cleanup();
  }
});

test('sessions and events', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    store.upsertSession(s.id, { sessionId: 's1', name: 'build', argv: ['make'] });
    store.upsertSession(s.id, { sessionId: 's1', name: 'build2', argv: ['make', 'all'] });
    clock.advance(1);
    store.upsertSession(s.id, { sessionId: 's2', argv: ['sh'] });
    store.sessionExited(s.id, 's1', { code: 0, signal: null });
    const list = store.listSessions(s.id);
    assert.equal(list.length, 2);
    assert.equal(list[0].name, 'build2');
    assert.deepEqual(list[0].argv, ['make', 'all']);
    assert.equal(list[0].exitCode, 0);
    assert.equal(list[1].exitedAt, null);
    const seq1 = store.appendEvent(s.id, 'sandbox.created', { by: 'test' });
    const seq2 = store.appendEvent(s.id, 'note', undefined, { causation: 'x', source: 'wb' });
    assert.equal(seq2, seq1 + 1);
    const ev = store.listEvents(s.id);
    assert.deepEqual(
      ev.map((e) => [e.type, e.payload, e.source, e.causation]),
      [
        ['sandbox.created', { by: 'test' }, 'host', null],
        ['note', null, 'wb', 'x'],
      ],
    );
    assert.equal(store.listEvents(s.id, { afterSeq: seq1 }).length, 1);
    assert.equal(store.listEvents(s.id, { limit: 1 }).length, 1);
  } finally {
    cleanup();
  }
});

test('artifacts, references and evidence with cursors', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    const sha = 'a'.repeat(64);
    assert.deepEqual(store.putArtifact({ sha256: sha, size: 10, contentType: 'text/plain' }), {
      sha256: sha,
      size: 10,
      contentType: 'text/plain',
      createdAt: clock(),
    });
    assert.equal(store.putArtifact({ sha256: sha, size: 99 }).size, 10);
    assert.throws(
      () => store.refArtifact(s.id, 'b'.repeat(64)),
      (e) => e.code === 'E_NOT_FOUND',
    );
    store.refArtifact(s.id, sha, { name: 'log.txt', kind: 'log' });
    store.refArtifact(s.id, sha, { name: 'log.txt', kind: 'log' });
    clock.advance(1);
    const sha2 = 'c'.repeat(64);
    store.putArtifact({ sha256: sha2, size: 1 });
    store.refArtifact(s.id, sha2);
    const p1 = store.listArtifacts(s.id, { limit: 1 });
    assert.equal(p1.items[0].name, 'log.txt');
    assert.equal(p1.complete, false);
    const p2 = store.listArtifacts(s.id, { limit: 1, cursor: p1.cursor });
    assert.equal(p2.items[0].sha256, sha2);
    assert.equal(p2.complete, true);
    assert.equal(store.getArtifact('f'.repeat(64)), null);
    const e1 = store.recordEvidence({
      sandboxId: s.id,
      envelope: { argv: ['true'], exit: 0 },
      logSha256: sha,
    });
    clock.advance(1);
    const e2 = store.recordEvidence({
      id: 'ZZZZZZZZZZZZZZZZZZZZZZZZZZ',
      sandboxId: s.id,
      envelope: { argv: ['false'], exit: 1 },
    });
    assert.deepEqual(store.getEvidence(e1.id).envelope, { argv: ['true'], exit: 0 });
    assert.equal(store.getEvidence('nope'), null);
    const l1 = store.listEvidence(s.id, { limit: 1 });
    assert.equal(l1.items[0].id, e1.id);
    assert.equal(l1.complete, false);
    const l2 = store.listEvidence(s.id, { limit: 1, cursor: l1.cursor });
    assert.equal(l2.items[0].id, e2.id);
    assert.equal(l2.complete, true);
  } finally {
    cleanup();
  }
});

test('leases issue, renew, expire and reject bad tokens', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    assert.equal(store.getLease(s.id), null);
    assert.throws(
      () => store.renewLease(s.id, 't', 1000),
      (e) => e.code === 'E_NOT_FOUND',
    );
    const l1 = store.issueLease(s.id, { token: 't1', ttlMs: 1000 });
    assert.equal(l1.generation, 1);
    assert.equal(l1.expiresAt, clock() + 1000);
    const digest = `sha256:${createHash('sha256').update('t1').digest('hex')}`;
    assert.equal(store.db.prepare('SELECT token FROM leases').get().token, digest);
    assert.equal(l1.token, digest);
    for (const bad of ['bad', '', 't1t1t1t1t1t1t1t1', digest.slice(0, -1)])
      assert.throws(
        () => store.renewLease(s.id, bad, 1000),
        (e) => e.code === 'E_DENIED',
      );
    assert.equal(store.renewLease(s.id, digest, 1000).generation, 1);
    clock.advance(500);
    const r = store.renewLease(s.id, 't1', 2000);
    assert.equal(r.renewedAt, clock());
    assert.equal(r.expiresAt, clock() + 2000);
    clock.advance(2000);
    assert.throws(
      () => store.renewLease(s.id, 't1', 1000),
      (e) => e.code === 'E_STATE',
    );
    const l2 = store.issueLease(s.id, { token: 't2', ttlMs: 10 });
    assert.equal(l2.generation, 2);
    assert.equal(l2.renewedAt, null);
  } finally {
    cleanup();
  }
});

test('asks lifecycle', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    const a = store.createAsk({
      sandboxId: s.id,
      kind: 'decision',
      title: 'Pick',
      options: ['x', 'y'],
      recommended: 'x',
      timeoutMs: 1000,
    });
    assert.equal(a.status, 'open');
    assert.deepEqual(a.options, ['x', 'y']);
    assert.equal(a.expiresAt, clock() + 1000);
    const b = store.createAsk({
      id: 'ask-b',
      sandboxId: s.id,
      kind: 'question',
      title: 'Why?',
      body: 'because',
    });
    assert.equal(b.options, null);
    assert.equal(b.expiresAt, null);
    assert.equal(store.listAsks({ sandboxId: s.id, status: 'open' }).length, 2);
    assert.equal(store.listAsks({ status: 'answered' }).length, 0);
    assert.equal(store.listAsks({ status: 'all' }).length, 2);
    const ans = store.answerAsk(a.id, { answer: 'y', by: 'operator' });
    assert.equal(ans.status, 'answered');
    assert.equal(ans.answer, 'y');
    assert.equal(ans.answeredBy, 'operator');
    assert.throws(
      () => store.answerAsk(a.id, { answer: 'x' }),
      (e) => e.code === 'E_STATE',
    );
    assert.throws(
      () => store.answerAsk('nope', { answer: 'x' }),
      (e) => e.code === 'E_NOT_FOUND',
    );
    assert.equal(store.expireAsks(), 0);
    const c = store.createAsk({
      sandboxId: s.id,
      kind: 'permission',
      title: 'May I?',
      timeoutMs: 5,
    });
    clock.advance(10);
    assert.equal(store.expireAsks(), 1);
    assert.equal(store.getAsk(c.id).status, 'expired');
    assert.equal(store.getAsk('zzz'), null);
    assert.equal(store.listAsks().length, 3);
  } finally {
    cleanup();
  }
});

test('checkpoints, presets and secret policy', () => {
  const { store, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    const c = store.addCheckpoint({
      sandboxId: s.id,
      name: 'cp1',
      sha256: 'd'.repeat(64),
      size: 5,
      envelope: { revision: 'abc' },
    });
    assert.deepEqual(store.getCheckpoint(c.id).envelope, { revision: 'abc' });
    assert.equal(store.listCheckpoints(s.id).length, 1);
    assert.equal(store.getCheckpoint('x'), null);
    store.upsertPreset(s.id, 'python', { versions: { python3: '3.12.1' } });
    store.upsertPreset(s.id, 'python', { versions: { python3: '3.12.2' } });
    store.upsertPreset(s.id, 'go', { versions: { go: '1.23' } });
    assert.deepEqual(
      store.listPresets(s.id).map((p) => [p.name, p.manifest.versions]),
      [
        ['go', { go: '1.23' }],
        ['python', { python3: '3.12.2' }],
      ],
    );
    store.setSecretPolicy(s.id, ['npm_token', 'gh_token', 'npm_token']);
    assert.deepEqual(store.getSecretPolicy(s.id), ['gh_token', 'npm_token']);
    store.setSecretPolicy(s.id, []);
    assert.deepEqual(store.getSecretPolicy(s.id), []);
  } finally {
    cleanup();
  }
});

test('tx rolls back on error and nests', () => {
  const { store, cleanup } = openTmp();
  try {
    assert.throws(() =>
      store.tx(() => {
        store.createSandbox({ ...base, name: 'inner' });
        store.tx(() => store.createSandbox({ ...base, name: 'nested' }));
        throw new Error('abort');
      }),
    );
    assert.equal(store.listSandboxes().items.length, 0);
    assert.equal(store.depth, 0);
    const out = store.tx(() => store.tx(() => 42));
    assert.equal(out, 42);
  } finally {
    cleanup();
  }
});

test('a v1 database with a plaintext lease token migrates to v2 and the plaintext leaves the disk', () => {
  const t = tmpDir();
  try {
    const file = path.join(t.dir, 'workbox.db');
    const plaintext = 'v1-plaintext-lease-token-4f2a9c';
    const brokerDigest = `sha256:${'b'.repeat(64)}`;
    const clock = fakeClock();
    const v1 = new Store(new DatabaseSync(file), file, clock);
    v1.db.exec('PRAGMA journal_mode = WAL');
    v1.migrate(1);
    assert.equal(v1.schemaVersion, 1);
    const a = v1.createSandbox(base);
    clock.advance(1);
    const b = v1.createSandbox(base);
    const ins = v1.db.prepare(
      `INSERT INTO leases (sandbox_id, token, generation, issued_at, expires_at) VALUES (?, ?, 1, ?, ?)`,
    );
    ins.run(a.id, plaintext, clock(), clock() + 60_000);
    ins.run(b.id, brokerDigest, clock(), clock() + 60_000);
    v1.close();
    assert.ok(fs.readFileSync(file).includes(plaintext), 'v1 keeps the token in plaintext');

    const store = Store.open(file, { clock });
    assert.equal(store.schemaVersion, 2);
    const digest = `sha256:${createHash('sha256').update(plaintext).digest('hex')}`;
    assert.equal(store.getLease(a.id).token, digest);
    assert.equal(store.getLease(b.id).token, brokerDigest);
    assert.throws(
      () => store.renewLease(a.id, 'v1-plaintext-lease-token-4f2a9d', 1000),
      (e) => e.code === 'E_DENIED',
    );
    assert.equal(store.renewLease(a.id, plaintext, 1000).generation, 1);
    store.close();
    for (const f of fs.readdirSync(t.dir))
      assert.ok(
        !fs.readFileSync(path.join(t.dir, f)).includes(plaintext),
        `${f} holds no plaintext`,
      );
    const again = Store.open(file, { clock });
    assert.equal(again.schemaVersion, 2);
    assert.equal(again.getLease(a.id).token, digest);
    again.close();
  } finally {
    t.cleanup();
  }
});

test('open runs integrity_check: a corrupt index or a non-database file is E_INTERNAL', () => {
  const t = tmpDir();
  try {
    const file = path.join(t.dir, 'workbox.db');
    const key = 'integrity-probe-key-0001';
    const store = Store.open(file);
    store.createSandbox({ ...base, idempotencyKey: key });
    const size = store.db.prepare('PRAGMA page_size').get().page_size;
    const { rootpage } = store.db
      .prepare(`SELECT rootpage FROM sqlite_master WHERE name = 'sqlite_autoindex_sandboxes_2'`)
      .get();
    store.close();
    const bytes = fs.readFileSync(file);
    const start = (rootpage - 1) * size;
    const at = bytes.subarray(start, start + size).indexOf(key);
    assert.ok(at > 0, 'the idempotency key sits in its index page');
    bytes[start + at + key.length - 1] = '9'.charCodeAt(0);
    fs.writeFileSync(file, bytes);
    assert.throws(
      () => Store.open(file),
      (e) =>
        e.code === 'E_INTERNAL' &&
        e.data.path === file &&
        e.data.problems.length > 0 &&
        /integrity_check/.test(e.message),
    );
    const junk = path.join(t.dir, 'junk.db');
    fs.writeFileSync(junk, Buffer.alloc(8192, 0x5a));
    assert.throws(
      () => Store.open(junk),
      (e) => e.code === 'E_INTERNAL' && e.data.path === junk,
    );
  } finally {
    t.cleanup();
  }
});

test('a corrupt JSON column is E_INTERNAL naming its row while other rows stay readable', () => {
  const { store, cleanup } = openTmp();
  try {
    const corrupt = (table, id, column) => (e) =>
      e.code === 'E_INTERNAL' &&
      e.data.table === table &&
      e.data.id === id &&
      e.data.column === column &&
      e.message.includes(String(id));
    const good = store.createSandbox({ ...base, name: 'good' });
    const bad = store.createSandbox({ ...base, name: 'bad' });
    store.db.prepare(`UPDATE sandboxes SET labels = '{"torn":' WHERE id = ?`).run(bad.id);
    assert.throws(() => store.getSandbox(bad.id), corrupt('sandboxes', bad.id, 'labels'));
    assert.throws(() => store.listSandboxes(), corrupt('sandboxes', bad.id, 'labels'));
    assert.throws(
      () => store.transition(bad.id, 'PROVISIONING', 'x'),
      corrupt('sandboxes', bad.id, 'labels'),
    );
    assert.equal(store.getSandbox(good.id).name, 'good');
    const seq = store.appendEvent(good.id, 'note', { ok: true });
    store.db.prepare(`UPDATE events SET payload = 'nope' WHERE seq = ?`).run(seq);
    assert.throws(() => store.listEvents(good.id), corrupt('events', seq, 'payload'));
    const ask = store.createAsk({ sandboxId: good.id, kind: 'question', title: 'q' });
    store.db.prepare(`UPDATE asks SET options = '[' WHERE id = ?`).run(ask.id);
    assert.throws(() => store.listAsks(), corrupt('asks', ask.id, 'options'));
    store.upsertSession(good.id, { sessionId: 's1', argv: ['sh'] });
    store.db.prepare(`UPDATE sessions SET argv = 'x' WHERE session_id = 's1'`).run();
    assert.throws(() => store.listSessions(good.id), corrupt('sessions', `${good.id}/s1`, 'argv'));
    const ev = store.recordEvidence({ sandboxId: good.id, envelope: {} });
    store.db.prepare(`UPDATE evidence SET envelope = '' WHERE id = ?`).run(ev.id);
    assert.throws(() => store.getEvidence(ev.id), corrupt('evidence', ev.id, 'envelope'));
    assert.throws(() => store.listEvidence(good.id), corrupt('evidence', ev.id, 'envelope'));
    const cp = store.addCheckpoint({
      sandboxId: good.id,
      sha256: 'e'.repeat(64),
      size: 1,
      envelope: {},
    });
    store.db.prepare(`UPDATE checkpoints SET envelope = '{' WHERE id = ?`).run(cp.id);
    assert.throws(() => store.listCheckpoints(good.id), corrupt('checkpoints', cp.id, 'envelope'));
    store.upsertPreset(good.id, 'go', {});
    store.db.prepare(`UPDATE presets SET manifest = '{' WHERE name = 'go'`).run();
    assert.throws(
      () => store.listPresets(good.id),
      corrupt('presets', `${good.id}/go`, 'manifest'),
    );
  } finally {
    cleanup();
  }
});

test('per-sandbox lists are bounded and page by their sort keys', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const s = store.createSandbox(base);
    store.transition(s.id, 'PROVISIONING', 'a');
    store.transition(s.id, 'BOOTSTRAPPING', 'b');
    const t1 = store.listTransitions(s.id, { limit: 2 });
    assert.deepEqual(
      t1.map((x) => x.to),
      ['REQUESTED', 'PROVISIONING'],
    );
    assert.deepEqual(
      store.listTransitions(s.id, { afterSeq: t1[1].seq }).map((x) => x.to),
      ['BOOTSTRAPPING'],
    );
    const ins = store.db.prepare(
      `INSERT INTO transitions (sandbox_id, from_state, to_state, reason, at) VALUES (?, 'READY', 'READY', 'bulk', 0)`,
    );
    store.tx(() => {
      for (let i = 0; i < 1005; i++) ins.run(s.id);
    });
    assert.equal(store.listTransitions(s.id).length, 1000);
    assert.equal(store.listTransitions(s.id, { limit: 5000 }).length, 1000);

    store.upsertSession(s.id, { sessionId: 'b', argv: ['x'], startedAt: 10 });
    store.upsertSession(s.id, { sessionId: 'a', argv: ['x'], startedAt: 20 });
    store.upsertSession(s.id, { sessionId: 'c', argv: ['x'], startedAt: 20 });
    const sp1 = store.listSessions(s.id, { limit: 2 });
    assert.deepEqual(
      sp1.map((x) => x.sessionId),
      ['b', 'a'],
    );
    assert.deepEqual(
      store.listSessions(s.id, { after: 'a', limit: 2 }).map((x) => x.sessionId),
      ['c'],
    );

    const asks = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1);
      asks.push(store.createAsk({ sandboxId: s.id, kind: 'question', title: `q${i}` }).id);
    }
    const ap1 = store.listAsks({ limit: 2 });
    assert.deepEqual(
      ap1.map((x) => x.id),
      asks.slice(0, 2),
    );
    assert.deepEqual(
      store.listAsks({ after: ap1[1].id }).map((x) => x.id),
      asks.slice(2),
    );
    assert.equal(store.listAsks({ limit: -1 }).length, 1);

    const cps = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1);
      cps.push(
        store.addCheckpoint({ sandboxId: s.id, sha256: 'f'.repeat(64), size: i, envelope: { i } })
          .id,
      );
    }
    const cp1 = store.listCheckpoints(s.id, { limit: 2 });
    assert.deepEqual(
      cp1.map((x) => x.id),
      cps.slice(0, 2),
    );
    assert.deepEqual(
      store.listCheckpoints(s.id, { after: cp1[1].id, limit: 2 }).map((x) => x.id),
      cps.slice(2),
    );

    for (const name of ['rust', 'go', 'node']) store.upsertPreset(s.id, name, { name });
    const pp1 = store.listPresets(s.id, { limit: 2 });
    assert.deepEqual(
      pp1.map((x) => x.name),
      ['go', 'node'],
    );
    assert.deepEqual(
      store.listPresets(s.id, { after: 'node' }).map((x) => x.name),
      ['rust'],
    );
  } finally {
    cleanup();
  }
});
