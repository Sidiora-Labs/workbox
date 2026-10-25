import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  request,
  ok,
  fail,
  event,
  isRequest,
  isResponse,
  isEvent,
  kindOf,
} from '../../src/envelope.js';

test('constructors produce the documented shapes', () => {
  assert.deepEqual(request('1', 'm'), { t: 'req', id: '1', m: 'm', p: {} });
  assert.deepEqual(request('1', 'm', { a: 1 }), { t: 'req', id: '1', m: 'm', p: { a: 1 } });
  assert.deepEqual(ok('1'), { t: 'res', id: '1', ok: true, r: null });
  assert.deepEqual(ok('1', 5), { t: 'res', id: '1', ok: true, r: 5 });
  assert.deepEqual(fail('1', { code: 'E_X', message: 'no' }), {
    t: 'res',
    id: '1',
    ok: false,
    e: { code: 'E_X', message: 'no' },
  });
  assert.deepEqual(fail('1', { code: 'E_X', message: 'no', data: { k: 1 } }).e.data, { k: 1 });
  assert.deepEqual(event('m'), { t: 'evt', m: 'm', p: {} });
});

test('type guards accept valid envelopes and reject malformed ones', () => {
  assert.ok(isRequest(request('1', 'm')));
  assert.ok(isResponse(ok('1', 1)));
  assert.ok(isResponse(fail('1', { code: 'E', message: 'x' })));
  assert.ok(isEvent(event('m', 1)));
  for (const bad of [
    null,
    1,
    'x',
    [],
    {},
    { t: 'req' },
    { t: 'req', id: 1, m: 'm' },
    { t: 'req', id: '1', m: '' },
    { t: 'res', id: '1' },
    { t: 'res', id: '1', ok: false, e: {} },
    { t: 'evt', m: 7 },
  ]) {
    assert.equal(isRequest(bad), false, JSON.stringify(bad));
    assert.equal(isResponse(bad), false, JSON.stringify(bad));
    assert.equal(isEvent(bad), false, JSON.stringify(bad));
    assert.equal(kindOf(bad), null, JSON.stringify(bad));
  }
  assert.equal(kindOf(request('1', 'm')), 'req');
  assert.equal(kindOf(ok('1')), 'res');
  assert.equal(kindOf(event('m')), 'evt');
});
