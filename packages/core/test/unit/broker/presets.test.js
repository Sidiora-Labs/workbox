import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { presetManifest, PRESET_NAMES } from '../../../src/broker/presets.js';

test('manifest mirrors to the store; unknown preset rejected', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const c = { store, sandboxId: sb.id };
  presetManifest(c, {
    name: 'python',
    manifest: { status: 'ok', tools: { python3: { version: '3.12' } } },
  });
  assert.equal(store.listPresets(sb.id)[0].manifest.tools.python3.version, '3.12');
  assert.deepEqual([...PRESET_NAMES], ['web', 'python', 'rust', 'go', 'system', 'agents']);
  assert.throws(() => presetManifest(c, { name: 'nope', manifest: {} }), /unknown preset/);
  store.close();
});
