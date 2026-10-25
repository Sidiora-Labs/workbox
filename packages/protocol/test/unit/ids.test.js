import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, isId, idTime } from '../../src/ids.js';

test('ids are 26 chars, unique and time-ordered', () => {
  const t0 = 1_700_000_000_000;
  const a = newId(t0);
  const b = newId(t0 + 1);
  assert.equal(a.length, 26);
  assert.ok(isId(a));
  assert.ok(a < b);
  assert.equal(idTime(a), t0);
  assert.equal(idTime(b), t0 + 1);
  const set = new Set(Array.from({ length: 2000 }, () => newId()));
  assert.equal(set.size, 2000);
  assert.ok(!isId('not-an-id'));
  assert.ok(!isId(a.toLowerCase()));
});
