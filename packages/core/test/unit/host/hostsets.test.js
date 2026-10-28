import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_SETS, expandHostSets, hostSet, isHostSetEntry } from '../../../src/host/hostsets.js';
import { compilePolicy, hostAllowed, normalizeAllowEntry } from '../../../src/host/proxy.js';

test('the nine host sets exist and every host is a valid allowlist entry', () => {
  assert.deepEqual(Object.keys(HOST_SETS).sort(), [
    'browsers',
    'docker',
    'github',
    'go',
    'huggingface',
    'node',
    'python',
    'rust',
    'ubuntu',
  ]);
  for (const [name, hosts] of Object.entries(HOST_SETS)) {
    assert.ok(hosts.length > 0, name);
    for (const h of hosts) assert.equal(normalizeAllowEntry(h), h, `${name}: ${h}`);
  }
  assert.ok(HOST_SETS.ubuntu.includes('deb.debian.org'), 'the rootfs apt mirror is in @ubuntu');
  assert.ok(HOST_SETS.browsers.includes('cdn.playwright.dev'));
});

test('@name entries: recognised, case-insensitive, unknown sets are coded errors', () => {
  assert.equal(isHostSetEntry('@python'), true);
  assert.equal(isHostSetEntry('python'), false);
  assert.equal(isHostSetEntry(42), false);
  assert.equal(hostSet('@PYTHON'), HOST_SETS.python);
  assert.equal(normalizeAllowEntry('@GitHub'), '@github');
  assert.throws(
    () => hostSet('@nope'),
    (e) => e.code === 'E_INVALID_PARAMS' && e.data.known.includes('@node'),
  );
  assert.throws(() => normalizeAllowEntry('@nope'), /unknown allowlist host set @nope/);
  assert.throws(() => normalizeAllowEntry('@'), /unknown allowlist host set/);
});

test('expansion keeps plain entries, collapses duplicates and feeds the proxy compiler', () => {
  const expanded = expandHostSets(['@go', '@browsers', 'example.com']);
  assert.equal(expanded.filter((h) => h === 'storage.googleapis.com').length, 1);
  assert.ok(expanded.includes('proxy.golang.org'));
  assert.ok(expanded.includes('cdn.playwright.dev'));
  assert.equal(expanded.at(-1), 'example.com');
  const compiled = compilePolicy(
    { mode: 'allowlist', allow: ['@Python', '@github', '10.1.2.3'] },
    new Set(),
  );
  assert.ok(compiled.hosts.includes('pypi.org'));
  assert.ok(!compiled.hosts.some((h) => h.startsWith('@')));
  assert.ok(hostAllowed('files.pythonhosted.org', compiled.hosts));
  assert.ok(hostAllowed('release-assets.githubusercontent.com', compiled.hosts));
  assert.ok(!hostAllowed('registry.npmjs.org', compiled.hosts));
  assert.ok(compiled.cidrs.ipv4.check('10.1.2.3', 'ipv4'));
  assert.throws(() => compilePolicy({ mode: 'allowlist', allow: ['@nope'] }, new Set()));
});
