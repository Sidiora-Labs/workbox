import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import net from 'node:net';
import {
  isPublicAddress,
  mappedIpv4,
  parseTargetUrl,
  pinnedLookup,
  resolveTarget,
  MAX_TARGET_URL_LENGTH,
  NOT_PUBLIC_RANGES,
} from '../../src/webhook-target.js';

const invalid = (re) => (e) => e.code === 'E_INVALID_PARAMS' && re.test(e.message);

test('literal addresses: every listed range is refused, public addresses pass', () => {
  const refused = [
    '0.0.0.0',
    '0.255.255.255',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.10',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '64:ff9b::a00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fe80::1%lo',
    'ff02::1',
    '2001:db8::1',
  ];
  for (const a of refused) assert.equal(isPublicAddress(a), false, a);
  const allowed = [
    '1.1.1.1',
    '8.8.8.8',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '192.0.1.1',
    '192.169.0.1',
    '198.17.255.255',
    '198.20.0.0',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ];
  for (const a of allowed) assert.equal(isPublicAddress(a), true, a);
  for (const a of ['', 'localhost', 'example.com', '1.2.3', '::g', undefined, null])
    assert.equal(isPublicAddress(a), false, String(a));
  assert.equal(NOT_PUBLIC_RANGES.length, 21);
  for (const range of NOT_PUBLIC_RANGES) {
    const [address] = range.split('/');
    assert.equal(isPublicAddress(address), false, range);
  }
});

test('IPv4-mapped IPv6 addresses are judged by their IPv4 address, in every spelling', () => {
  assert.equal(mappedIpv4('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(mappedIpv4('::ffff:7f00:1'), '127.0.0.1');
  assert.equal(mappedIpv4('0:0:0:0:0:ffff:a9fe:a9fe'), '169.254.169.254');
  assert.equal(mappedIpv4('::FFFF:C0A8:0101'), '192.168.1.1');
  assert.equal(mappedIpv4('::1'), null);
  assert.equal(mappedIpv4('2001:db8::1'), null);
  assert.equal(mappedIpv4('not an address'), null);
  for (const a of [
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:a9fe:a9fe',
    '::ffff:198.18.0.1',
    '0:0:0:0:0:ffff:c0a8:101',
  ])
    assert.equal(isPublicAddress(a), false, a);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
  assert.equal(isPublicAddress('::ffff:808:808'), true);
});

test('the URL must be https (http only when allowed), without credentials, and short', () => {
  assert.equal(parseTargetUrl('https://hooks.example/x?y=1').href, 'https://hooks.example/x?y=1');
  assert.throws(
    () => parseTargetUrl('http://hooks.example/'),
    invalid(/must use https, not http:/),
  );
  assert.equal(
    parseTargetUrl('http://hooks.example/', { allowHttp: true }).protocol,
    'http:',
    'allowHttp accepts http',
  );
  for (const bad of ['ftp://hooks.example/', 'file:///etc/passwd', 'ws://hooks.example/'])
    assert.throws(() => parseTargetUrl(bad, { allowHttp: true }), invalid(/https or http/), bad);
  assert.throws(
    () => parseTargetUrl('https://user:pw@hooks.example/'),
    invalid(/must not carry credentials/),
  );
  assert.throws(() => parseTargetUrl('https://user@hooks.example/'), invalid(/credentials/));
  const long = `https://hooks.example/${'a'.repeat(MAX_TARGET_URL_LENGTH)}`;
  assert.throws(() => parseTargetUrl(long), invalid(/longer than 2048/));
  assert.equal(parseTargetUrl(long.slice(0, MAX_TARGET_URL_LENGTH)).hostname, 'hooks.example');
  for (const bad of ['', 'not a url', '//hooks.example/', undefined])
    assert.throws(() => parseTargetUrl(bad), invalid(/url/), String(bad));
});

test('resolveTarget refuses literal and resolved private hosts unless allowPrivate', async () => {
  for (const url of [
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://[::ffff:127.0.0.1]/x',
    'https://2130706433/x',
    'https://0x7f.1/x',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.1/x',
    'https://198.18.0.1:3128/x',
  ])
    await assert.rejects(resolveTarget(url), invalid(/is not public/), url);
  const local = await dns.promises.lookup('localhost', { all: true, verbatim: true });
  assert.ok(local.length > 0);
  await assert.rejects(resolveTarget('https://localhost:8443/hook'), (e) => {
    assert.equal(e.code, 'E_INVALID_PARAMS');
    assert.match(e.message, /localhost resolves to an address that is not public/);
    assert.deepEqual(e.data.addresses.sort(), local.map((a) => a.address).sort());
    return true;
  });
  const allowed = await resolveTarget('http://localhost:9/hook', {
    allowHttp: true,
    allowPrivate: true,
  });
  assert.equal(allowed.host, 'localhost');
  assert.deepEqual(allowed.addresses, local);
  assert.equal(allowed.address, local[0].address);
  assert.equal(allowed.family, net.isIP(local[0].address));
  const literal = await resolveTarget('https://[::1]:8443/', { allowPrivate: true });
  assert.deepEqual(literal.addresses, [{ address: '::1', family: 6 }]);
  assert.equal(literal.family, 6);
  const v4 = await resolveTarget('https://8.8.8.8/hook');
  assert.equal(v4.address, '8.8.8.8');
  assert.equal(v4.family, 4);
  await assert.rejects(
    resolveTarget('https://does-not-exist.invalid/hook'),
    invalid(/does-not-exist\.invalid does not resolve/),
  );
});

test('pinnedLookup answers every query, single and all, with the checked address', async () => {
  const lookup = pinnedLookup('127.0.0.1', 4);
  const one = await new Promise((resolve) =>
    lookup('rebinding.example', { family: 0 }, (err, address, family) =>
      resolve({ err, address, family }),
    ),
  );
  assert.deepEqual(one, { err: null, address: '127.0.0.1', family: 4 });
  const all = await new Promise((resolve) =>
    lookup('rebinding.example', { all: true }, (err, list) => resolve({ err, list })),
  );
  assert.deepEqual(all, { err: null, list: [{ address: '127.0.0.1', family: 4 }] });
  const bare = await new Promise((resolve) =>
    lookup('rebinding.example', (err, address) => resolve(address)),
  );
  assert.equal(bare, '127.0.0.1');
});
