import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { brokerStatus } from '../../../src/broker/status.js';

test('status reports identity, limits, usage and network', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({
    rootfs: 'minimal',
    runtime: 'current',
    profile: { network: { mode: 'egress' } },
  });
  const out = brokerStatus({
    store,
    sandboxId: sb.id,
    limits: { memoryBytes: 123 },
    network: { mode: 'egress' },
    usage: () => ({ memoryBytes: 42 }),
  });
  assert.equal(out.sandboxId, sb.id);
  assert.equal(out.limits.memoryBytes, 123);
  assert.equal(out.usage.memoryBytes, 42);
  assert.equal(out.network.mode, 'egress');
  store.close();
});
