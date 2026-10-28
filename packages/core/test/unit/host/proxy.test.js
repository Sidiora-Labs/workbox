import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import {
  BLOCKED_CIDRS,
  checkTarget,
  compilePolicy,
  createProxy,
  hostAddresses,
  hostAllowed,
  isBlockedAddress,
  makeResolver,
  normalizeAllowEntry,
  parseTarget,
  unmapIp,
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

const system = makeResolver();

test('allowlist matching incl. wildcards and CIDR entries', () => {
  assert.equal(hostAllowed('example.com', ['example.com']), true);
  assert.equal(hostAllowed('api.example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('example.com', ['*.example.com']), true);
  assert.equal(hostAllowed('evil.com', ['*.example.com']), false);
  assert.equal(normalizeAllowEntry('*.EXAMPLE.com'), '*.example.com');
  assert.equal(normalizeAllowEntry('198.51.100.7'), '198.51.100.7/32');
  assert.equal(normalizeAllowEntry('2001:db8::/32'), '2001:db8::/32');
  assert.throws(() => normalizeAllowEntry('bad host!'));
  assert.throws(() => normalizeAllowEntry('10.0.0.0/33'));
  assert.deepEqual(parseTarget('example.com:8443'), { host: 'example.com', port: 8443 });
  assert.deepEqual(parseTarget('[::ffff:127.0.0.1]:80'), { host: '::ffff:127.0.0.1', port: 80 });
  assert.throws(() => parseTarget('example.com:notaport'));
});

test('H13 address vectors: every always-blocked range, mapped forms unmapped', () => {
  const blocked = [
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '[::ffff:a9fe:a9fe]',
    '0:0:0:0:0:ffff:0a00:0001',
  ];
  for (const a of blocked) assert.equal(isBlockedAddress(a), true, a);
  for (const a of ['8.8.8.8', '1.1.1.1', '198.51.100.2', '2606:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(isBlockedAddress(a), false, a);
  assert.equal(unmapIp('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(unmapIp('[::FFFF:10.0.0.1]'), '10.0.0.1');
  assert.equal(unmapIp('2001:db8::1'), '2001:db8::1');
  assert.equal(BLOCKED_CIDRS.length, 18);
  assert.ok(hostAddresses().has('127.0.0.1'));
});

test('checkTarget: names, ports, raw IPs and resolved answers', async () => {
  const egress = compilePolicy({ mode: 'egress' }, new Set(['203.0.113.9']));
  assert.deepEqual(await checkTarget(egress, { host: '8.8.8.8', port: 53 }, system), {
    allowed: true,
    address: '8.8.8.8',
  });
  for (const host of ['localhost', 'a.localhost', 'printer.local', 'metadata.google.internal'])
    assert.equal((await checkTarget(egress, { host, port: 80 }, system)).reason, 'denied-name');
  assert.equal(
    (await checkTarget(egress, { host: '203.0.113.9', port: 80 }, system)).reason,
    'host-address',
  );
  const answers = async () => ['198.51.100.2', '10.0.0.1'];
  assert.deepEqual(await checkTarget(egress, { host: 'mixed.test', port: 80 }, answers), {
    allowed: false,
    reason: 'blocked-address',
    address: '10.0.0.1',
  });
  const allow = compilePolicy(
    { mode: 'allowlist', allow: ['*.example.com', '198.51.100.0/24'], ports: [8443] },
    new Set(),
  );
  const pub = async () => ['198.51.100.2'];
  assert.equal((await checkTarget(allow, { host: 'a.example.com', port: 443 }, pub)).allowed, true);
  assert.equal(
    (await checkTarget(allow, { host: 'a.example.com', port: 8443 }, pub)).allowed,
    true,
  );
  assert.equal(
    (await checkTarget(allow, { host: 'a.example.com', port: 22 }, pub)).reason,
    'port-not-declared',
  );
  assert.equal(
    (await checkTarget(allow, { host: 'evil.com', port: 443 }, pub)).reason,
    'not-allowlisted',
  );
  assert.equal((await checkTarget(allow, { host: '198.51.100.9', port: 80 }, pub)).allowed, true);
  assert.equal(
    (await checkTarget(allow, { host: '203.0.113.1', port: 80 }, pub)).reason,
    'not-allowlisted',
  );
  assert.throws(() => compilePolicy({ mode: 'none' }));
});

test('proxy 403s blocked absolute-URI and CONNECT targets and reports every decision', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits += 1;
    res.end('loopback');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upPort = upstream.address().port;
  const decisions = [];
  const proxy = createProxy({
    policy: { mode: 'egress' },
    onDecision: (info) => decisions.push(info),
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
  assert.equal((await viaProxy(`http://127.0.0.1:${upPort}/x`)).status, 403);
  assert.equal((await viaProxy(`http://[::ffff:127.0.0.1]:${upPort}/x`)).status, 403);
  assert.equal((await viaProxy('/relative')).status, 400);
  const sock = net.connect(proxyPort, '127.0.0.1');
  sock.end('CONNECT 169.254.169.254:80 HTTP/1.1\r\nHost: 169.254.169.254:80\r\n\r\n');
  let reply = '';
  for await (const chunk of sock) reply += chunk;
  assert.match(reply, /^HTTP\/1\.1 403 /);
  assert.equal(hits, 0);
  assert.deepEqual(
    decisions.map((d) => [d.method, d.allowed, d.reason]),
    [
      ['GET', false, 'blocked-address'],
      ['GET', false, 'blocked-address'],
      ['CONNECT', false, 'blocked-address'],
    ],
  );
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  proxy.close();
  upstream.close();
});
