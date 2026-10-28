import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { presetManifest, PRESET_NAMES } from '../../../src/broker/presets.js';

const SHA = 'a'.repeat(64);

test('manifest mirrors to the store; unknown preset rejected', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const c = { store, sandboxId: sb.id };
  const manifest = {
    status: 'ok',
    tools: { python3: { version: 'Python 3.12.9', path: '/usr/bin/python3.12', sha256: SHA } },
  };
  assert.deepEqual(presetManifest(c, { name: 'python', manifest }), {
    name: 'python',
    mirrored: true,
  });
  assert.equal(store.listPresets(sb.id)[0].manifest.tools.python3.version, 'Python 3.12.9');
  assert.equal(JSON.stringify(store.listPresets(sb.id)[0].manifest), JSON.stringify(manifest));
  assert.deepEqual([...PRESET_NAMES], ['web', 'python', 'rust', 'go', 'system', 'agents']);
  assert.throws(() => presetManifest(c, { name: 'nope', manifest: {} }), /unknown preset/);
  store.close();
});

test('manifest shape: status ok|failed, every tool with version, path and sha256', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const c = { store, sandboxId: sb.id };
  const bad = [
    { status: 'partial', tools: {} },
    { status: 'ok' },
    { status: 'ok', tools: [] },
    { status: 'ok', tools: { uv: { version: 'uv 1', path: '/usr/local/bin/uv' } } },
    { status: 'ok', tools: { uv: { version: '', path: '/x', sha256: SHA } } },
    { status: 'ok', tools: { uv: { version: 'uv 1', sha256: SHA } } },
  ];
  for (const manifest of bad)
    assert.throws(
      () => presetManifest(c, { name: 'python', manifest }),
      (e) => e.code === 'E_INVALID_PARAMS',
      JSON.stringify(manifest),
    );
  assert.deepEqual(store.listPresets(sb.id), []);
  presetManifest(c, { name: 'python', manifest: { status: 'failed', tools: {} } });
  assert.equal(store.listPresets(sb.id)[0].manifest.status, 'failed');
  store.close();
});
