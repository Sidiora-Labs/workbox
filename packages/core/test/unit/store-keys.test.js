import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION, KEY_TOUCH_INTERVAL_MS, bindingFilter } from '../../src/store.js';
import { tmpDir, fakeClock } from '../helpers/tmp.js';

const base = { rootfs: 'minimal', runtime: 'current', profile: {} };
const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');

function openTmp() {
  const t = tmpDir();
  const clock = fakeClock();
  const file = path.join(t.dir, 'workbox.db');
  const store = Store.open(file, { clock });
  return { store, clock, file, cleanup: () => (store.close(), t.cleanup()) };
}

test('a v2 database migrates to v3 with an empty api_keys table and its rows intact', () => {
  const t = tmpDir();
  try {
    const file = path.join(t.dir, 'workbox.db');
    const clock = fakeClock();
    const v2 = new Store(new DatabaseSync(file), file, clock);
    v2.db.exec('PRAGMA journal_mode = WAL');
    v2.migrate(2);
    assert.equal(v2.schemaVersion, 2);
    const table = `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys'`;
    assert.equal(v2.db.prepare(table).get(), undefined);
    const s = v2.createSandbox({ ...base, labels: { team: 'a' } });
    v2.close();

    const store = Store.open(file, { clock });
    assert.equal(SCHEMA_VERSION, 3);
    assert.equal(store.schemaVersion, 3);
    assert.equal(store.db.prepare(table).get().name, 'api_keys');
    assert.deepEqual(store.getSandbox(s.id).labels, { team: 'a' });
    assert.deepEqual(store.listApiKeys(), []);
    store.close();
  } finally {
    t.cleanup();
  }
});

test('api keys are created, found by digest, listed in order and revoked once', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const d1 = digest();
    const k1 = store.createApiKey({
      name: 'agent',
      tokenSha256: d1,
      scopes: ['read', 'exec'],
      binding: { labels: { team: 'a' } },
      expiresAt: clock() + 1000,
      createdBy: 'root',
    });
    assert.match(k1.id, /^key_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(k1, {
      id: k1.id,
      name: 'agent',
      scopes: ['read', 'exec'],
      binding: { labels: { team: 'a' } },
      createdAt: clock(),
      expiresAt: clock() + 1000,
      revokedAt: null,
      lastUsedAt: null,
      createdBy: 'root',
    });
    assert.deepEqual(store.getApiKeyByDigest(d1), k1);
    assert.equal(store.getApiKeyByDigest(digest()), null);
    assert.equal(store.getApiKey('key_none'), null);

    clock.advance(1);
    const k2 = store.createApiKey({ name: 'ops', tokenSha256: digest(), scopes: ['admin'] });
    assert.equal(k2.binding, null);
    assert.equal(k2.expiresAt, null);
    assert.equal(k2.createdBy, null);
    const ids = (rows) => rows.map((k) => k.id);
    assert.deepEqual(ids(store.listApiKeys()), [k1.id, k2.id]);
    assert.deepEqual(ids(store.listApiKeys({ limit: 1 })), [k1.id]);
    assert.deepEqual(ids(store.listApiKeys({ after: k1.id })), [k2.id]);
    assert.ok(store.listApiKeys().every((k) => !('tokenSha256' in k)));

    const dup = (k) =>
      assert.throws(
        () => store.createApiKey(k),
        (e) => e.code === 'E_CONFLICT',
      );
    dup({ name: 'same-token', tokenSha256: d1, scopes: ['read'] });
    dup({ id: k1.id, name: 'same-id', tokenSha256: digest(), scopes: ['read'] });
    for (const bad of [undefined, 'abc', 'A'.repeat(64), `sha256:${'a'.repeat(64)}`])
      assert.throws(
        () => store.createApiKey({ name: 'x', tokenSha256: bad, scopes: ['read'] }),
        (e) => e.code === 'E_INVALID_PARAMS',
        String(bad),
      );
    assert.equal(store.listApiKeys().length, 2);

    clock.advance(5);
    const revoked = store.revokeApiKey(k1.id);
    assert.equal(revoked.revokedAt, clock());
    clock.advance(5);
    assert.equal(store.revokeApiKey(k1.id).revokedAt, revoked.revokedAt, 'the first time stays');
    assert.equal(store.getApiKeyByDigest(d1).revokedAt, revoked.revokedAt);
    assert.equal(store.getApiKey(k2.id).revokedAt, null);
    assert.throws(
      () => store.revokeApiKey('key_none'),
      (e) => e.code === 'E_NOT_FOUND',
    );
  } finally {
    cleanup();
  }
});

test('last_used_at is written at most once a minute per key, across store handles', () => {
  const { store: a, clock, file, cleanup } = openTmp();
  const b = Store.open(file, { clock });
  try {
    const k = a.createApiKey({ name: 'k', tokenSha256: digest(), scopes: ['read'] });
    assert.equal(a.touchApiKey(k.id), true);
    const first = clock();
    assert.equal(a.getApiKey(k.id).lastUsedAt, first);
    clock.advance(1000);
    assert.equal(a.touchApiKey(k.id), false, 'throttled in this handle');
    assert.equal(b.touchApiKey(k.id), false, 'throttled by the stored time in another handle');
    assert.equal(b.getApiKey(k.id).lastUsedAt, first);
    clock.advance(KEY_TOUCH_INTERVAL_MS);
    assert.equal(a.touchApiKey(k.id), true);
    assert.equal(b.getApiKey(k.id).lastUsedAt, clock());
    clock.advance(1);
    assert.equal(a.touchApiKey(k.id, 0), true, 'a zero interval writes every time');
    assert.equal(a.touchApiKey('key_none'), false, 'an unknown key writes nothing');
  } finally {
    b.close();
    cleanup();
  }
});

test('a binding filters sandboxes and asks in SQL, so pages stay full', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const mk = (labels) => {
      clock.advance(1);
      return store.createSandbox({ ...base, labels });
    };
    const a1 = mk({ team: 'a', env: 'ci' });
    const b1 = mk({ team: 'b' });
    const a2 = mk({ team: 'a' });
    const b2 = mk({ team: 'b', env: 'ci' });
    const a3 = mk({ team: 'a', env: 'ci' });
    const ids = (page) => page.items.map((s) => s.id);
    const teamA = { labels: { team: 'a' } };

    const p1 = store.listSandboxes({ binding: teamA, limit: 2 });
    assert.deepEqual(ids(p1), [a1.id, a2.id]);
    assert.equal(p1.complete, false);
    const p2 = store.listSandboxes({ binding: teamA, limit: 2, cursor: p1.cursor });
    assert.deepEqual(ids(p2), [a3.id]);
    assert.equal(p2.complete, true);
    assert.deepEqual(ids(store.listSandboxes({ binding: { labels: { team: 'a', env: 'ci' } } })), [
      a1.id,
      a3.id,
    ]);
    assert.deepEqual(ids(store.listSandboxes({ binding: { sandboxIds: [b2.id, b1.id] } })), [
      b1.id,
      b2.id,
    ]);
    assert.deepEqual(
      ids(store.listSandboxes({ binding: { sandboxIds: [b1.id], labels: { env: 'ci' } } })),
      [a1.id, b1.id, b2.id, a3.id],
      'ids or labels',
    );
    assert.deepEqual(
      ids(store.listSandboxes({ binding: {} })),
      [],
      'an empty binding sees nothing',
    );
    assert.deepEqual(ids(store.listSandboxes({ binding: { labels: {}, sandboxIds: [] } })), []);
    assert.equal(store.listSandboxes({ binding: null }).items.length, 5);

    const odd = mk({ "k'ey": 'v"al', '$.team': 'a' });
    assert.deepEqual(ids(store.listSandboxes({ binding: { labels: { "k'ey": 'v"al' } } })), [
      odd.id,
    ]);
    assert.deepEqual(ids(store.listSandboxes({ binding: { labels: { '$.team': 'a' } } })), [
      odd.id,
    ]);
    assert.deepEqual(ids(store.listSandboxes({ binding: { labels: { team: 'a"' } } })), []);

    const askA = store.createAsk({ sandboxId: a1.id, kind: 'question', title: 'a?' });
    clock.advance(1);
    const askB = store.createAsk({ sandboxId: b1.id, kind: 'question', title: 'b?' });
    const askIds = (rows) => rows.map((x) => x.id);
    assert.deepEqual(askIds(store.listAsks({ binding: teamA })), [askA.id]);
    assert.deepEqual(askIds(store.listAsks({ binding: { sandboxIds: [b1.id] } })), [askB.id]);
    assert.deepEqual(store.listAsks({ binding: teamA, sandboxId: b1.id }), []);
    assert.equal(store.listAsks({}).length, 2);

    assert.deepEqual(bindingFilter(null), { sql: '1', params: [] });
    assert.equal(Store.bindingFilter, bindingFilter);
    const f = bindingFilter(
      { sandboxIds: ['x'], labels: { team: 'a' } },
      { sandboxColumn: 'sandbox_id' },
    );
    assert.match(f.sql, /^sandbox_id IN \(SELECT sandboxes\.id FROM sandboxes WHERE /);
    assert.deepEqual(f.params, ['x', 'team', 'a']);
  } finally {
    cleanup();
  }
});
