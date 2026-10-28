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
});

test('egress allows DNS+proxy+public and drops private ranges and gateway', () => {
  const rules = renderRuleset({
    mode: 'egress',
    gateway: '10.0.2.2',
    dns: '10.0.2.3',
    proxyPort: 8080,
  });
  for (const cidr of DENIED_CIDRS) assert.ok(rules.includes(`ip daddr ${cidr} drop`), cidr);
  assert.ok(rules.includes('ip daddr 10.0.2.2 tcp dport 8080 accept'));
  assert.ok(rules.includes('ip daddr 10.0.2.3 udp dport 53 accept'));
});

test('allowlist reaches only proxy and DNS', () => {
  const rules = renderRuleset({ mode: 'allowlist' });
  assert.ok(rules.includes('dport 8080 accept'));
  assert.ok(!rules.includes(DENIED_CIDRS[0]));
});

test('validation and helpers', () => {
  assert.throws(() => renderRuleset({ mode: 'open' }));
  assert.throws(() => assertIpv4('999.1.1.1'));
  assert.throws(() => assertIpv4('10.0.0.1; rm -rf /'));
  assert.equal(isPrivateIpv4('192.168.1.1'), true);
  assert.equal(isPrivateIpv4('8.8.8.8'), false);
  assert.deepEqual(installArgv(42).argv, ['nsenter', '-t', '42', '-n', 'nft', '-f', '-']);
});
