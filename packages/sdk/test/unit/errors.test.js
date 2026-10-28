import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkboxApiError } from '../../src/errors.js';

test('error carries status/code/details and retryable flag', async () => {
  const res = new Response(
    JSON.stringify({ error: { code: 'E_TIMEOUT', message: 'slow', details: { a: 1 } } }),
    {
      status: 504,
      headers: { 'content-type': 'application/json' },
    },
  );
  const e = await WorkboxApiError.fromResponse(res);
  assert.equal(e.status, 504);
  assert.equal(e.code, 'E_TIMEOUT');
  assert.deepEqual(e.details, { a: 1 });
  assert.equal(e.retryable, true);
  const plain = new WorkboxApiError({ status: 400, code: 'E_INVALID_PARAMS', message: 'bad' });
  assert.equal(plain.retryable, false);
});
