import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v, validate, assertValid } from '../../src/schema.js';
import { validateParams, Methods, methodNames } from '../../src/methods.js';
import { Codes } from '../../src/errors.js';

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

test('every kind rejects the wrong primitive type', () => {
  const cases = [
    [v.string(), 1, 'must be a string'],
    [v.integer(), 'x', 'must be a number'],
    [v.number(), NaN, 'must be a number'],
    [v.boolean(), 'true', 'must be a boolean'],
    [v.array(v.any()), {}, 'must be an array'],
    [v.object({}), [], 'must be an object'],
    [v.record(v.any()), [], 'must be an object'],
    [{ kind: 'mystery' }, 1, 'unknown schema kind mystery'],
  ];
  for (const [schema, value, message] of cases) {
    const r = validate(schema, value);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].message, message);
  }
  assert.ok(validate(v.any(), { anything: [1, null] }).ok);
  assert.equal(
    validate(v.array(v.integer(), { min: 2 }), [1]).errors[0].message,
    'must have at least 2 items',
  );
  assert.equal(
    validate(v.string({ max: 1 }), 'ab').errors[0].message,
    'must have at most 1 characters',
  );
  assert.equal(validate(v.integer({ max: 1 }), 2).errors[0].message, 'must be <= 1');
  assert.equal(
    validate(v.object({ a: v.string() }, { additional: true }), { a: 'x', b: 1 }).ok,
    true,
  );
  assert.equal(
    validate(v.record(v.string(), { max: 1 }), { a: 'x', b: 'y' }).errors[0].message,
    'must have at most 1 keys',
  );
});
