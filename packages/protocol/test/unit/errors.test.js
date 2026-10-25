import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Codes, ProtocolError, isProtocolError } from '../../src/errors.js';

test('ProtocolError keeps known codes and falls back to E_INTERNAL', () => {
  const e = new ProtocolError(Codes.DENIED, 'no', { why: 1 });
  assert.equal(e.code, 'E_DENIED');
  assert.equal(e.name, 'ProtocolError');
  assert.deepEqual(e.toJSON(), { code: 'E_DENIED', message: 'no', data: { why: 1 } });
  assert.deepEqual(new ProtocolError(Codes.BUSY, 'b').toJSON(), { code: 'E_BUSY', message: 'b' });
  assert.equal(new ProtocolError('E_MADE_UP', 'x').code, 'E_INTERNAL');
  assert.ok(isProtocolError(e));
  assert.equal(isProtocolError(new Error('x')), false);
});

test('ProtocolError.from normalises foreign errors', () => {
  const pe = new ProtocolError(Codes.GAP, 'g');
  assert.equal(ProtocolError.from(pe), pe);
  const wire = ProtocolError.from({ code: 'E_NOT_FOUND', message: 'missing', data: { id: 'x' } });
  assert.equal(wire.code, 'E_NOT_FOUND');
  assert.deepEqual(wire.data, { id: 'x' });
  const plain = ProtocolError.from(new RangeError('bad range'));
  assert.equal(plain.code, 'E_INTERNAL');
  assert.equal(plain.message, 'bad range');
  assert.equal(ProtocolError.from(undefined).message, 'internal error');
  assert.equal(ProtocolError.from({ code: 'E_UNKNOWN_CODE', message: 'm' }).code, 'E_INTERNAL');
  assert.equal(Object.isFrozen(Codes), true);
});
