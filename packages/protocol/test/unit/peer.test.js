import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Duplex } from 'node:stream';
import { Peer, CANCEL_METHOD, DEFAULT_TIMEOUT_MS } from '../../src/peer.js';
import { Codes } from '../../src/errors.js';
import { encodeFrame } from '../../src/ndjson.js';

/** Two in-memory duplexes wired back to back; no sockets involved. */
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
  ab.on('end', () => b.push(null));
  ba.on('end', () => a.push(null));
  return [a, b];
}

test('defaults and handler registry', () => {
  const [s] = memoryPair();
  const p = new Peer(s);
  assert.equal(p.name, 'peer');
  assert.equal(p.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(CANCEL_METHOD, '$cancel');
  p.handle('a', () => 1);
  assert.ok(p.handlers.has('a'));
  p.unhandle('a');
  assert.equal(p.handlers.has('a'), false);
  p.close();
  assert.equal(p.closed, true);
});

test('request and response over an in-memory duplex', async () => {
  const [sa, sb] = memoryPair();
  const a = new Peer(sa, { name: 'a' });
  const b = new Peer(sb, { name: 'b' });
  b.handle('add', ({ x, y }) => x + y);
  assert.equal(await a.request('add', { x: 2, y: 3 }), 5);
  assert.equal(a.stats.sent, 1);
  assert.equal(b.stats.received, 1);
  a.close();
  b.close();
});

test('late responses and unmatched ids are ignored', async () => {
  const [sa, sb] = memoryPair();
  const a = new Peer(sa);
  sb.write(encodeFrame({ t: 'res', id: 'nobody', ok: true, r: 1 }));
  await new Promise((r) => {
    setTimeout(r, 10);
  });
  assert.equal(a.pending.size, 0);
  assert.equal(a.stats.received, 1);
  a.close();
});

test('cancel event aborts the matching in-flight handler', async () => {
  const [sa, sb] = memoryPair();
  const a = new Peer(sa);
  const b = new Peer(sb);
  let abortedFor = null;
  b.handle(
    'hang',
    (_p, ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => {
          abortedFor = ctx.id;
          resolve();
        });
      }),
  );
  const p = a.request('hang', {}, { timeoutMs: 20 });
  await assert.rejects(p, (e) => e.code === Codes.TIMEOUT);
  await new Promise((r) => {
    setTimeout(r, 10);
  });
  assert.ok(abortedFor);
  assert.equal(b.inflight.size, 0);
  a.close();
  b.close();
});

test('whenClosed resolves with the close error', async () => {
  const [sa] = memoryPair();
  const a = new Peer(sa);
  const err = new Error('boom');
  setTimeout(() => a.close(err), 5);
  assert.equal(await a.whenClosed(), err);
  assert.equal(await a.whenClosed(), err);
});
