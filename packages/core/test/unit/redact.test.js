import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Redactor, MIN_LENGTH, MAX_DEPTH, TOKEN_SHAPES } from '../../src/redact.js';
import { createLogger } from '../../src/log.js';

test('API key tokens are redacted by their shape without being registered', () => {
  const token = `wbk_${randomBytes(32).toString('base64url')}`;
  assert.equal(token.length, 47);
  assert.equal(TOKEN_SHAPES.length, 1);
  const r = new Redactor();
  assert.equal(r.size, 0);
  assert.equal(
    r.apply(`Authorization: Bearer ${token}`),
    'Authorization: Bearer [REDACTED:api-key]',
  );
  assert.deepEqual(r.applyDeep({ headers: { authorization: `Bearer ${token}` }, list: [token] }), {
    headers: { authorization: 'Bearer [REDACTED:api-key]' },
    list: ['[REDACTED:api-key]'],
  });
  assert.equal(r.apply('wbk_short and wbk_'), 'wbk_short and wbk_');
  assert.equal(r.apply(7), 7);
  r.add('registered-secret-value', 'SECRET');
  assert.equal(r.apply(`registered-secret-value ${token}`), '[REDACTED:SECRET] [REDACTED:api-key]');
  const lines = [];
  const log = createLogger({ stream: { write: (l) => lines.push(l) }, redactor: new Redactor() });
  log.info('request', { authorization: `Bearer ${token}` });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes(token), false);
  assert.equal(JSON.parse(lines[0]).authorization, 'Bearer [REDACTED:api-key]');
});

test('redacts registered values, longest first, in text and nested objects', () => {
  const r = new Redactor();
  assert.equal(MIN_LENGTH, 8);
  assert.ok(r.add('token-abc', 'npm'));
  assert.ok(r.add('token-abc-extended', 'github'));
  assert.equal(r.size, 2);
  assert.equal(
    r.apply('use token-abc-extended and token-abc now'),
    'use [REDACTED:github] and [REDACTED:npm] now',
  );
  assert.equal(r.apply('nothing here'), 'nothing here');
  assert.equal(r.apply(42), 42);
  const obj = r.applyDeep({
    'token-abc': ['x', 'token-abc'],
    nested: { v: 'token-abc-extended', n: 1, b: null },
  });
  assert.deepEqual(obj, {
    '[REDACTED:npm]': ['x', '[REDACTED:npm]'],
    nested: { v: '[REDACTED:github]', n: 1, b: null },
  });
  assert.equal(r.remove('token-abc'), true);
  assert.equal(r.remove('token-abc'), false);
  assert.equal(r.apply('token-abc'), 'token-abc');
  assert.equal(r.add(12345678), false);
  assert.equal(r.add(''), false);
  const empty = new Redactor();
  assert.equal(empty.apply('x'), 'x');
  assert.equal(empty.stream().push('x'), 'x');
});

test('removing a value keeps the remaining values longest-first', () => {
  const r = new Redactor();
  r.add('abcdef', 'short');
  r.add('abcdefgh', 'middle');
  r.add('abcdefghij', 'long');
  assert.equal(r.remove('abcdefgh'), true);
  assert.equal(r.size, 2);
  assert.equal(
    r.apply('abcdefghij abcdefgh abcdef'),
    '[REDACTED:long] [REDACTED:short]gh [REDACTED:short]',
  );
});

test('a registered value is redacted however short it is', () => {
  const r = new Redactor();
  assert.equal(r.add('q7z', 'tiny'), true);
  assert.equal(r.apply('a q7z b q7zq7z'), 'a [REDACTED:tiny] b [REDACTED:tiny][REDACTED:tiny]');
  assert.equal(r.applyDeep({ k: 'q7z' }).k, '[REDACTED:tiny]');
  const s = r.stream();
  assert.equal(`${s.push('xq')}${s.push('7')}${s.push('z.')}${s.end()}`, 'x[REDACTED:tiny].');
});

test('base64, hex, percent and JSON-escaped forms of a value are redacted', () => {
  const value = 'De"p\\loy/To>ken?é~1';
  const r = new Redactor();
  r.add(value, 'DEPLOY_TOKEN');
  const bytes = Buffer.from(value);
  const b64 = bytes.toString('base64');
  const lowerPct = (s) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  const every = [...bytes].map((b) => `%${b.toString(16).padStart(2, '0').toUpperCase()}`).join('');
  const forms = {
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
    json: JSON.stringify(value).slice(1, -1),
  };
  assert.notEqual(forms.base64, forms.base64Unpadded, 'the fixture exercises padding');
  assert.notEqual(forms.base64url, forms.base64Unpadded, 'the fixture exercises the URL alphabet');
  for (const [name, form] of Object.entries(forms)) {
    assert.notEqual(form, value, name);
    assert.equal(r.apply(`<${form}>`), '<[REDACTED:DEPLOY_TOKEN]>', name);
    assert.equal(r.applyDeep({ v: [form] }).v[0], '[REDACTED:DEPLOY_TOKEN]', name);
  }
  for (const prefix of ['', 'u', 'us', 'user:', 'ci-bot:', 'deploy-bot:']) {
    const header = Buffer.from(`${prefix}${value}:suffix`).toString('base64');
    const out = r.apply(`Authorization: Basic ${header}`);
    assert.ok(out.includes('[REDACTED:DEPLOY_TOKEN]'), `embedded at offset ${prefix.length}`);
    const urlHeader = Buffer.from(`${prefix}${value}`).toString('base64url');
    assert.ok(r.apply(urlHeader).includes('[REDACTED:DEPLOY_TOKEN]'), `url at ${prefix.length}`);
  }
  const line = `${JSON.stringify({ msg: `token ${value}` })}\n`;
  assert.equal(line.includes(value), false, 'the log line carries only the escaped form');
  assert.equal(r.apply(line), '{"msg":"token [REDACTED:DEPLOY_TOKEN]"}\n');
});

function streamText(r, chunks, opts) {
  const s = r.stream(opts);
  const parts = chunks.map((c) => s.push(c));
  parts.push(s.end());
  return opts?.binary ? Buffer.concat(parts) : parts.join('');
}

test('a value split across two and three chunks is redacted exactly once, in order', () => {
  const value = 'wbx-0123456789abcdef';
  const r = new Redactor();
  r.add(value, 'DEPLOY_TOKEN');
  const text = `first ${value} second\nthird ${value}`;
  const expected = 'first [REDACTED:DEPLOY_TOKEN] second\nthird [REDACTED:DEPLOY_TOKEN]';
  const start = text.indexOf(value);
  for (let i = start + 1; i < start + value.length; i++) {
    assert.equal(streamText(r, [text.slice(0, i), text.slice(i)]), expected, `split at ${i}`);
    for (let j = i + 1; j < start + value.length; j++) {
      const three = [text.slice(0, i), text.slice(i, j), text.slice(j)];
      assert.equal(streamText(r, three), expected, `split at ${i} and ${j}`);
    }
  }
  const s = r.stream();
  assert.equal(s.push('a finished line\n'), 'a finished line\n', 'nothing held without need');
  assert.equal(s.push(`x ${value.slice(0, 6)}`), 'x ', 'only a possible start is held');
  assert.equal(s.push(`${value.slice(6)} y`), '[REDACTED:DEPLOY_TOKEN] y');
  assert.equal(s.end(), '');
  assert.equal(streamText(r, [...text]), expected, 'one character per chunk');
});

test('streamed redaction equals whole-text redaction for overlapping values and byte chunks', () => {
  const r = new Redactor();
  r.add('abcdefgh', 'short');
  r.add('abcdefghij', 'long');
  r.add('défi-sécret', 'accent');
  const text = 'abcdefgh|abcdefghij|abcdefghi|défi-sécret|YWJjZGVmZ2hpag|abcdefg';
  const whole = r.apply(text);
  assert.equal(
    whole,
    '[REDACTED:short]|[REDACTED:long]|[REDACTED:short]i|[REDACTED:accent]|[REDACTED:long]|abcdefg',
  );
  const bytes = Buffer.from(text);
  let seed = 7;
  const next = () => (seed = (seed * 48271) % 2147483647);
  for (let round = 0; round < 200; round++) {
    const cuts = new Set();
    while (cuts.size < 1 + (round % 6)) cuts.add(1 + (next() % (bytes.length - 1)));
    const points = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
    const byteChunks = points.slice(1).map((end, i) => bytes.subarray(points[i], end));
    const out = streamText(r, byteChunks, { binary: true });
    assert.equal(out.toString(), whole, `byte cuts ${points.join(',')}`);
    const strChunks = points.slice(1).map((end, i) => text.slice(points[i], end));
    assert.equal(streamText(r, strChunks), r.apply(strChunks.join('')), `cuts ${points}`);
  }
});

test('a __proto__ key in a redacted object leaves Object.prototype untouched', () => {
  const r = new Redactor();
  r.add('wbx-proto-secret', 'tok');
  const input = JSON.parse(
    '{"__proto__": {"polluted": "wbx-proto-secret"}, "constructor": {"prototype": {"polluted": 1}},' +
      ' "ok": "wbx-proto-secret", "nested": [{"__proto__": {"polluted": 2}, "prototype": 3, "v": 4}]}',
  );
  const out = r.applyDeep(input);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
  assert.deepEqual(Object.keys(out), ['ok', 'nested']);
  assert.equal(out.ok, '[REDACTED:tok]');
  assert.equal(Object.getPrototypeOf(out.nested[0]), Object.prototype);
  assert.deepEqual(out.nested, [{ v: 4 }]);
});

test('a 1000-deep object or a cycle is refused with a code; 64 levels are walked', () => {
  const r = new Redactor();
  r.add('wbx-deep-secret', 'tok');
  const nest = (n, leaf) => {
    let v = leaf;
    for (let i = 0; i < n; i++) v = i % 2 ? { n: v } : [v];
    return v;
  };
  const code = { code: 'E_INVALID_PARAMS', data: { maxDepth: MAX_DEPTH } };
  assert.equal(MAX_DEPTH, 64);
  assert.throws(() => r.applyDeep(nest(1000, 'wbx-deep-secret')), code);
  assert.throws(() => r.applyDeep(nest(MAX_DEPTH + 1, 'x')), code);
  let v = r.applyDeep(nest(MAX_DEPTH, 'wbx-deep-secret'));
  while (typeof v !== 'string') v = Array.isArray(v) ? v[0] : v.n;
  assert.equal(v, '[REDACTED:tok]');
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.throws(() => r.applyDeep(cyclic), code);
});

test('200 secrets over 1 MiB of text are matched in one pass within a generous bound', (t) => {
  const r = new Redactor();
  const secrets = Array.from({ length: 200 }, () => `wbx-${randomBytes(12).toString('hex')}`);
  secrets.forEach((s, i) => r.add(s, `S${i}`));
  const parts = [];
  let size = 0;
  let planted = 0;
  for (let i = 0; size < 1 << 20; i++) {
    const s = secrets[i % secrets.length];
    const filler = `line ${i} ${randomBytes(30).toString('base64')} ${randomBytes(8).toString('hex')} `;
    const leak = i % 5 === 0 ? `${i % 10 === 0 ? s : Buffer.from(s).toString('base64')}\n` : '\n';
    if (i % 5 === 0) planted++;
    parts.push(filler, leak);
    size += filler.length + leak.length;
  }
  const text = parts.join('');
  const t0 = performance.now();
  const out = r.apply(text);
  const ms = performance.now() - t0;
  assert.equal(out.match(/\[REDACTED:S\d+\]/g).length, planted);
  for (const s of secrets) assert.equal(out.includes(s), false);
  t.diagnostic(`apply over ${text.length} chars with 200 secrets took ${ms.toFixed(0)} ms`);
  assert.ok(ms < 5000, `1 MiB with 200 secrets took ${ms.toFixed(0)} ms`);
});
