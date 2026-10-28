import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkboxClient } from '../../src/client.js';

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('client sends auth, maps routes, retries idempotent 5xx only', async () => {
  const calls = [];
  let failFirst = true;
  const client = new WorkboxClient({
    baseUrl: 'http://x.test/',
    token: 'tok',
    retryDelayMs: 1,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (failFirst && String(url).includes('/v1/sandboxes')) {
        failFirst = false;
        return jsonRes({ error: { code: 'E_UNAVAILABLE', message: 'down' } }, 503);
      }
      if (String(url).endsWith('/v1/sandboxes') && init.method === 'GET')
        return jsonRes({ items: [], cursor: null, complete: true });
      if (init.method === 'POST' && String(url).endsWith('/v1/sandboxes'))
        return jsonRes({ id: 'sb-1', state: 'READY' }, 201);
      return jsonRes({ ok: true });
    },
  });
  const list = await client.listSandboxes();
  assert.equal(list.complete, true);
  assert.equal(calls.length, 2, 'GET retried once after 503');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  const sb = await client.createSandbox({});
  assert.equal(sb.id, 'sb-1');
  assert.deepEqual(await sb.exec({ argv: ['true'] }), { ok: true });
});

test('non-2xx becomes a WorkboxApiError with code and status', async () => {
  const client = new WorkboxClient({
    baseUrl: 'http://x.test',
    token: '',
    retries: 0,
    fetch: async () => jsonRes({ error: { code: 'E_DENIED', message: 'no' } }, 403),
  });
  await assert.rejects(
    () => client.listSandboxes(),
    (e) => e.code === 'E_DENIED' && e.status === 403,
  );
});
