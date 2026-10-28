import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '@workbox/server';
import { WorkboxClient } from '../../src/client.js';

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

test('sdk drives a real server through create/list/exec/destroy', async () => {
  const { FakeManager } = await import(
    new URL('../../../server/test/helpers/fake-manager.js', import.meta.url)
  );
  const app = createServer({
    manager: new FakeManager(),
    keys: [{ id: 'root', token: 'tok', scopes: ['admin', 'read', 'exec', 'answer'] }],
  });
  const addr = await app.listen(0);
  const client = new WorkboxClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 'tok' });
  try {
    assert.equal((await client.health()).ok, true);
    const sb = await client.createSandbox({ name: 'sdk' });
    const list = await client.listSandboxes();
    assert.equal(list.items.length, 1);
    const out = await sb.exec({ argv: ['echo', 'from-sdk'] });
    assert.match(out.stdout, /from-sdk/);
    const gone = await sb.destroy();
    assert.equal(gone.state, 'DELETED');
  } finally {
    await app.close();
  }
});
