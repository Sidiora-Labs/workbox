import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { LineDecoder, encodeFrame } from '../../src/ndjson.js';
import { Codes, ProtocolError } from '../../src/errors.js';
import { Peer } from '../../src/peer.js';

test('encodeFrame produces one JSON line', () => {
  const buf = encodeFrame({ a: 1, b: 'x' });
  assert.equal(buf.toString(), '{"a":1,"b":"x"}\n');
});

test('decoder handles split, joined and CRLF lines', () => {
  const d = new LineDecoder();
  const a = encodeFrame({ n: 1 });
  const b = encodeFrame({ n: 2 });
  const c = Buffer.from('{"n":3}\r\n');
  const joined = Buffer.concat([a, b, c]);
  const first = d.feed(joined.subarray(0, 5));
  assert.deepEqual(first, []);
  assert.equal(d.buffered, 5);
  const rest = d.feed(joined.subarray(5));
  assert.deepEqual(rest, [{ n: 1 }, { n: 2 }, { n: 3 }]);
  assert.equal(d.buffered, 0);
  assert.deepEqual(d.feed(Buffer.from('\n\n')), []);
});

test('decoder rejects an oversized complete line and keeps the bound on partial lines', () => {
  const d = new LineDecoder({ maxLineBytes: 16 });
  assert.throws(
    () => d.feed(Buffer.from('{"k":"0123456789abcdef"}\n')),
    (e) => e.code === Codes.LINE_TOO_LONG,
  );
  const d2 = new LineDecoder({ maxLineBytes: 16 });
  d2.feed(Buffer.from('{"k":"01234'));
  assert.throws(
    () => d2.feed(Buffer.from('56789abcdef')),
    (e) => e.code === Codes.LINE_TOO_LONG && e.data.max === 16,
  );
  assert.equal(d2.buffered, 0);
});

test('decoder reports a parse error with the line index', () => {
  const d = new LineDecoder();
  d.feed(encodeFrame({ ok: true }));
  assert.throws(
    () => d.feed(Buffer.from('{not json}\n')),
    (e) => e.code === Codes.PARSE && e.data.line === 1,
  );
});

test('decoder handles multi-byte utf8 split across chunks', () => {
  const d = new LineDecoder();
  const line = encodeFrame({ s: 'héllo — 日本' });
  const cut = line.indexOf('—'.charCodeAt(0) & 0xff) || 7;
  const out = [...d.feed(line.subarray(0, cut)), ...d.feed(line.subarray(cut))];
  assert.deepEqual(out, [{ s: 'héllo — 日本' }]);
});

test('invalid UTF-8 is a coded parse error by default and lossy only on request', () => {
  const wrap = (bytes) =>
    Buffer.concat([Buffer.from('{"s":"'), Buffer.from(bytes), Buffer.from('"}\n')]);
  const bad = [wrap([0xff]), wrap([0xc0, 0xaf]), wrap([0xe2, 0x82]), wrap([0xed, 0xa0, 0x80])];
  for (const line of bad) {
    const d = new LineDecoder();
    assert.equal(d.fatal, true);
    assert.throws(
      () => d.feed(line),
      (e) => e.code === Codes.PARSE && e.data.encoding === 'utf-8' && e.data.line === 0,
    );
  }
  const lossy = new LineDecoder({ fatal: false });
  assert.deepEqual(lossy.feed(bad[0]), [{ s: '�' }]);
  const strict = new LineDecoder();
  assert.deepEqual(strict.feed(encodeFrame({ s: '😀 é' })), [{ s: '😀 é' }]);
  assert.deepEqual(strict.feed(encodeFrame({ s: '\ud800' })), [{ s: '\ud800' }]);
});

test('invalid UTF-8 on a Peer control channel closes it with a coded protocol error', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wbutf8-'));
  const sock = path.join(dir, 's.sock');
  const server = net.createServer();
  server.listen(sock);
  await once(server, 'listening');
  const accepted = once(server, 'connection');
  const raw = net.connect(sock);
  await once(raw, 'connect');
  const [serverSide] = await accepted;
  const peer = new Peer(serverSide, { name: 'server' });
  try {
    const errors = [];
    peer.on('protocolError', (e) => errors.push(e.code));
    raw.write(Buffer.concat([Buffer.from('{"t":"evt","m":"x","p":"'), Buffer.from([0xfe, 0x0a])]));
    const err = await peer.whenClosed();
    assert.ok(err instanceof ProtocolError);
    assert.equal(err.code, Codes.PARSE);
    assert.equal(err.data.encoding, 'utf-8');
    assert.deepEqual(errors, [Codes.PARSE]);
    assert.equal(peer.closed, true);
  } finally {
    peer.close();
    raw.destroy();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
