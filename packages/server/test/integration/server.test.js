import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { FakeManager } from '../helpers/fake-manager.js';

// Localhost test traffic must never go through an ambient HTTP(S) proxy.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])
  delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

test('integration: full lifecycle over real HTTP with audit entries for mutations', async () => {
  const entries = [];
  const app = createServer({
    manager: new FakeManager(),
    keys: [{ id: 'root', token: 't', scopes: ['admin', 'read', 'exec', 'answer'] }],
    audit: { append: (e) => entries.push(e) },
  });
  const addr = await app.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  const H = { authorization: 'Bearer t', 'content-type': 'application/json' };
  try {
    const created = await (
      await fetch(`${base}/v1/sandboxes`, { method: 'POST', headers: H, body: '{"name":"int"}' })
    ).json();
    const listed = await (await fetch(`${base}/v1/sandboxes`, { headers: H })).json();
    assert.equal(listed.complete, true);
    assert.equal(listed.items.length, 1);
    await fetch(`${base}/v1/sandboxes/${created.id}`, { method: 'DELETE', headers: H });
    assert.ok(entries.some((e) => e.action === 'sandbox.create'));
    assert.ok(entries.some((e) => e.action === 'sandbox.destroy'));
  } finally {
    await app.close();
  }
});
