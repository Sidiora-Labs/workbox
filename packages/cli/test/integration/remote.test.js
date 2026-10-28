import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '@workbox/server';
import { main } from '../../src/main.js';

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

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

test('remote mode: serve + create/exec/rm through the CLI against a real server', async () => {
  const { FakeManager } = await import(
    new URL('../../../server/test/helpers/fake-manager.js', import.meta.url)
  );
  const app = createServer({
    manager: new FakeManager(),
    keys: [{ id: 'root', token: 'tok', scopes: ['admin', 'read', 'exec', 'answer'] }],
  });
  const addr = await app.listen(0);
  const base = `http://127.0.0.1:${addr.port}`;
  const remote = ['--server', base, '--token', 'tok'];
  try {
    const o = capture();
    const e = capture();
    assert.equal(
      await main(['sandbox', 'create', '--name', 'remote1', ...remote], {
        out: o.stream,
        err: e.stream,
      }),
      0,
    );
    assert.match(o.text(), /sb-1/);
    const o2 = capture();
    assert.equal(await main(['sandbox', 'ls', ...remote], { out: o2.stream, err: e.stream }), 0);
    assert.match(o2.text(), /sb-1/);
    const o3 = capture();
    assert.equal(
      await main(['sandbox', 'rm', 'sb-1', ...remote], { out: o3.stream, err: e.stream }),
      0,
    );
  } finally {
    await app.close();
  }
});
