import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, Store, newWebhookSecret } from '@workbox/core';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  ownedWebhook,
  queueTestDelivery,
  retryDelivery,
  rotateWebhookSecret,
  updateWebhook,
  webhookHandlers,
  webhookVisible,
  DELIVERY_STATUSES,
  WEBHOOK_CREATE_SCHEMA,
  WEBHOOK_TYPE_PATTERN,
  WEBHOOK_UPDATE_SCHEMA,
} from '../../src/webhooks.js';
import { BODY_SCHEMAS } from '../../src/server.js';
import { SCOPE_MATRIX, FLEET_ROUTES } from '../../src/auth.js';

const LOCAL = { ...DEFAULTS.webhooks, allowPrivate: true, allowHttp: true };
const base = { rootfs: 'minimal', runtime: 'current', profile: {} };
const root = Object.freeze({ id: 'root', binding: null });
const notFound = (re) => (e) => e.code === 'E_NOT_FOUND' && re.test(e.message);
const invalid = (re) => (e) => e.code === 'E_INVALID_PARAMS' && re.test(e.message);

function fixture() {
  const store = Store.open(':memory:');
  const a = store.createSandbox({ ...base, labels: { team: 'a' } });
  const b = store.createSandbox({ ...base, labels: { team: 'b' } });
  const teamA = Object.freeze({ id: 'key_a', binding: { labels: { team: 'a' } } });
  const teamB = Object.freeze({ id: 'key_b', binding: { sandboxIds: [b.id] } });
  return { store, a, b, teamA, teamB, close: () => store.close() };
}

test('the webhook routes are in the scope matrix, with bodies and outside the fleet routes', () => {
  const routes = Object.keys(SCOPE_MATRIX).filter((k) => k.includes('/v1/webhooks'));
  assert.deepEqual(routes, [
    'POST /v1/webhooks',
    'GET /v1/webhooks',
    'GET /v1/webhooks/:webhookId',
    'PATCH /v1/webhooks/:webhookId',
    'DELETE /v1/webhooks/:webhookId',
    'POST /v1/webhooks/:webhookId/rotate-secret',
    'POST /v1/webhooks/:webhookId/test',
    'GET /v1/webhooks/:webhookId/deliveries',
    'POST /v1/webhooks/:webhookId/deliveries/:deliveryId/retry',
  ]);
  for (const r of routes) {
    assert.equal(SCOPE_MATRIX[r], r.startsWith('GET ') ? 'read' : 'admin', r);
    assert.equal(FLEET_ROUTES.includes(r), false, r);
  }
  assert.equal(BODY_SCHEMAS['POST /v1/webhooks'], WEBHOOK_CREATE_SCHEMA);
  assert.equal(BODY_SCHEMAS['PATCH /v1/webhooks/:webhookId'], WEBHOOK_UPDATE_SCHEMA);
  assert.deepEqual(Object.keys(webhookHandlers(null, {})).sort(), [...routes].sort());
  for (const t of ['session.exited', 'session.*', 'build.done', 'my-tool.step_2'])
    assert.match(t, WEBHOOK_TYPE_PATTERN, t);
  for (const t of ['*', 'Session.exited', '.x', 'a.*.b', 'a b'])
    assert.doesNotMatch(t, WEBHOOK_TYPE_PATTERN, t);
  assert.deepEqual(DELIVERY_STATUSES, ['pending', 'delivered', 'failed']);
});

test('create checks the body and the target, records the owner and returns the secret once', async () => {
  const { store, a, b, teamA, close } = fixture();
  try {
    const w = await createWebhook(
      store,
      {
        url: 'http://localhost:9/hook',
        types: ['session.exited', 'session.exited', 'exec.*'],
        labels: { role: 'ci' },
        description: 'builds',
      },
      teamA,
      LOCAL,
    );
    assert.match(w.secret, /^whsec_[A-Za-z0-9+/]{32}$/);
    assert.equal(store.getWebhookSecret(w.id), w.secret);
    assert.equal(w.url, 'http://localhost:9/hook');
    assert.deepEqual(w.types, ['session.exited', 'exec.*']);
    assert.deepEqual(w.labels, { role: 'ci' });
    assert.equal(w.ownerKey, 'key_a');
    assert.deepEqual(w.binding, { labels: { team: 'a' } });
    assert.equal(JSON.stringify(ownedWebhook(store, teamA, w.id)).includes(w.secret), false);
    assert.equal(JSON.stringify(listWebhooks(store, root)).includes(w.secret), false);

    const own = await createWebhook(store, { url: 'https://8.8.8.8/x', sandboxId: a.id }, teamA);
    assert.equal(own.sandboxId, a.id);
    await assert.rejects(
      createWebhook(store, { url: 'https://8.8.8.8/x', sandboxId: b.id }, teamA),
      notFound(new RegExp(`sandbox ${b.id} not found`)),
    );
    await assert.rejects(
      createWebhook(store, { url: 'https://8.8.8.8/x', sandboxId: 'sb-none' }, root),
      notFound(/sandbox sb-none not found/),
    );
    for (const url of ['https://127.0.0.1/x', 'https://localhost/x', 'https://[::1]/x'])
      await assert.rejects(createWebhook(store, { url }, root), invalid(/is not public/), url);
    await assert.rejects(
      createWebhook(store, { url: 'http://8.8.8.8/x' }, root, DEFAULTS.webhooks),
      invalid(/must use https/),
    );
    for (const body of [
      {},
      { url: '' },
      { url: 'https://8.8.8.8/', types: ['*'] },
      { url: 'https://8.8.8.8/', extra: 1 },
      { url: 'https://8.8.8.8/', description: 'x'.repeat(1025) },
    ])
      await assert.rejects(
        createWebhook(store, body, root),
        invalid(/^invalid /),
        JSON.stringify(body),
      );
  } finally {
    close();
  }
});

test('a bound principal sees and manages only its own webhooks; unbound ones see all', async () => {
  const { store, teamA, teamB, close } = fixture();
  try {
    const mine = await createWebhook(store, { url: 'https://8.8.8.8/a' }, teamA);
    const theirs = await createWebhook(store, { url: 'https://8.8.8.8/b' }, teamB);
    const admins = await createWebhook(store, { url: 'https://8.8.8.8/r' }, root);
    const ids = (principal) => listWebhooks(store, principal).webhooks.map((w) => w.id);
    assert.deepEqual(ids(teamA), [mine.id]);
    assert.deepEqual(ids(teamB), [theirs.id]);
    assert.deepEqual(ids(root).sort(), [mine.id, theirs.id, admins.id].sort());
    assert.equal(webhookVisible(teamA, mine), true);
    assert.equal(webhookVisible(teamA, theirs), false);
    assert.equal(webhookVisible(root, theirs), true);
    assert.equal(webhookVisible(null, mine), false);
    assert.equal(webhookVisible(root, null), false);

    const hidden = notFound(new RegExp(`webhook ${theirs.id} not found`));
    assert.throws(() => ownedWebhook(store, teamA, theirs.id), hidden);
    await assert.rejects(updateWebhook(store, theirs.id, { enabled: false }, teamA), hidden);
    assert.throws(() => rotateWebhookSecret(store, theirs.id, teamA), hidden);
    assert.throws(() => queueTestDelivery(store, theirs.id, teamA), hidden);
    assert.throws(() => listDeliveries(store, theirs.id, teamA), hidden);
    assert.throws(() => retryDelivery(store, theirs.id, 'msg_x', teamA), hidden);
    assert.throws(() => deleteWebhook(store, theirs.id, teamA), hidden);
    assert.throws(() => ownedWebhook(store, root, 'wh_none'), notFound(/webhook wh_none/));
    assert.equal(store.getWebhook(theirs.id).enabled, true, 'untouched');

    const rotated = rotateWebhookSecret(store, mine.id, teamA);
    assert.notEqual(rotated.secret, mine.secret);
    assert.equal(store.getWebhookSecret(mine.id), rotated.secret);
    const test1 = queueTestDelivery(store, mine.id, teamA);
    assert.equal(test1.event.type, 'webhook.test');
    assert.equal(test1.eventSeq, null);
    assert.deepEqual(test1.event.payload, { webhookId: mine.id });
    assert.deepEqual(
      listDeliveries(store, mine.id, teamA, { status: 'pending' }).items.map((d) => d.id),
      [test1.id],
    );
    assert.throws(
      () => listDeliveries(store, mine.id, teamA, { status: 'odd' }),
      invalid(/status must be one of/),
    );
    store.recordWebhookAttempt(test1.id, { status: 'failed', lastError: 'x' });
    assert.equal(retryDelivery(store, mine.id, test1.id, teamA).status, 'pending');
    const other = queueTestDelivery(store, admins.id, root);
    assert.throws(
      () => retryDelivery(store, mine.id, other.id, teamA),
      notFound(new RegExp(`delivery ${other.id} not found`)),
      'a delivery of another webhook is not found under this one',
    );

    const off = await updateWebhook(
      store,
      mine.id,
      { enabled: false, description: 'paused' },
      teamA,
    );
    assert.deepEqual([off.enabled, off.description], [false, 'paused']);
    const moved = await updateWebhook(
      store,
      mine.id,
      { url: 'http://localhost:1/new', types: ['a.*', 'a.*'], enabled: true, description: null },
      teamA,
      LOCAL,
    );
    assert.deepEqual(
      [moved.url, moved.types, moved.enabled, moved.description],
      ['http://localhost:1/new', ['a.*'], true, null],
    );
    await assert.rejects(
      updateWebhook(store, mine.id, { url: 'https://localhost/x' }, teamA),
      invalid(/is not public/),
    );
    await assert.rejects(
      updateWebhook(store, mine.id, { secret: newWebhookSecret() }, teamA),
      invalid(/^invalid /),
      'the secret is changed only by rotate',
    );
    assert.equal(deleteWebhook(store, mine.id, teamA).id, mine.id);
    assert.deepEqual(ids(teamA), []);
  } finally {
    close();
  }
});
