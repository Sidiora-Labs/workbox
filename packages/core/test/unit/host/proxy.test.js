import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {
  createProxy,
  hostAllowed,
  normalizeAllowEntry,
  parseTarget,
} from '../../../src/host/proxy.js';

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

test('allowlist matching incl. wildcards', () => {
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('api.example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('evil.com', ['*.example.com']), false);
  assert.equal(normalizeAllowEntry('*.EXAMPLE.com'), '*.example.com');
  assert.throws(() => normalizeAllowEntry('bad host!'));
  assert.deepEqual(parseTarget('example.com:8443'), { host: 'example.com', port: 8443 });
  assert.throws(() => parseTarget('example.com:notaport'));
});

test('proxy serves allowed absolute-URI and 403s denied with onDeny', async () => {
  const upstream = http.createServer((req, res) => res.end(`up:${req.url}`));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upPort = upstream.address().port;
  const denied = [];
  const proxy = createProxy({
    allowFor: () => ['127.0.0.1'],
    onDeny: (info) => denied.push(info),
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyPort = proxy.address().port;
  const viaProxy = (url) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: url, method: 'GET', agent: false },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  const ok = await viaProxy(`http://127.0.0.1:${upPort}/x`);
  assert.equal(ok.status, 200);
  assert.equal(ok.body, 'up:/x');
  const no = await viaProxy(`http://example.com:${upPort}/x`);
  assert.equal(no.status, 403);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].host, 'example.com');
  proxy.closeAllConnections?.();
  upstream.closeAllConnections?.();
  proxy.close();
  upstream.close();
});
