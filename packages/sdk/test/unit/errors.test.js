import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkboxApiError } from '../../src/errors.js';

test('error carries status/code/details and retryable flag', async () => {
  const res = new Response(
    JSON.stringify({ error: { code: 'E_TIMEOUT', message: 'slow', details: { a: 1 } } }),
    {
      status: 504,
      headers: { 'content-type': 'application/json', 'x-request-id': 'r-9' },
    },
  );
  const e = await WorkboxApiError.fromResponse(res);
  assert.equal(e.status, 504);
  assert.equal(e.code, 'E_TIMEOUT');
  assert.deepEqual(e.details, { a: 1 });
  assert.equal(e.requestId, 'r-9');
  assert.equal(e.retryable, true);
  const plain = new WorkboxApiError({ status: 400, code: 'E_INVALID_PARAMS', message: 'bad' });
  assert.equal(plain.retryable, false);
  assert.equal(new WorkboxApiError({ status: 429, code: 'E_LIMIT', message: 'x' }).retryable, true);
  const pinned = new WorkboxApiError({ status: 0, code: 'E_X', message: 'x', retryable: false });
  assert.equal(pinned.retryable, false);
});

test('a non-JSON error body falls back to the HTTP status', async () => {
  const e = await WorkboxApiError.fromResponse(new Response('bad gateway', { status: 502 }));
  assert.equal(e.code, 'E_INTERNAL');
  assert.equal(e.message, 'HTTP 502');
  assert.equal(e.retryable, true);
});

test('a transport failure is status 0, retryable and keeps its cause', () => {
  const cause = new TypeError('fetch failed', { cause: new Error('other side closed') });
  const e = WorkboxApiError.transport(cause, 'GET /v1/asks');
  assert.equal(e.status, 0);
  assert.equal(e.code, 'E_UNAVAILABLE');
  assert.equal(e.message, 'GET /v1/asks failed: other side closed');
  assert.equal(e.cause, cause);
  assert.equal(e.retryable, true);
});
