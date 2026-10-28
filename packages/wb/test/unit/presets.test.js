import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS,
  PRESET_DIR,
  assertPresetNetwork,
  getPreset,
  listPresets,
  recipeDigest,
} from '../../src/presets.js';

const HOST_SETS = [
  '@node',
  '@python',
  '@go',
  '@rust',
  '@ubuntu',
  '@github',
  '@docker',
  '@browsers',
  '@huggingface',
];

test('all six presets exist with argv steps, tool checks and host sets', () => {
  assert.deepEqual(Object.keys(PRESETS).sort(), [
    'agents',
    'go',
    'python',
    'rust',
    'system',
    'web',
  ]);
  for (const [name, preset] of Object.entries(PRESETS)) {
    assert.ok(preset.steps.length >= 1, name);
    assert.ok(preset.hosts.length >= 1, name);
    for (const h of preset.hosts) assert.ok(HOST_SETS.includes(h), `${name}: ${h}`);
    for (const step of preset.steps) {
      assert.ok(Array.isArray(step.argv) && step.argv.length >= 1, name);
      assert.ok(Object.keys(step.tools).length >= 1, `${name} step provides a tool`);
      for (const check of Object.values(step.tools)) {
        assert.ok(Array.isArray(check.verify) && check.verify.length >= 1, name);
        assert.ok(check.bin.startsWith('/'), `${name}: ${check.bin} is absolute`);
      }
    }
    for (const argv of Object.values(preset.resolve ?? {})) assert.ok(Array.isArray(argv));
  }
  assert.deepEqual(PRESETS.web.hosts.slice(0, 2), ['@node', '@browsers']);
  assert.deepEqual(Object.keys(PRESETS.rust.resolve), ['rust']);
  assert.deepEqual(Object.keys(PRESETS.go.resolve), ['go']);
  assert.equal(PRESETS.agents.steps.at(-1).when, 'WORKBOX_HYPERFIDE_URL');
  assert.equal(PRESET_DIR, '/var/lib/workbox-preset');
});

test('downloads are pinned: no @latest, no piped installer scripts', () => {
  for (const [name, preset] of Object.entries(PRESETS))
    for (const step of preset.steps) {
      const script = step.argv.join(' ');
      assert.doesNotMatch(script, /@latest/, name);
      assert.doesNotMatch(script, /\|\s*(ba)?sh\b/, name);
    }
});

test('list, lookup and recipe digest', () => {
  const list = listPresets();
  assert.equal(list.length, 6);
  assert.deepEqual(
    list.map((p) => p.name),
    ['agents', 'go', 'python', 'rust', 'system', 'web'],
  );
  assert.deepEqual(list.find((p) => p.name === 'python').hosts, ['@python', '@github']);
  assert.equal(getPreset('python'), PRESETS.python);
  assert.throws(
    () => getPreset('nope'),
    (e) => e.code === 'E_NOT_FOUND' && /unknown preset/.test(e.message),
  );
  assert.throws(() => getPreset('toString'), /unknown preset/);
  assert.match(recipeDigest(PRESETS.python), /^[0-9a-f]{64}$/);
  assert.equal(recipeDigest(PRESETS.python), recipeDigest(PRESETS.python));
  assert.notEqual(recipeDigest(PRESETS.python), recipeDigest(PRESETS.go));
});

test('network gate: none refused, allowlist must name every needed set, egress passes', () => {
  const py = PRESETS.python;
  assert.throws(
    () => assertPresetNetwork('python', py, { mode: 'none' }),
    (e) => e.code === 'E_DENIED' && e.data.reason === 'network-none',
  );
  assert.throws(
    () => assertPresetNetwork('python', py, { mode: 'allowlist', allow: ['@python'] }),
    (e) =>
      e.code === 'E_DENIED' &&
      e.data.reason === 'host-set-missing' &&
      e.data.missing.join() === '@github' &&
      e.message.includes('@github'),
  );
  assertPresetNetwork('python', py, { mode: 'allowlist', allow: ['@Python', '@github'] });
  assertPresetNetwork('python', py, { mode: 'egress', allow: [] });
});
