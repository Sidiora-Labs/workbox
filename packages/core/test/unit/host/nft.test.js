import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderRuleset,
  installArgv,
  isPrivateIpv4,
  assertIpv4,
  DENIED_CIDRS,
} from '../../../src/host/nft.js';

test('none mode drops everything except loopback and established', () => {
  const rules = renderRuleset({ mode: 'none' });
  assert.match(rules, /policy drop/);
  assert.ok(!rules.includes('dport 53'));
  assert.ok(!/\n\s+accept\n/.test(rules));
  assert.ok(!rules.includes('flush ruleset'));
  assert.match(rules, /^table inet workbox\ndelete table inet workbox\n/);
});

test('egress allows DNS, proxy and public IPv4; drops private, gateway, host and IPv6', () => {
  const rules = renderRuleset({
    mode: 'egress',
    gateway: '10.0.2.2',
    dns: '10.0.2.3',
    proxyHost: '192.0.2.10',
    proxyPort: 41000,
    hostAddresses: ['192.0.2.10', '203.0.113.5'],
  });
  for (const cidr of DENIED_CIDRS) assert.ok(rules.includes(`ip daddr ${cidr} drop`), cidr);
  const at = (s) => rules.indexOf(s);
  const proxyAccept = at('ip daddr 192.0.2.10 tcp dport 41000 accept');
  assert.ok(proxyAccept > 0);
  assert.ok(proxyAccept < at('ip daddr 10.0.0.0/8 drop'));
  assert.ok(at('ip daddr 192.0.2.10 drop') > proxyAccept);
  assert.ok(rules.includes('ip daddr 203.0.113.5 drop'));
  assert.ok(rules.includes('ip daddr 10.0.2.2 drop'));
  assert.ok(rules.includes('ip daddr 10.0.2.3 udp dport 53 accept'));
  assert.ok(at('meta nfproto ipv6 drop') < at('ct state established,related accept'));
  assert.ok(rules.includes('meta nfproto ipv4 accept'));
  assert.ok(!/\n\s+accept\n/.test(rules));
});

test('allowlist reaches only proxy and DNS', () => {
  const rules = renderRuleset({ mode: 'allowlist' });
  assert.ok(rules.includes('ip daddr 10.0.2.2 tcp dport 8080 accept'));
  assert.ok(!rules.includes(DENIED_CIDRS[1]));
  assert.ok(!rules.includes('nfproto ipv4 accept'));
  assert.match(rules, /meta nfproto ipv6 drop/);
});

test('validation and helpers', () => {
  assert.throws(() => renderRuleset({ mode: 'open' }));
  assert.throws(() => renderRuleset({ mode: 'egress', proxyPort: 0 }));
  assert.throws(() => renderRuleset({ mode: 'egress', hostAddresses: ['1.2.3.4; drop'] }));
  assert.throws(() => assertIpv4('999.1.1.1'));
  assert.throws(() => assertIpv4('10.0.0.1; rm -rf /'));
  assert.equal(isPrivateIpv4('192.168.1.1'), true);
  assert.equal(isPrivateIpv4('198.18.0.1'), true);
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
  assert.deepEqual(installArgv(42, '/tmp/r.nft').argv, [
    'nsenter',
    '-t',
    '42',
    '-n',
    'nft',
    '-f',
    '/tmp/r.nft',
  ]);
  assert.throws(() => installArgv(42, 'relative.nft'));
  assert.throws(() => installArgv(42));
});
