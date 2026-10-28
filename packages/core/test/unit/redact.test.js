import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, MIN_LENGTH } from '../../src/redact.js';

test('redacts registered values, longest first, in text and nested objects', () => {
  const r = new Redactor();
  assert.equal(r.add('short'), false);
  assert.equal(MIN_LENGTH, 6);
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
  const empty = new Redactor();
  assert.equal(empty.apply('x'), 'x');
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
