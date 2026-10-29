import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import {
  verifyWebhook,
  WebhookVerificationError,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_TOLERANCE_SECONDS,
} from '../../src/webhooks.js';

const VECTOR = Object.freeze({
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  headers: {
    'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
    'webhook-timestamp': '1614265330',
    'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
  },
  body: '{"test": 2432232314}',
  now: 1614265330 * 1000,
});

const refused = (re) => (e) =>
  e instanceof WebhookVerificationError && e.code === 'E_WEBHOOK_INVALID' && re.test(e.message);

/** A request signed like Workbox signs one, with a fresh secret. */
function signed(body, at = Date.now()) {
  const key = randomBytes(24);
  const secret = `${WEBHOOK_SECRET_PREFIX}${key.toString('base64')}`;
  const id = 'msg_01TESTTESTTESTTESTTESTTEST';
  const timestamp = String(Math.floor(at / 1000));
  const mac = createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
  return {
    secret,
    headers: { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${mac}` },
  };
}

test('the Standard Webhooks example vector verifies and returns the parsed body', () => {
  assert.deepEqual(verifyWebhook(VECTOR.secret, VECTOR.headers, VECTOR.body, VECTOR), {
    test: 2432232314,
  });
  assert.deepEqual(
    verifyWebhook(VECTOR.secret, new Headers(VECTOR.headers), Buffer.from(VECTOR.body), VECTOR),
    { test: 2432232314 },
    'Headers objects and byte bodies work too',
  );
  const upper = Object.fromEntries(
    Object.entries(VECTOR.headers).map(([k, v]) => [k.toUpperCase(), [v]]),
  );
  assert.deepEqual(verifyWebhook(VECTOR.secret, upper, VECTOR.body, VECTOR), {
    test: 2432232314,
  });
  const several = {
    ...VECTOR.headers,
    'webhook-signature': `v2,abc v1,${Buffer.alloc(32).toString('base64')} v1,short ${VECTOR.headers['webhook-signature']}`,
  };
  assert.deepEqual(verifyWebhook(VECTOR.secret, several, VECTOR.body, VECTOR), {
    test: 2432232314,
  });
});

test('a wrong signature, secret, body or id is refused', () => {
  const { secret, headers } = signed('{"type":"session.exited"}');
  assert.deepEqual(verifyWebhook(secret, headers, '{"type":"session.exited"}'), {
    type: 'session.exited',
  });
  const noMatch = refused(/no webhook-signature matches/);
  assert.throws(() => verifyWebhook(secret, headers, '{"type":"session.exited" }'), noMatch);
  assert.throws(() => verifyWebhook(VECTOR.secret, headers, '{"type":"session.exited"}'), noMatch);
  assert.throws(
    () =>
      verifyWebhook(secret, { ...headers, 'webhook-id': 'msg_other' }, '{"type":"session.exited"}'),
    noMatch,
  );
  const flipped = headers['webhook-signature'].replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.throws(
    () =>
      verifyWebhook(
        secret,
        { ...headers, 'webhook-signature': flipped },
        '{"type":"session.exited"}',
      ),
    noMatch,
  );
  assert.throws(
    () =>
      verifyWebhook(
        secret,
        { ...headers, 'webhook-signature': 'v2,whatever' },
        '{"type":"session.exited"}',
      ),
    noMatch,
  );
});

test('a timestamp outside the window is refused, inside it is accepted', () => {
  const at = Date.now() - (WEBHOOK_TOLERANCE_SECONDS + 60) * 1000;
  const { secret, headers } = signed('{}', at);
  assert.equal(WEBHOOK_TOLERANCE_SECONDS, 300);
  assert.throws(() => verifyWebhook(secret, headers, '{}'), refused(/outside the tolerance/));
  assert.deepEqual(verifyWebhook(secret, headers, '{}', { toleranceSeconds: 600 }), {});
  assert.deepEqual(verifyWebhook(secret, headers, '{}', { now: at + 1000 }), {});
  assert.throws(
    () => verifyWebhook(secret, headers, '{}', { now: at - 400_000 }),
    refused(/outside the tolerance/),
    'a timestamp from the future is refused as well',
  );
  assert.throws(
    () => verifyWebhook(secret, { ...headers, 'webhook-timestamp': '12e3' }, '{}'),
    refused(/not a unix time/),
  );
});

test('missing headers, a malformed secret and a body that is not JSON are refused', () => {
  const { secret, headers } = signed('not json');
  assert.throws(() => verifyWebhook(secret, headers, 'not json'), refused(/body is not JSON/));
  for (const name of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) {
    const partial = { ...headers };
    delete partial[name];
    assert.throws(() => verifyWebhook(secret, partial, 'not json'), refused(/missing/), name);
  }
  assert.throws(() => verifyWebhook(secret, undefined, '{}'), refused(/missing/));
  for (const bad of ['MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'whsec_', undefined])
    assert.throws(() => verifyWebhook(bad, headers, 'not json'), refused(/secret/), String(bad));
});
