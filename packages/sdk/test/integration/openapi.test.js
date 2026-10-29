import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SERVER_VERSION, buildOpenApi } from '@workbox/server';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { ROUTES, WorkboxApiError, WorkboxClient } from '../../src/index.js';

test('client.openapi() fetches the served document with or without a token', async () => {
  const srv = await bootServer();
  try {
    const anonymous = new WorkboxClient({ baseUrl: srv.base, retries: 0 });
    const doc = await anonymous.openapi();
    assert.deepEqual(doc, buildOpenApi({ version: SERVER_VERSION }));
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.paths['/v1/openapi.json'].get);
    assert.deepEqual(ROUTES['GET /v1/openapi.json'], ['WorkboxClient#openapi']);
    const ids = new Set(
      Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId)),
    );
    for (const id of ['createSandbox', 'execCommand', 'startSession', 'listEvents', 'whoami'])
      assert.ok(ids.has(id), id);

    const reader = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.read, retries: 0 });
    assert.deepEqual(await reader.openapi(), doc);
    await assert.rejects(
      anonymous.whoami(),
      (e) => e instanceof WorkboxApiError && e.status === 401,
      'the document is open, the API is not',
    );
    const ac = new AbortController();
    ac.abort(new Error('stop'));
    await assert.rejects(reader.openapi({ signal: ac.signal }), /stop/);
  } finally {
    await srv.stop();
  }
});
