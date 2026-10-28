import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Duplex } from 'node:stream';
import { Peer } from '@workbox/protocol';
import { Store } from '../../../src/store.js';
import { registerBrokerHandlers, BROKER_HANDLERS } from '../../../src/broker/index.js';

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

test('handlers cover every broker method and answer over a peer with validation', async () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const [sa, sbStream] = memoryPair();
  const host = new Peer(sa, { name: 'host' });
  const client = new Peer(sbStream, { name: 'runner-relay' });
  registerBrokerHandlers(host, {
    store,
    sandboxId: sb.id,
    outboxDir: '/tmp',
    inboxDir: '/tmp',
    artifactsDir: '/tmp',
    checkpointsDir: '/tmp',
  });
  assert.ok(Object.keys(BROKER_HANDLERS).length >= 19);
  const status = await client.request('broker.status', {});
  assert.equal(status.sandboxId, sb.id);
  await assert.rejects(
    () => client.request('broker.ask.raise', { kind: 'bogus', title: 'x' }),
    /invalid params/,
  );
  host.close();
  client.close();
  store.close();
});
