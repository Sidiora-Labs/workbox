import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, RedactStream } from '../../src/redact.js';

const VALUE = 'De"p\\loy/To>ken?é~1';
const MARK = '[REDACTED:DEPLOY_TOKEN]';

/** Every encoding of `value` the redactor promises to match, computed independently. */
function encodings(value) {
  const bytes = Buffer.from(value);
  const b64 = bytes.toString('base64');
  const every = [...bytes].map((b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  const lowerPct = (s) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  return {
    json: JSON.stringify(value).slice(1, -1),
    base64: b64,
    base64Unpadded: b64.replace(/=+$/, ''),
    base64url: bytes.toString('base64url'),
    base64urlPadded: b64.replace(/\+/g, '-').replace(/\//g, '_'),
    hex: bytes.toString('hex'),
    hexUpper: bytes.toString('hex').toUpperCase(),
    percent: encodeURIComponent(value),
    percentLower: lowerPct(encodeURIComponent(value)),
    percentEvery: every,
    percentEveryLower: every.toLowerCase(),
  };
}

function streamed(r, chunks, opts) {
  const s = r.stream(opts);
  const parts = chunks.map((c) => s.push(c));
  parts.push(s.end());
  return opts?.binary ? Buffer.concat(parts) : parts.join('');
}

test('registered values are redacted longest first; add, remove and size track the set', () => {
  const r = new Redactor();
  assert.equal(r.add('token-abc', 'npm'), true);
  assert.equal(r.add('token-abc-extended', 'github'), true);
  assert.equal(r.add('token-abc', 'npm'), true, 're-adding is a no-op');
  assert.equal(r.size, 2);
  assert.equal(
    r.apply('use token-abc-extended and token-abc now'),
    'use [REDACTED:github] and [REDACTED:npm] now',
  );
  assert.equal(r.add('', 'x'), false);
  assert.equal(r.add(12345678, 'x'), false);
  assert.equal(r.apply(42), 42);
  assert.equal(r.remove('token-abc'), true);
  assert.equal(r.remove('token-abc'), false);
  assert.equal(r.apply('token-abc token-abc-extended'), 'token-abc [REDACTED:github]');
  assert.equal(r.add('q7z', 'tiny'), true, 'a value is redacted however short');
  assert.equal(r.apply('a q7zq7z b'), 'a [REDACTED:tiny][REDACTED:tiny] b');
  assert.ok(r.stream() instanceof RedactStream);
  const empty = new Redactor();
  assert.equal(empty.apply('as is'), 'as is');
  assert.equal(empty.stream().push('as is'), 'as is');
  assert.deepEqual(
    empty.stream({ binary: true }).push(Buffer.from([0xff, 0])),
    Buffer.from([0xff, 0]),
  );
});

test('the JSON-escaped, base64, hex and percent-encoded forms are redacted', () => {
  const r = new Redactor();
  r.add(VALUE, 'DEPLOY_TOKEN');
  const forms = encodings(VALUE);
  assert.notEqual(forms.base64, forms.base64Unpadded, 'the fixture exercises padding');
  assert.notEqual(forms.base64url, forms.base64Unpadded, 'the fixture exercises the URL alphabet');
  assert.equal(r.apply(`<${VALUE}>`), `<${MARK}>`);
  for (const [name, form] of Object.entries(forms)) {
    assert.notEqual(form, VALUE, name);
    assert.equal(r.apply(`<${form}>`), `<${MARK}>`, name);
  }
  for (const prefix of ['', 'u', 'us', 'user:', 'ci-bot:']) {
    const header = Buffer.from(`${prefix}${VALUE}:suffix`).toString('base64');
    assert.ok(r.apply(`Basic ${header}`).includes(MARK), `base64 embedded at ${prefix.length}`);
    const url = Buffer.from(`${prefix}${VALUE}`).toString('base64url');
    assert.ok(r.apply(url).includes(MARK), `base64url embedded at ${prefix.length}`);
  }
});

test('a value split across two and three chunks is redacted exactly once, in order', () => {
  const value = 'wbx-0123456789abcdef';
  const r = new Redactor();
  r.add(value, 'DEPLOY_TOKEN');
  const text = `first ${value} second\nthird ${value}`;
  const expected = `first ${MARK} second\nthird ${MARK}`;
  const start = text.indexOf(value);
  for (let i = start + 1; i < start + value.length; i++) {
    assert.equal(streamed(r, [text.slice(0, i), text.slice(i)]), expected, `split at ${i}`);
    for (let j = i + 1; j < start + value.length; j++) {
      const three = [text.slice(0, i), text.slice(i, j), text.slice(j)];
      assert.equal(streamed(r, three), expected, `split at ${i} and ${j}`);
    }
  }
  assert.equal(streamed(r, [...text]), expected, 'one character per chunk');
});

test('every encoded form split across two and three byte chunks is redacted', () => {
  const r = new Redactor();
  r.add(VALUE, 'DEPLOY_TOKEN');
  for (const [name, form] of Object.entries({ raw: VALUE, ...encodings(VALUE) })) {
    const bytes = Buffer.from(`x ${form} y\n`);
    const from = 2;
    const to = 2 + Buffer.byteLength(form);
    const want = `x ${MARK} y\n`;
    for (let i = from + 1; i < to; i++) {
      const two = [bytes.subarray(0, i), bytes.subarray(i)];
      assert.equal(streamed(r, two, { binary: true }).toString(), want, `${name} cut at ${i}`);
      const j = i + Math.max(1, (to - i) >> 1);
      if (j >= to) continue;
      const three = [bytes.subarray(0, i), bytes.subarray(i, j), bytes.subarray(j)];
      assert.equal(streamed(r, three, { binary: true }).toString(), want, `${name} at ${i},${j}`);
    }
    const halves = [form.slice(0, form.length >> 1), form.slice(form.length >> 1)];
    assert.equal(streamed(r, [`x ${halves[0]}`, `${halves[1]} y\n`]), want, `${name} as text`);
  }
});

test('only a possible start is held, never longer than the longest form minus one', () => {
  const r = new Redactor();
  r.add(VALUE, 'DEPLOY_TOKEN');
  const longest = encodings(VALUE).percentEvery;
  const s = r.stream();
  assert.equal(s.push('a finished line\n'), 'a finished line\n', 'nothing held without need');
  assert.equal(s.push(`x ${VALUE.slice(0, 5)}`), 'x ', 'only the possible start is held');
  assert.equal(s.push(`${VALUE.slice(5)} y`), `${MARK} y`);
  assert.equal(s.push(longest.slice(0, -1)), '');
  assert.equal(s.tail.length, longest.length - 1, 'the rolling tail is longest - 1 at most');
  assert.equal(s.push(' '), `${longest.slice(0, -1)} `, 'a start that never completes is released');
  assert.equal(s.tail, '');
  assert.equal(s.push(`end ${VALUE.slice(0, 7)}`), 'end ');
  assert.equal(s.end(), VALUE.slice(0, 7), 'end() flushes the held tail unchanged');
  assert.equal(s.end(), '');
  const b = r.stream({ binary: true });
  assert.deepEqual(b.push(Buffer.from(`ok ${VALUE.slice(0, 17)}`)), Buffer.from('ok '));
  assert.deepEqual(b.push(Buffer.from(VALUE.slice(17))), Buffer.from(MARK));
  assert.deepEqual(b.end(), Buffer.alloc(0));
});
