import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  WebhookDispatcher,
  MAX_WEBHOOK_ERROR_BYTES,
  WEBHOOK_SECRET_BYTES,
  WEBHOOK_USER_AGENT,
  newWebhookSecret,
  nextAttemptAt,
  signWebhook,
  testEvent,
  webhookBody,
  webhookKey,
} from '../../src/webhooks.js';
import { DEFAULTS } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { receiver, until } from '../helpers/receiver.js';

const LOCAL = { allowPrivate: true, allowHttp: true, timeoutMs: 2000, retryDelaysMs: [30, 30] };

/** An in-memory store, a dispatcher over it and the cleanup of both. */
function rig(config = LOCAL) {
  const store = Store.open(':memory:');
  const dispatcher = new WebhookDispatcher({ store, config, pollMs: 50 });
  return {
    store,
    dispatcher,
    hook: (url, extra = {}) =>
      store.createWebhook({ url, secret: newWebhookSecret(), ownerKey: 'root', ...extra }),
    async close() {
      await dispatcher.stop({ timeoutMs: 500 });
      store.close();
    },
  };
}

const deliveries = (store, id) => store.listWebhookDeliveries(id).items;

test('signing matches the Standard Webhooks example vector', () => {
  assert.equal(
    signWebhook(
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      1614265330,
      '{"test": 2432232314}',
    ),
    'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  );
  assert.equal(
    signWebhook(
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      '1614265330',
      Buffer.from('{"test": 2432232314}'),
    ),
    'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    'a string timestamp and a Buffer body sign the same',
  );
});

test('secrets are whsec_ and 24 random bytes; the key is their base64 decoding', () => {
  const a = newWebhookSecret();
  const b = newWebhookSecret();
  assert.match(a, /^whsec_[A-Za-z0-9+/]{32}$/);
  assert.notEqual(a, b);
  assert.equal(webhookKey(a).length, WEBHOOK_SECRET_BYTES);
  assert.deepEqual(webhookKey(a), Buffer.from(a.slice(6), 'base64'));
  for (const bad of ['MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'whsec_', '', undefined])
    assert.throws(
      () => webhookKey(bad),
      (e) => e.code === 'E_INVALID_PARAMS',
      String(bad),
    );
});

test('the body is {type, timestamp, data} with the event time in ISO-8601', () => {
  const event = {
    seq: 7,
    sandboxId: 'sb',
    type: 'session.exited',
    source: 'host',
    payload: { code: 0 },
    causation: null,
    at: 1_700_000_000_123,
  };
  assert.deepEqual(JSON.parse(webhookBody(event)), {
    type: 'session.exited',
    timestamp: '2023-11-14T22:13:20.123Z',
    data: event,
  });
  assert.deepEqual(testEvent('wh_1', 5), {
    seq: null,
    sandboxId: null,
    type: 'webhook.test',
    source: 'host',
    payload: { webhookId: 'wh_1' },
    causation: null,
    at: 5,
  });
});

test('retry scheduling follows the delays, then stops', () => {
  const delays = DEFAULTS.webhooks.retryDelaysMs;
  assert.deepEqual(
    delays,
    [5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000],
  );
  const now = 1_000;
  assert.equal(nextAttemptAt(1, now, delays), now + 5_000);
  assert.equal(nextAttemptAt(2, now, delays), now + 300_000);
  assert.equal(nextAttemptAt(7, now, delays), now + 36_000_000);
  assert.equal(nextAttemptAt(8, now, delays), null, 'eight attempts in all');
  assert.equal(nextAttemptAt(1, now, []), null, 'no delays: one attempt');
});

test('a delivery is POSTed once, signed, with the headers and body of the event', async () => {
  const r = await receiver([{ status: 204 }]);
  const { store, dispatcher, hook, close } = rig();
  try {
    const w = hook(r.url);
    const seq = store.appendEvent('sb-1', 'session.exited', { sessionId: 's', code: 0 });
    dispatcher.start();
    await until(() => r.hits.length === 1);
    const [hit] = r.hits;
    const d = await until(() => deliveries(store, w.id).find((x) => x.status === 'delivered'));
    assert.equal(hit.method, 'POST');
    assert.equal(hit.url, '/hook');
    assert.equal(hit.headers['content-type'], 'application/json');
    assert.equal(hit.headers['user-agent'], WEBHOOK_USER_AGENT);
    assert.match(WEBHOOK_USER_AGENT, /^Workbox-Webhooks\/\d+\.\d+\.\d+/);
    assert.equal(hit.headers['webhook-id'], d.id);
    assert.match(d.id, /^msg_[0-9A-HJKMNP-TV-Z]{26}$/);
    const ts = Number(hit.headers['webhook-timestamp']);
    assert.ok(Math.abs(ts - Date.now() / 1000) < 5);
    const secret = store.getWebhookSecret(w.id);
    assert.equal(hit.headers['webhook-signature'], signWebhook(secret, d.id, ts, hit.body));
    const body = JSON.parse(hit.body);
    assert.equal(body.type, 'session.exited');
    assert.deepEqual(body.data, store.getEvent(seq));
    assert.equal(body.timestamp, new Date(body.data.at).toISOString());
    assert.equal(d.attempts, 1);
    assert.equal(d.lastStatus, 204);
    assert.equal(typeof d.deliveredAt, 'number');
    assert.equal(hit.body.includes(secret), false);
    assert.equal(JSON.stringify(store.listWebhookDeliveries(w.id)).includes(secret), false);
  } finally {
    await close();
    await r.close();
  }
});

test('a failed attempt is retried with the same webhook-id until the delays run out', async () => {
  const r = await receiver((hit) => {
    if (hit.url !== '/flaky') return { status: 503, body: 'down' };
    return r.at('/flaky').length === 1 ? { status: 500, body: 'boom' } : { status: 200 };
  });
  const { store, dispatcher, hook, close } = rig();
  try {
    const flaky = hook(`http://127.0.0.1:${r.port}/flaky`);
    const down = hook(`http://127.0.0.1:${r.port}/down`);
    store.queueWebhookDelivery(flaky.id, testEvent(flaky.id, store.clock()));
    store.queueWebhookDelivery(down.id, testEvent(down.id, store.clock()));
    dispatcher.start();
    const ok = await until(() => deliveries(store, flaky.id).find((d) => d.status === 'delivered'));
    const [first, second] = r.at('/flaky');
    assert.equal(first.headers['webhook-id'], ok.id);
    assert.equal(second.headers['webhook-id'], ok.id);
    assert.ok(second.at - first.at >= 25, 'the retry waited for its delay');
    assert.equal(ok.attempts, 2);
    assert.equal(ok.lastStatus, 200);
    assert.equal(ok.lastError, null);

    const failed = await until(() => deliveries(store, down.id).find((d) => d.status === 'failed'));
    assert.equal(r.at('/down').length, 3, 'one attempt and two retries');
    assert.equal(failed.attempts, 3);
    assert.equal(failed.lastStatus, 503);
    assert.equal(failed.lastError, 'down');
    assert.equal(failed.nextAt, null);
    assert.equal(store.getWebhook(down.id).enabled, true, 'failing is not disabling');
  } finally {
    await close();
    await r.close();
  }
});

test('410 disables the webhook; redirects and timeouts are failures; long bodies are cut', async () => {
  const big = 'x'.repeat(MAX_WEBHOOK_ERROR_BYTES * 4);
  const r = await receiver((hit) => {
    if (hit.url === '/gone') return { status: 410, body: 'gone' };
    if (hit.url === '/moved') return { status: 302, headers: { location: '/elsewhere' } };
    if (hit.url === '/slow') return 'hang';
    return { status: 500, body: big };
  });
  const { store, dispatcher, hook, close } = rig({ ...LOCAL, timeoutMs: 300, retryDelaysMs: [] });
  try {
    const base = `http://127.0.0.1:${r.port}`;
    const gone = hook(`${base}/gone`);
    const moved = hook(`${base}/moved`);
    const slow = hook(`${base}/slow`);
    const noisy = hook(`${base}/noisy`);
    for (const w of [gone, moved, slow, noisy])
      store.queueWebhookDelivery(w.id, testEvent(w.id, store.clock()));
    dispatcher.start();
    const done = (id) => deliveries(store, id).find((d) => d.status === 'failed');
    const [g, m, s, n] = await until(() => {
      const all = [gone, moved, slow, noisy].map((w) => done(w.id));
      return all.every(Boolean) && all;
    });
    assert.equal(g.lastStatus, 410);
    const disabled = store.getWebhook(gone.id);
    assert.equal(disabled.enabled, false);
    assert.match(disabled.disabledReason, /410/);
    assert.equal(m.lastStatus, 302);
    assert.match(m.lastError, /redirects are not followed/);
    assert.equal(
      r.hits.filter((h) => h.url === '/elsewhere').length,
      0,
      'the redirect was not followed',
    );
    assert.equal(s.lastStatus, null);
    assert.match(s.lastError, /no answer within 300 ms/);
    assert.equal(n.lastStatus, 500);
    assert.equal(Buffer.byteLength(n.lastError), MAX_WEBHOOK_ERROR_BYTES);

    store.appendEvent('sb', 'build.done', {});
    store.queueWebhookDelivery(gone.id, testEvent(gone.id, store.clock()));
    dispatcher.notify();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(r.at('/gone').length, 1, 'a disabled webhook gets nothing');
  } finally {
    await close();
    await r.close();
  }
});

test('at delivery time the target guard runs again and a refused target is a failed attempt', async () => {
  const r = await receiver([{ status: 204 }]);
  const { store, dispatcher, hook, close } = rig({ ...DEFAULTS.webhooks, retryDelaysMs: [] });
  try {
    const w = hook(r.url);
    store.queueWebhookDelivery(w.id, testEvent(w.id, store.clock()));
    dispatcher.start();
    const d = await until(() => deliveries(store, w.id).find((x) => x.status === 'failed'));
    assert.match(d.lastError, /^target refused: the webhook url must use https/);
    assert.equal(d.lastStatus, null);
    assert.equal(r.hits.length, 0);

    const local = hook(`https://127.0.0.1:${r.port}/hook`);
    store.queueWebhookDelivery(local.id, testEvent(local.id, store.clock()));
    dispatcher.notify();
    const refused = await until(() =>
      deliveries(store, local.id).find((x) => x.status === 'failed'),
    );
    assert.match(refused.lastError, /127\.0\.0\.1 resolves to an address that is not public/);
    assert.equal(r.hits.length, 0, 'nothing reached the private address');
  } finally {
    await close();
    await r.close();
  }
});

test('events logged while stopped are delivered after start; filters and owners apply', async () => {
  const r = await receiver([{ status: 200 }]);
  const { store, dispatcher, hook, close } = rig();
  try {
    const a = store.createSandbox({
      rootfs: 'm',
      runtime: 'c',
      profile: {},
      labels: { team: 'a' },
    });
    const b = store.createSandbox({
      rootfs: 'm',
      runtime: 'c',
      profile: {},
      labels: { team: 'b' },
    });
    store.appendEvent(a.id, 'session.exited', { before: true });
    const base = `http://127.0.0.1:${r.port}`;
    const all = hook(`${base}/all`);
    const typed = hook(`${base}/typed`, { types: ['session.*', 'build.done'] });
    const onlyB = hook(`${base}/b`, { sandboxId: b.id });
    const labelled = hook(`${base}/labelled`, { labels: { team: 'a' } });
    const bound = hook(`${base}/bound`, { binding: { sandboxIds: [b.id] } });
    const digest = createHash('sha256').update(randomBytes(32)).digest('hex');
    const key = store.createApiKey({ name: 'k', tokenSha256: digest, scopes: ['admin'] });
    const revoked = hook(`${base}/revoked`, { ownerKey: key.id });
    store.revokeApiKey(key.id);
    const expiring = store.createApiKey({
      name: 'e',
      tokenSha256: createHash('sha256').update(randomBytes(32)).digest('hex'),
      scopes: ['admin'],
      expiresAt: store.clock() - 1,
    });
    const expired = hook(`${base}/expired`, { ownerKey: expiring.id });

    const seqs = [
      store.appendEvent(a.id, 'session.exited', { n: 1 }),
      store.appendEvent(b.id, 'exec.finished', { n: 2 }),
      store.appendEvent(b.id, 'build.done', { n: 3 }),
      store.appendEvent(a.id, 'sessionx.other', { n: 4 }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(r.hits.length, 0, 'nothing is sent before start');
    dispatcher.start();
    await until(() => r.at('/all').length === 4 && r.at('/typed').length === 2);
    await until(() => store.nextWebhookDeliveryAt() === null && dispatcher.busy === 0);
    const got = (path) =>
      r
        .at(path)
        .map((h) => JSON.parse(h.body).data.seq)
        .sort((x, y) => x - y);
    assert.deepEqual(got('/all'), seqs, 'the event logged before the webhook is not sent');
    assert.deepEqual(got('/typed'), [seqs[0], seqs[2]], 'session.* does not match sessionx.');
    assert.deepEqual(got('/b'), [seqs[1], seqs[2]]);
    assert.deepEqual(got('/labelled'), [seqs[0], seqs[3]]);
    assert.deepEqual(got('/bound'), [seqs[1], seqs[2]]);
    assert.deepEqual(got('/revoked'), [], 'a revoked owner gets nothing');
    assert.deepEqual(got('/expired'), [], 'an expired owner gets nothing');
    assert.equal(store.getWebhook(revoked.id).lastSeq, 1, 'its cursor did not move');
    assert.equal(store.getWebhook(expired.id).lastSeq, 1);
    for (const w of [all, typed, onlyB, labelled, bound])
      assert.equal(store.getWebhook(w.id).lastSeq, seqs[3], w.url);
    const ids = new Set(r.hits.map((h) => h.headers['webhook-id']));
    assert.equal(ids.size, r.hits.length, 'every delivery has its own id');
  } finally {
    await close();
    await r.close();
  }
});

test('stop waits for attempts in flight, then cuts stragglers without recording them', async () => {
  const r = await receiver((hit) => (hit.url === '/hang' ? 'hang' : { status: 204 }));
  const { store, dispatcher, hook, close } = rig({ ...LOCAL, concurrency: 1 });
  try {
    const hang = hook(`http://127.0.0.1:${r.port}/hang`);
    const later = hook(`http://127.0.0.1:${r.port}/later`);
    const d = store.queueWebhookDelivery(hang.id, testEvent(hang.id, store.clock()));
    dispatcher.start();
    await until(() => r.at('/hang').length === 1);
    store.queueWebhookDelivery(later.id, testEvent(later.id, store.clock()));
    dispatcher.notify();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(r.at('/later').length, 0, 'concurrency 1: the second waits for the first');
    const started = Date.now();
    await dispatcher.stop({ timeoutMs: 200 });
    assert.ok(Date.now() - started < 1500);
    const row = store.getWebhookDelivery(d.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 0, 'the cut attempt was not recorded');
    assert.ok(row.nextAt > Date.now(), 'it stays leased, to be sent again later');
    assert.equal(dispatcher.busy, 0);
    dispatcher.notify();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(r.at('/later').length, 0, 'a stopped dispatcher sends nothing');
  } finally {
    await close();
    await r.close();
  }
});
