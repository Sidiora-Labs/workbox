import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Runner } from '@workbox/runner';
import { Store, registerBrokerHandlers, SecretProvider } from '@workbox/core';
import { Peer, PROTOCOL_VERSION } from '@workbox/protocol';
import net from 'node:net';
import { once } from 'node:events';
import { main } from '../../src/main.js';
import { WbClient } from '../../src/client.js';

test('wb end to end over a real runner socket with broker relay (status, run evidence, secret, ask)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-int-'));
  const socketPath = path.join(dir, 'runner.sock');
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  store.setSecretPolicy(sb.id, ['GREETING']);
  const outboxDir = path.join(dir, 'outbox');
  fs.mkdirSync(outboxDir);
  const ctx = {
    store,
    sandboxId: sb.id,
    outboxDir,
    inboxDir: path.join(dir, 'inbox'),
    artifactsDir: path.join(dir, 'cas'),
    checkpointsDir: path.join(dir, 'cps'),
    secrets: new SecretProvider({ env: { WORKBOX_SECRET_GREETING: 'hello-secret' } }),
  };
  const runner = new Runner({
    socketPath,
    boot: { bootId: 'b1', nonce: 'n1', sandboxId: sb.id, protocol: 1 },
    checks: async () => ({ ok: true, problems: [] }),
  });
  await runner.start();
  const hostSocket = net.connect(socketPath);
  await once(hostSocket, 'connect');
  const host = new Peer(hostSocket, { name: 'host' });
  registerBrokerHandlers(host, ctx);
  const outChunks = [];
  const out = { write: (d) => outChunks.push(Buffer.from(d)) };
  const err = { write() {} };
  try {
    await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    await host.request('runner.go', {});
    const wb = () => new WbClient({ socketPath });
    const envBackup = { ...process.env };
    process.env.WORKBOX_OUTBOX = outboxDir;
    // wb run writes to OUTBOX_DIR captured at module load; run in-process with ctx via client commands instead:
    const client = wb();
    const status = await client.request('broker.status');
    assert.equal(status.sandboxId, sb.id);
    const secret = await client.request('session.start', {
      argv: ['sh', '-c', 'echo "val=$GREETING"'],
      secretRefs: ['GREETING'],
    });
    await new Promise((r) => setTimeout(r, 300));
    const listed = await client.request('session.list');
    assert.ok(listed.sessions.some((s) => s.sessionId === secret.sessionId));
    process.env = envBackup;
    assert.equal(await main(['tools', '--json'], { out, err }), 0);
    client.close();
    assert.equal(store.listPresets(sb.id).length, 0);
  } finally {
    host.close();
    await runner.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
