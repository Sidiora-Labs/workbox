import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineDecoder, encodeFrame } from '../../src/ndjson.js';
import { Codes } from '../../src/errors.js';

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
