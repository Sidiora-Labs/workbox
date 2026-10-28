import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Duplex } from 'node:stream';
import { Peer } from '@workbox/protocol';
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
