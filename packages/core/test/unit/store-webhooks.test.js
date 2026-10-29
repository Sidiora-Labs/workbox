import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, SCHEMA_VERSION } from '../../src/store.js';
import { tmpDir, fakeClock } from '../helpers/tmp.js';

const base = { rootfs: 'minimal', runtime: 'current', profile: {} };
const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const SECRET = 'whsec_c3RvcmUtdGVzdC1rZXktMjQtYnl0ZXMhIQ==';

function openTmp() {
  const t = tmpDir();
  const clock = fakeClock();
  const file = path.join(t.dir, 'workbox.db');
  const store = Store.open(file, { clock });
  return { store, clock, file, cleanup: () => (store.close(), t.cleanup()) };
}

const event = (seq, type = 'webhook.test') => ({
  seq,
  sandboxId: null,
  type,
  source: 'host',
  payload: {},
  causation: null,
  at: 1,
});

test('a v3 database migrates to v4 with empty webhook tables and its rows intact', () => {
  const t = tmpDir();
  try {
    const file = path.join(t.dir, 'workbox.db');
    const clock = fakeClock();
    const v3 = new Store(new DatabaseSync(file), file, clock);
    v3.db.exec('PRAGMA journal_mode = WAL');
    v3.migrate(3);
    assert.equal(v3.schemaVersion, 3);
    const tables = `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'webhook%' ORDER BY name`;
    assert.deepEqual(v3.db.prepare(tables).all(), []);
    const key = v3.createApiKey({ name: 'k', tokenSha256: digest(), scopes: ['read'] });
    const seq = v3.appendEvent('sb', 'session.exited', { code: 0 });
    v3.close();

    const store = Store.open(file, { clock });
    assert.equal(SCHEMA_VERSION, 4);
    assert.equal(store.schemaVersion, 4);
    assert.deepEqual(
      store.db
        .prepare(tables)
        .all()
        .map((r) => r.name),
      ['webhook_deliveries', 'webhooks'],
    );
    assert.equal(store.getApiKey(key.id).name, 'k');
    assert.equal(store.getEvent(seq).type, 'session.exited');
    assert.deepEqual(store.listWebhooks(), []);
    store.close();
  } finally {
    t.cleanup();
  }
});

test('webhooks are created at the newest event, read, listed, changed and deleted', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    store.appendEvent('sb', 'a.b', {});
    const seq = store.appendEvent('sb', 'a.c', {});
    const w = store.createWebhook({
      url: 'https://hooks.example/a',
      secret: SECRET,
      types: ['session.*'],
      sandboxId: 'sb',
      labels: { team: 'a' },
      description: 'builds',
      ownerKey: 'key_1',
      binding: { labels: { team: 'a' } },
    });
    assert.match(w.id, /^wh_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.deepEqual(w, {
      id: w.id,
      url: 'https://hooks.example/a',
      types: ['session.*'],
      sandboxId: 'sb',
      labels: { team: 'a' },
      description: 'builds',
      enabled: true,
      disabledReason: null,
      ownerKey: 'key_1',
      binding: { labels: { team: 'a' } },
      lastSeq: seq,
      createdAt: clock(),
      updatedAt: clock(),
    });
    assert.equal(JSON.stringify(w).includes(SECRET), false, 'rows never carry the secret');
    assert.equal(store.getWebhookSecret(w.id), SECRET);
    assert.equal(store.getWebhookSecret('wh_none'), null);
    assert.equal(store.getWebhook('wh_none'), null);
    clock.advance(10);
    const bare = store.createWebhook({ url: 'https://hooks.example/b', secret: SECRET });
    assert.deepEqual(
      [bare.types, bare.sandboxId, bare.labels, bare.ownerKey, bare.binding],
      [[], null, null, null, null],
    );
    assert.deepEqual(
      store.listWebhooks().map((x) => x.id),
      [w.id, bare.id],
    );
    assert.deepEqual(
      store.listWebhooks({ ownerKey: 'key_1' }).map((x) => x.id),
      [w.id],
    );
    assert.deepEqual(
      store.listWebhooks({ after: w.id }).map((x) => x.id),
      [bare.id],
    );
    assert.equal(store.listWebhooks({ limit: 1 }).length, 1);

    clock.advance(10);
    const off = store.updateWebhook(w.id, { enabled: false, disabledReason: 'gone' });
    assert.equal(off.enabled, false);
    assert.equal(off.disabledReason, 'gone');
    assert.equal(off.updatedAt, clock());
    const changed = store.updateWebhook(w.id, {
      url: 'https://hooks.example/c',
      types: ['exec.finished'],
      description: null,
      enabled: true,
      secret: `${SECRET}x`,
    });
    assert.equal(changed.url, 'https://hooks.example/c');
    assert.deepEqual(changed.types, ['exec.finished']);
    assert.equal(changed.description, null);
    assert.equal(changed.enabled, true);
    assert.equal(changed.disabledReason, null, 'enabling clears the reason');
    assert.equal(store.getWebhookSecret(w.id), `${SECRET}x`);
    assert.equal(store.updateWebhook(w.id, { enabled: false }).disabledReason, null);
    for (const bad of [{ types: 'x' }, { types: [''] }])
      assert.throws(
        () => store.updateWebhook(w.id, bad),
        (e) => e.code === 'E_INVALID_PARAMS',
      );
    assert.throws(
      () => store.updateWebhook('wh_none', { enabled: true }),
      (e) => e.code === 'E_NOT_FOUND',
    );
    for (const bad of [
      { secret: SECRET },
      { url: 'https://x/' },
      { url: 'https://x/', secret: '' },
      { url: 'https://x/', secret: SECRET, types: [7] },
    ])
      assert.throws(
        () => store.createWebhook(bad),
        (e) => e.code === 'E_INVALID_PARAMS',
      );

    store.queueWebhookDelivery(w.id, event(null));
    assert.equal(store.deleteWebhook(w.id).id, w.id);
    assert.equal(store.getWebhook(w.id), null);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS n FROM webhook_deliveries').get().n,
      0,
      'its deliveries went with it',
    );
    assert.throws(
      () => store.deleteWebhook(w.id),
      (e) => e.code === 'E_NOT_FOUND',
    );
  } finally {
    cleanup();
  }
});

test('events are queued once per matching webhook and the cursor advances in batches', () => {
  const { store, cleanup } = openTmp();
  try {
    const a = store.createSandbox({ ...base, labels: { team: 'a', tier: 'x' } });
    const b = store.createSandbox({ ...base, labels: { team: 'b' } });
    const all = store.createWebhook({ url: 'https://h/all', secret: SECRET });
    const typed = store.createWebhook({ url: 'https://h/t', secret: SECRET, types: ['exec.*'] });
    const labelled = store.createWebhook({
      url: 'https://h/l',
      secret: SECRET,
      labels: { team: 'a', tier: 'x' },
    });
    const boundIds = store.createWebhook({
      url: 'https://h/bi',
      secret: SECRET,
      binding: { sandboxIds: [b.id] },
    });
    const boundNone = store.createWebhook({ url: 'https://h/bn', secret: SECRET, binding: {} });
    const seqs = [
      store.appendEvent(a.id, 'exec.finished', {}),
      store.appendEvent(b.id, 'session.exited', {}),
      store.appendEvent(a.id, 'ask.raised', {}),
      store.appendEvent(b.id, 'exec.finished', {}),
      store.appendEvent('gone', 'exec.finished', {}),
    ];
    const queued = (id) =>
      store
        .listWebhookDeliveries(id)
        .items.map((d) => d.eventSeq)
        .sort((x, y) => x - y);

    assert.deepEqual(store.enqueueWebhookEvents(all.id, { limit: 2 }), { queued: 2, more: true });
    assert.equal(store.getWebhook(all.id).lastSeq, seqs[1]);
    assert.deepEqual(store.enqueueWebhookEvents(all.id, { limit: 2 }), { queued: 2, more: true });
    assert.deepEqual(store.enqueueWebhookEvents(all.id, { limit: 2 }), { queued: 1, more: false });
    assert.deepEqual(store.enqueueWebhookEvents(all.id), { queued: 0, more: false });
    assert.deepEqual(queued(all.id), seqs);
    assert.deepEqual(store.enqueueWebhookEvents(typed.id), { queued: 3, more: false });
    assert.deepEqual(queued(typed.id), [seqs[0], seqs[3], seqs[4]]);
    store.enqueueWebhookEvents(labelled.id);
    assert.deepEqual(queued(labelled.id), [seqs[0], seqs[2]]);
    store.enqueueWebhookEvents(boundIds.id);
    assert.deepEqual(queued(boundIds.id), [seqs[1], seqs[3]]);
    assert.deepEqual(store.enqueueWebhookEvents(boundNone.id), { queued: 0, more: false });
    assert.equal(store.getWebhook(boundNone.id).lastSeq, seqs[4], 'skipped events move it too');
    assert.deepEqual(store.enqueueWebhookEvents('wh_none'), { queued: 0, more: false });

    store.db.prepare('UPDATE webhooks SET last_seq = 0 WHERE id = ?').run(all.id);
    assert.deepEqual(
      store.enqueueWebhookEvents(all.id),
      { queued: 0, more: false },
      'an event is queued at most once per webhook',
    );
    const [one] = store.listWebhookDeliveries(all.id, { limit: 1 }).items;
    assert.deepEqual(one.event, store.getEvent(one.eventSeq));
    store.pruneEvents(Number.MAX_SAFE_INTEGER);
    assert.deepEqual(
      store.getWebhookDelivery(one.id).event.seq,
      one.eventSeq,
      'the snapshot outlives the event log row',
    );
  } finally {
    cleanup();
  }
});

test('due deliveries are claimed under a lease, recorded, paged and retried', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const w = store.createWebhook({ url: 'https://h/a', secret: SECRET, ownerKey: 'cfg' });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      ids.push(store.queueWebhookDelivery(w.id, event(null)).id);
      clock.advance(1);
    }
    assert.throws(
      () => store.queueWebhookDelivery('wh_none', event(null)),
      (e) => e.code === 'E_NOT_FOUND',
    );
    const real = store.queueWebhookDelivery(w.id, event(42, 'build.done'));
    assert.equal(real.eventSeq, 42);
    assert.equal(store.getWebhookDelivery(ids[0]).eventSeq, null);
    assert.equal(store.nextWebhookDeliveryAt(), clock() - 3);

    const claimed = store.claimWebhookDeliveries({ limit: 2, leaseMs: 1000 });
    assert.deepEqual(
      claimed.map((d) => d.id),
      ids.slice(0, 2),
    );
    assert.equal(store.getWebhookDelivery(ids[0]).nextAt, clock() + 1000);
    assert.deepEqual(
      store.claimWebhookDeliveries({ limit: 10, leaseMs: 1000 }).map((d) => d.id),
      [ids[2], real.id],
    );
    assert.deepEqual(store.claimWebhookDeliveries({ limit: 10, leaseMs: 1000 }), []);
    assert.equal(store.nextWebhookDeliveryAt(), clock() + 1000);

    clock.advance(5);
    const delivered = store.recordWebhookAttempt(ids[0], { status: 'delivered', lastStatus: 200 });
    assert.deepEqual(
      [delivered.status, delivered.attempts, delivered.nextAt, delivered.deliveredAt],
      ['delivered', 1, null, clock()],
    );
    const retry = store.recordWebhookAttempt(ids[1], {
      status: 'pending',
      nextAt: clock() + 50,
      lastStatus: 500,
      lastError: 'boom',
    });
    assert.deepEqual(
      [retry.status, retry.attempts, retry.nextAt, retry.lastError, retry.deliveredAt],
      ['pending', 1, clock() + 50, 'boom', null],
    );
    const failed = store.recordWebhookAttempt(ids[2], { status: 'failed', lastError: 'refused' });
    assert.deepEqual([failed.status, failed.nextAt, failed.lastStatus], ['failed', null, null]);
    assert.throws(
      () => store.recordWebhookAttempt(ids[2], { status: 'odd' }),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    assert.throws(
      () => store.recordWebhookAttempt('msg_none', { status: 'failed' }),
      (e) => e.code === 'E_NOT_FOUND',
    );

    const page1 = store.listWebhookDeliveries(w.id, { limit: 2 });
    assert.deepEqual(
      page1.items.map((d) => d.id),
      [real.id, ids[2]],
      'newest first',
    );
    assert.equal(page1.complete, false);
    const page2 = store.listWebhookDeliveries(w.id, { limit: 2, cursor: page1.cursor });
    assert.deepEqual(
      page2.items.map((d) => d.id),
      [ids[1], ids[0]],
    );
    assert.equal(page2.complete, true);
    assert.equal(page2.cursor, null);
    assert.deepEqual(
      store.listWebhookDeliveries(w.id, { status: 'failed' }).items.map((d) => d.id),
      [ids[2]],
    );
    assert.throws(
      () => store.listWebhookDeliveries(w.id, { status: 'odd' }),
      (e) => e.code === 'E_INVALID_PARAMS',
    );

    const again = store.retryWebhookDelivery(ids[2]);
    assert.deepEqual([again.status, again.nextAt, again.attempts], ['pending', clock(), 1]);
    assert.throws(
      () => store.retryWebhookDelivery('msg_none'),
      (e) => e.code === 'E_NOT_FOUND',
    );
  } finally {
    cleanup();
  }
});

test('disabled webhooks and those of revoked or expired stored keys are not active', () => {
  const { store, clock, cleanup } = openTmp();
  try {
    const live = store.createApiKey({ name: 'live', tokenSha256: digest(), scopes: ['admin'] });
    const revoked = store.createApiKey({ name: 'rev', tokenSha256: digest(), scopes: ['admin'] });
    const expiring = store.createApiKey({
      name: 'exp',
      tokenSha256: digest(),
      scopes: ['admin'],
      ttlMs: 100,
    });
    const make = (ownerKey) => store.createWebhook({ url: 'https://h/', secret: SECRET, ownerKey });
    const byConfigKey = make('root');
    const byLive = make(live.id);
    const byRevoked = make(revoked.id);
    const byExpiring = make(expiring.id);
    const disabled = make(null);
    store.updateWebhook(disabled.id, { enabled: false });
    for (const w of [byConfigKey, byLive, byRevoked, byExpiring, disabled])
      store.queueWebhookDelivery(w.id, event(null));
    const active = () =>
      store
        .listActiveWebhooks()
        .map((w) => w.id)
        .sort();
    assert.deepEqual(active(), [byConfigKey.id, byLive.id, byRevoked.id, byExpiring.id].sort());
    store.revokeApiKey(revoked.id);
    clock.advance(100);
    assert.deepEqual(active(), [byConfigKey.id, byLive.id].sort());
    assert.deepEqual(
      store
        .claimWebhookDeliveries({ limit: 10, leaseMs: 10 })
        .map((d) => d.webhookId)
        .sort(),
      [byConfigKey.id, byLive.id].sort(),
    );
    assert.equal(store.nextWebhookDeliveryAt(), clock() + 10);
  } finally {
    cleanup();
  }
});
