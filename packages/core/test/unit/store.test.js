import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    assert.throws(
      () => store.renewLease(s.id, 'bad', 1000),
      (e) => e.code === 'E_DENIED',
    );
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
