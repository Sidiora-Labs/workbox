import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { WsSocket, WS_DEFAULTS, acceptKey, rejectUpgrade } from '../../src/ws.js';

/** A real TCP pair: the server end wrapped in WsSocket, the client end raw. */
async function pair(opts) {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const client = net.connect(srv.address().port, '127.0.0.1');
  const [sock] = await once(srv, 'connection');
  const ws = new WsSocket(sock, Buffer.alloc(0), opts);
  const frames = [];
  let buf = Buffer.alloc(0);
  client.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      frames.push({ opcode: buf[0] & 0x0f, payload: buf.subarray(off, off + len) });
      buf = buf.subarray(off + len);
    }
  });
  return { srv, client, ws, frames };
}

function clientFrame(opcode, payload, { masked = true, len } = {}) {
  const mask = Buffer.from([1, 2, 3, 4]);
  const n = len ?? payload.length;
  let header;
  if (n < 126) header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | n]);
  else {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(n, 2);
  }
  if (!masked) return Buffer.concat([header, payload]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, body]);
}

async function until(fn, what) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
}

test('acceptKey matches the RFC 6455 example', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  assert.equal(WS_DEFAULTS.maxBufferedBytes, 1024 * 1024);
});

test('text frames both ways, ping answered with pong, close handshake', async () => {
  const { srv, client, ws, frames } = await pair();
  try {
    const got = [];
    ws.onMessage((t) => got.push(t));
    client.write(clientFrame(0x1, Buffer.from('hello')));
    client.write(clientFrame(0x1, Buffer.alloc(300, 0x61)));
    await until(() => got.length === 2, 'two messages');
    assert.equal(got[0], 'hello');
    assert.equal(got[1].length, 300);
    assert.equal(ws.send('x'.repeat(70_000)), true);
    client.write(clientFrame(0x9, Buffer.from('p')));
    await until(() => frames.some((f) => f.opcode === 0xa), 'pong');
    assert.equal(frames.find((f) => f.opcode === 0x1).payload.length, 70_000);
    let closed = 0;
    ws.onClose(() => closed++);
    client.write(clientFrame(0x8, Buffer.from([0x03, 0xe8])));
    await until(() => closed === 1, 'close');
    assert.equal(ws.send('late'), false);
    ws.onClose(() => closed++);
    assert.equal(closed, 2, 'onClose after close runs at once');
  } finally {
    client.destroy();
    srv.close();
  }
});

test('unmasked and oversize client frames are refused with 1002 and 1009', async () => {
  for (const [frame, code] of [
    [clientFrame(0x1, Buffer.from('hi'), { masked: false }), 1002],
    [clientFrame(0x1, Buffer.alloc(0), { len: 200 }), 1009],
  ]) {
    const { srv, client, ws, frames } = await pair({ maxFrameBytes: 100 });
    try {
      client.write(frame);
      await until(() => ws.closed, 'closed');
      await until(() => frames.some((f) => f.opcode === 0x8), 'close frame');
      assert.equal(frames.find((f) => f.opcode === 0x8).payload.readUInt16BE(0), code);
    } finally {
      client.destroy();
      srv.close();
    }
  }
});

test('heartbeat pings and drops a client that never answers', async () => {
  const { srv, client, ws, frames } = await pair({ heartbeatMs: 30 });
  try {
    await until(() => frames.some((f) => f.opcode === 0x9), 'ping');
    client.write(clientFrame(0xa, Buffer.alloc(0)));
    await until(() => frames.filter((f) => f.opcode === 0x9).length >= 2, 'second ping');
    await until(() => ws.closed, 'drop after missed pong');
  } finally {
    client.destroy();
    srv.close();
  }
});

test('a slow consumer is dropped instead of buffering without bound', async () => {
  const { srv, client, ws } = await pair({ maxBufferedBytes: 64 * 1024 });
  try {
    client.pause();
    const chunk = 'y'.repeat(64 * 1024);
    let sent = 0;
    while (ws.send(chunk) && sent < 10_000) sent++;
    assert.equal(ws.dropped, true);
    assert.equal(ws.closed, true);
    assert.ok(sent < 10_000);
  } finally {
    client.destroy();
    srv.close();
  }
});

test('rejectUpgrade answers a status line and closes', async () => {
  const srv = net.createServer((s) => rejectUpgrade(s, 401, 'missing\r\ntoken'));
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  try {
    const c = net.connect(srv.address().port, '127.0.0.1');
    let text = '';
    c.on('data', (d) => {
      text += d;
    });
    await once(c, 'end');
    c.destroy();
    assert.match(text, /^HTTP\/1\.1 401 missing {2}token\r\n/);
    assert.match(text, /"code":"E_DENIED"/);
  } finally {
    srv.close();
  }
});
