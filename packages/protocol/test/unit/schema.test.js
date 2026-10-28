import { test } from 'node:test';
import assert from 'node:assert/strict';
import { v, validate, assertValid, MAX_DEPTH, MAX_NODES } from '../../src/schema.js';
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
  assert.equal(validate(v.string({ max: 1 }), 'ab').errors[0].message, 'must have at most 1 bytes');
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

test('string bounds count UTF-8 bytes, not UTF-16 code units', () => {
  const emoji = '😀';
  assert.equal(emoji.length, 2);
  assert.equal(validate(v.string({ max: 4 }), emoji).ok, true);
  const over = validate(v.string({ max: 3 }), emoji);
  assert.equal(over.ok, false);
  assert.equal(over.errors[0].message, 'must have at most 3 bytes');
  assert.equal(validate(v.string({ max: 3 }), 'éé').ok, false, '2 characters, 4 bytes');
  assert.equal(validate(v.string({ min: 4 }), emoji).ok, true);
  assert.equal(validate(v.string({ max: 8 }), emoji.repeat(2)).ok, true);
  assert.equal(validate(v.string({ max: 7 }), emoji.repeat(2)).ok, false);
});

test('a 1000-deep document is refused with a coded result, not a stack overflow', () => {
  let deep = {};
  for (let i = 0; i < 1000; i++) deep = { child: deep };
  const node = v.optional(v.object({}));
  node.props.child = node;
  const r = validate(node, deep);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].limit, 'depth');
  assert.match(r.errors[0].message, new RegExp(`maximum depth of ${MAX_DEPTH}`));
  const viaAny = validate(v.object({ data: v.any() }), { data: deep });
  assert.equal(viaAny.ok, false);
  assert.equal(viaAny.errors[0].limit, 'depth');
  assert.equal(viaAny.errors[0].path, '$.data');
  assert.throws(
    () => assertValid(v.record(v.any()), { x: deep }),
    (e) => e.code === 'E_INVALID_PARAMS' && e.data.errors[0].limit === 'depth',
  );
  assert.throws(
    () => validateParams('broker.evidence.record', { envelope: { body: deep } }),
    (e) => e.code === Codes.INVALID_PARAMS && e.data.errors[0].path === '$.envelope.body',
  );
  let ok = 'leaf';
  for (let i = 0; i < MAX_DEPTH; i++) ok = [ok];
  assert.equal(validate(v.any(), ok).ok, true, 'exactly MAX_DEPTH levels is allowed');
  assert.equal(validate(v.any(), [ok]).errors[0].limit, 'depth');
  let nested = v.string();
  for (let i = 0; i < 70; i++) nested = v.oneOf([v.array(nested)]);
  let value = 'x';
  for (let i = 0; i < 70; i++) value = [value];
  assert.equal(validate(nested, value).errors[0].limit, 'depth', 'oneOf shares the budget');
});

test('a document with too many values is refused with a coded result', () => {
  const wide = Array.from({ length: MAX_NODES + 1 }, () => 0);
  const r = validate(v.array(v.integer()), wide);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.length, 1);
  assert.equal(r.errors[0].limit, 'nodes');
  assert.equal(validate(v.any(), wide).errors[0].limit, 'nodes');
  assert.equal(validate(v.array(v.integer()), wide.slice(2)).ok, true);
  const small = validate(v.record(v.any()), { a: [1, 2], b: { c: 3 } }, '$', { maxNodes: 4 });
  assert.equal(small.errors[0].limit, 'nodes');
  assert.equal(validate(v.any(), { a: { b: 1 } }, '$', { maxDepth: 1 }).errors[0].limit, 'depth');
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.equal(validate(v.any(), cyclic).errors[0].limit, 'depth');
});
