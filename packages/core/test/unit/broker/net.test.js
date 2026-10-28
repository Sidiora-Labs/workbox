import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { Audit, auditFiles } from '../../../src/audit.js';
import { createProxy } from '../../../src/host/proxy.js';
import { netPolicy, netTest } from '../../../src/broker/net.js';
import { tmpDir } from '../../helpers/tmp.js';

test('policy reflects profile; test decides like the proxy and audits every call', async () => {
  const store = Store.open(':memory:');
  const t = tmpDir('workbox-net-');
  const audit = new Audit({ dir: t.dir }).open();
  const sb = store.createSandbox({
    rootfs: 'minimal',
    runtime: 'current',
    profile: { network: { mode: 'egress', allow: [], ports: [8443] } },
  });
  const proxy = createProxy({ policy: { mode: 'egress' } });
  const state = { proxyUrl: 'http://192.0.2.10:41000', check: (target) => proxy.check(target) };
  const c = { store, audit, sandboxId: sb.id, netState: () => state };
  assert.deepEqual(netPolicy(c), {
    mode: 'egress',
    allow: [],
    ports: [8443],
    proxy: 'http://192.0.2.10:41000',
  });
  const meta = await netTest(c, { host: '169.254.169.254', port: 80 });
  assert.equal(meta.allowed, false);
  assert.equal(meta.reason, 'blocked-address');
  assert.equal(meta.reachable, false);
  const loop = await netTest(c, { host: 'localhost', port: 80 });
  assert.equal(loop.reason, 'denied-name');
  const detached = await netTest({ ...c, netState: () => null }, { host: '8.8.8.8', port: 53 });
  assert.equal(detached.reason, 'network-detached');
  const none = await netTest(
    { store, audit, sandboxId: sb.id, network: { mode: 'none' } },
    { host: '8.8.8.8', port: 53 },
  );
  assert.equal(none.reason, 'network-none');
  await assert.rejects(netTest(c, { host: '', port: 80 }));
  assert.equal(Audit.verify(t.dir).ok, true);
  const entries = auditFiles(t.dir)
    .flatMap((f) => fs.readFileSync(path.join(t.dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((e) => e.sandboxId === sb.id);
  assert.deepEqual(
    entries.map((e) => [e.action, e.data.reason ?? null]),
    [
      ['net.policy', null],
      ['net.test', 'blocked-address'],
      ['net.test', 'denied-name'],
      ['net.test', 'network-detached'],
      ['net.test', 'network-none'],
    ],
  );
  store.close();
  t.cleanup();
});
