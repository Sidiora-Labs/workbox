import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { once } from 'node:events';
import { Peer } from '../src/peer.js';
import { ProtocolError, Codes } from '../src/errors.js';
import { encodeFrame } from '../src/ndjson.js';

/** Build a connected pair of Peers over a unix socket. */
async function pair(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbproto-'));
  const sock = path.join(dir, 's.sock');
  const server = net.createServer();
  server.listen(sock);
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const client = net.connect(sock);
  await once(client, 'connect');
  const [serverSide] = await accepted;
  const a = new Peer(client, { name: 'client', ...opts });
  const b = new Peer(serverSide, { name: 'server', ...opts });
  const cleanup = () => {
    a.close();
    b.close();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { a, b, cleanup, raw: client, server, sock };
}

test('requests flow both ways and interleave', async () => {
  const { a, b, cleanup } = await pair();
  try {
    b.handle('echo', async (p) => p);
    b.handle('slow', async (p) => {
      await new Promise((r) => setTimeout(r, p.ms));
      return { done: p.ms };
    });
    a.handle('ping', () => 'pong');
    const results = await Promise.all([
      a.request('slow', { ms: 60 }),
      a.request('echo', { x: 1 }),
      b.request('ping'),
      a.request('slow', { ms: 10 }),
    ]);
    assert.deepEqual(results, [{ done: 60 }, { x: 1 }, 'pong', { done: 10 }]);
    assert.equal(a.pending.size, 0);
    assert.equal(b.inflight.size, 0);
  } finally {
    cleanup();
  }
});

test('events are delivered in order and unknown methods are rejected', async () => {
  const { a, b, cleanup } = await pair();
  try {
    const seen = [];
    b.on('event', (m, p) => seen.push([m, p]));
    for (let i = 0; i < 50; i++) a.notify('tick', { i });
    await a.request('nope').catch((e) => {
      assert.ok(e instanceof ProtocolError);
      assert.equal(e.code, Codes.UNKNOWN_METHOD);
      assert.equal(e.data.method, 'nope');
    });
    assert.equal(seen.length, 50);
    assert.deepEqual(seen[49], ['tick', { i: 49 }]);
  } finally {
    cleanup();
  }
});

test('handler errors map to codes and internal errors hide stacks', async () => {
  const { a, b, cleanup } = await pair();
  try {
    b.handle('denied', () => {
      throw new ProtocolError(Codes.DENIED, 'no', { why: 'policy' });
    });
    b.handle('boom', () => {
      throw new TypeError('secret detail');
    });
    const logged = [];
    b.on('handlerError', (e, m) => logged.push([m, e.message]));
    await assert.rejects(
      a.request('denied'),
      (e) => e.code === Codes.DENIED && e.data.why === 'policy',
    );
    await assert.rejects(
      a.request('boom'),
      (e) =>
        e.code === Codes.INTERNAL &&
        e.message === 'secret detail' &&
        !e.stack.includes('TypeError'),
    );
    assert.deepEqual(logged, [['boom', 'secret detail']]);
  } finally {
    cleanup();
  }
});

test('timeouts reject, cancel the handler and ignore late responses', async () => {
  const { a, b, cleanup } = await pair();
  try {
    let aborted = false;
    b.handle(
      'hang',
      (_p, ctx) =>
        new Promise((resolve) =>
          ctx.signal.addEventListener('abort', () => {
            aborted = true;
            resolve('late');
          }),
        ),
    );
    await assert.rejects(
      a.request('hang', {}, { timeoutMs: 50 }),
      (e) => e.code === Codes.TIMEOUT && e.data.timeoutMs === 50,
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(aborted, true);
    assert.equal(a.pending.size, 0);
    const ac = new AbortController();
    const p = a.request('hang', {}, { signal: ac.signal, timeoutMs: 0 });
    ac.abort();
    await assert.rejects(p, (e) => e.code === Codes.CANCELLED);
  } finally {
    cleanup();
  }
});

test('closing rejects pending requests and later requests fail fast', async () => {
  const { a, b, cleanup } = await pair();
  try {
    b.handle('hang', () => new Promise(() => {}));
    const p = a.request('hang', {}, { timeoutMs: 0 });
    const closed = a.whenClosed();
    b.close();
    await assert.rejects(p, (e) => e.code === Codes.CLOSED);
    await closed;
    assert.equal(a.closed, true);
    await assert.rejects(a.request('x'), (e) => e.code === Codes.CLOSED);
    await assert.rejects(a.notify('x'), (e) => e.code === Codes.CLOSED);
  } finally {
    cleanup();
  }
});

test('malformed and oversized input is fatal for the receiving peer only', async () => {
  const { a, b, cleanup, raw } = await pair({ maxLineBytes: 1024 });
  try {
    const errors = [];
    b.on('protocolError', (e) => errors.push(e.code));
    raw.write(encodeFrame({ t: 'bogus' }));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(errors, [Codes.PARSE]);
    assert.equal(b.closed, false);
    raw.write(Buffer.alloc(2048, 0x61));
    const err = await b.whenClosed();
    assert.equal(err.code, Codes.LINE_TOO_LONG);
    assert.equal(b.closed, true);
    await a.whenClosed();
  } finally {
    cleanup();
  }
});

test('large payloads respect backpressure and arrive intact', async () => {
  const { a, b, cleanup } = await pair({ maxLineBytes: 16 * 1024 * 1024 });
  try {
    b.handle('sum', (p) => p.data.length);
    const big = 'x'.repeat(5 * 1024 * 1024);
    const rs = await Promise.all([
      a.request('sum', { data: big }),
      a.request('sum', { data: big }),
      a.request('sum', { data: 'ab' }),
    ]);
    assert.deepEqual(rs, [big.length, big.length, 2]);
    assert.ok(a.stats.bytesOut > 10 * 1024 * 1024);
  } finally {
    cleanup();
  }
});
