import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Duplex } from 'node:stream';
import { Peer } from '@workbox/protocol';
import { Runner } from '@workbox/runner';
import { WbClient, DEFAULT_SOCKET } from '../../src/client.js';

function memoryPair() {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const mk = (readable, writable) =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        writable.write(chunk, cb);
      },
      final(cb) {
        writable.end();
        cb();
      },
      destroy(err, cb) {
        writable.destroy();
        readable.destroy();
        cb(err);
      },
    });
  const a = mk(ba, ab);
  const b = mk(ab, ba);
  ab.on('data', (c) => b.push(c));
  ba.on('data', (c) => a.push(c));
  return [a, b];
}

test('client requests over an injected peer; defaults point at the runner socket', async () => {
  assert.match(DEFAULT_SOCKET, /runner\.sock$/);
  const [sa, sb] = memoryPair();
  const server = new Peer(sb, { name: 'runner' });
  server.handle('runner.status', () => ({ sandboxId: 's1', phase: 'ready' }));
  server.handle('session.list', () => ({ sessions: [] }));
  const wb = new WbClient({ peer: new Peer(sa, { name: 'wb' }) });
  assert.equal((await wb.request('runner.status')).sandboxId, 's1');
  assert.deepEqual(await wb.request('session.list'), { sessions: [] });
  wb.close();
  server.close();
});

test('missing socket yields a coded unavailable error', async () => {
  const wb = new WbClient({ socketPath: '/nonexistent/runner.sock' });
  await assert.rejects(
    () => wb.connect(),
    (e) => e.code === 'E_UNAVAILABLE',
  );
});

test('concurrent first requests share one runner connection and close releases it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-client-'));
  const socketPath = path.join(dir, 'runner.sock');
  const runner = new Runner({
    socketPath,
    boot: { bootId: 'b1', nonce: 'n1', sandboxId: 's1', protocol: 1 },
    checks: async () => ({ ok: true, problems: [] }),
  });
  await runner.start();
  try {
    const wb = new WbClient({ socketPath });
    const [a, b] = await Promise.all([wb.request('runner.status'), wb.request('runner.status')]);
    assert.equal(a.sandboxId, 's1');
    assert.equal(b.connections, 1, 'one socket for both requests');
    assert.equal(runner.peers.size, 1);
    wb.close();
    const deadline = Date.now() + 5000;
    while (runner.peers.size > 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(runner.peers.size, 0, 'close released the only socket');
  } finally {
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('onEvent unsubscribes from the peer it subscribed on, also twice and after close', async () => {
  const [sa, sb] = memoryPair();
  const server = new Peer(sb, { name: 'runner' });
  const peer = new Peer(sa, { name: 'wb' });
  const wb = new WbClient({ peer });
  const seen = [];
  const off = wb.onEvent((method, params) => seen.push([method, params]));
  assert.equal(peer.listenerCount('event'), 1);
  await server.notify('session.output', { sessionId: 's1', stream: 'stdout', seq: 0, data: '' });
  const deadline = Date.now() + 5000;
  while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(seen[0][0], 'session.output');
  off();
  assert.equal(peer.listenerCount('event'), 0);
  wb.close();
  assert.equal(wb.peer, null);
  off();
  assert.throws(
    () => wb.onEvent(() => {}),
    (e) => e.code === 'E_CLOSED',
  );
  server.close();
});
