import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Codes, ProtocolError } from '@workbox/protocol';
import { WorkboxError, E, httpStatusFor } from '../../src/errors.js';

test('WorkboxError maps codes to HTTP statuses and serialises', () => {
  const e = E.notFound('missing', { id: 'x' });
  assert.equal(e.code, Codes.NOT_FOUND);
  assert.equal(e.status, 404);
  assert.equal(e.name, 'WorkboxError');
  assert.deepEqual(e.toJSON(), { code: 'E_NOT_FOUND', message: 'missing', data: { id: 'x' } });
  assert.deepEqual(E.busy('b').toJSON(), { code: 'E_BUSY', message: 'b' });
  assert.equal(E.conflict('c').status, 409);
  assert.equal(E.invalid('i').status, 400);
  assert.equal(E.state('s').status, 409);
  assert.equal(E.denied('d').status, 403);
  assert.equal(E.unavailable('u').status, 503);
  assert.equal(E.timeout('t').status, 504);
  assert.equal(E.limit('l').status, 429);
  assert.equal(E.unsupported('u').status, 501);
  assert.equal(E.quarantined('q').status, 423);
  assert.equal(E.internal('x').status, 500);
  assert.equal(new WorkboxError('E_NOPE', 'x').code, Codes.INTERNAL);
  assert.equal(httpStatusFor('E_GAP'), 416);
  assert.equal(httpStatusFor('E_WHATEVER'), 500);
});

test('toProtocol and from round-trip across the wire types', () => {
  const e = E.denied('no', { why: 1 });
  const pe = e.toProtocol();
  assert.ok(pe instanceof ProtocolError);
  assert.equal(pe.code, 'E_DENIED');
  assert.deepEqual(pe.data, { why: 1 });
  const back = WorkboxError.from(pe);
  assert.equal(back.status, 403);
  assert.deepEqual(back.data, { why: 1 });
  assert.equal(WorkboxError.from(e), e);
  assert.equal(WorkboxError.from({ code: 'E_LIMIT', message: 'slow down' }).status, 429);
  const foreign = WorkboxError.from(new RangeError('bad'));
  assert.equal(foreign.code, Codes.INTERNAL);
  assert.equal(foreign.message, 'bad');
  assert.ok(foreign.cause instanceof RangeError);
  assert.equal(WorkboxError.from('text').message, 'text');
  assert.equal(WorkboxError.from({ code: 'E_UNKNOWN_THING', message: 'm' }).code, Codes.INTERNAL);
});
