import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, listPresets, getPreset } from '../../src/presets.js';

test('all six presets exist with argv steps and verification', () => {
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
    for (const step of preset.steps) {
      assert.ok(Array.isArray(step.argv) && step.argv.length >= 1, name);
      assert.ok(step.verify, `${name} step has verify`);
    }
  }
  assert.equal(listPresets().length, 6);
  assert.throws(() => getPreset('nope'), /unknown preset/);
});
