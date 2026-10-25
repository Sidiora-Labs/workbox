import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v, validate, assertValid } from '../src/schema.js';
import { validateParams, Methods, methodNames } from '../src/methods.js';
import { Codes } from '../src/errors.js';

test('validate reports every error with its path', () => {
  const s = v.object(
    {
      name: v.string({ min: 2 }),
      n: v.integer({ min: 0, max: 5 }),
      tags: v.array(v.enum(['a', 'b']), { max: 2 }),
      env: v.record(v.string(), { keyPattern: /^[A-Z_]+$/ }),
    },
    { required: ['name', 'n'] },
  );
  const r = validate(s, {
    name: 'x',
    n: 7.5,
    tags: ['a', 'c', 'b'],
    env: { ok: 'v', GOOD: 1 },
    extra: 1,
  });
  assert.equal(r.ok, false);
  const paths = r.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, [
    '$.env.GOOD',
    '$.env.ok',
    '$.extra',
    '$.n',
    '$.n',
    '$.name',
    '$.tags',
    '$.tags[1]',
  ]);
  assert.ok(validate(s, { name: 'ok', n: 3 }).ok);
  assert.equal(validate(s, { n: 1 }).errors[0].path, '$.name');
  assert.ok(validate(v.optional(v.string()), undefined).ok);
  assert.ok(validate(v.nullable(v.string()), null).ok);
  assert.equal(validate(v.string(), null).ok, false);
  assert.ok(validate(v.oneOf([v.string(), v.integer()]), 3).ok);
  assert.equal(validate(v.oneOf([v.string(), v.integer()]), true).ok, false);
});

test('assertValid throws an E_INVALID_PARAMS error with details', () => {
  assert.throws(
    () => assertValid(v.object({ a: v.boolean() }, { required: ['a'] }), {}),
    (e) => e.code === 'E_INVALID_PARAMS' && e.data.errors[0].path === '$.a',
  );
});

test('method catalogue validates params and rejects unknown methods', () => {
  assert.deepEqual(validateParams('session.start', { argv: ['sh'] }), { argv: ['sh'] });
  assert.throws(
    () => validateParams('session.start', { argv: [] }),
    (e) => e.code === Codes.INVALID_PARAMS && e.data.errors[0].path === '$.argv',
  );
  assert.throws(
    () => validateParams('session.start', { argv: ['sh'], env: { 'bad-key': 'x' } }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('nope.method', {}),
    (e) => e.code === Codes.UNKNOWN_METHOD,
  );
  assert.throws(
    () =>
      validateParams('broker.artifact.put', {
        outboxName: '../x',
        sha256: 'f'.repeat(64),
        size: 1,
      }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.ok(
    validateParams('broker.ask.raise', {
      kind: 'decision',
      title: 'Pick',
      options: ['a', 'b'],
      recommended: 'a',
    }),
  );
  for (const name of methodNames())
    assert.ok(Methods[name].doc.length > 10, `${name} has a doc line`);
});
