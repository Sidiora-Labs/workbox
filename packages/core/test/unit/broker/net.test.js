import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { Store } from '../../../src/store.js';
import { netPolicy, netTest } from '../../../src/broker/net.js';

test('policy reflects profile; test probes a real listener and a closed port', async () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({
    rootfs: 'minimal',
    runtime: 'current',
    profile: { network: { mode: 'allowlist', allow: ['example.com'] } },
  });
  const c = { store, sandboxId: sb.id };
  assert.equal(netPolicy(c).mode, 'allowlist');
  assert.deepEqual(netPolicy(c).allow, ['example.com']);
  const srv = net.createServer((s) => s.end());
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const up = await netTest(c, { host: '127.0.0.1', port: srv.address().port });
  assert.equal(up.reachable, true);
  const down = await netTest(c, { host: '127.0.0.1', port: 1, timeoutMs: 500 });
  assert.equal(down.reachable, false);
  srv.close();
  store.close();
});
