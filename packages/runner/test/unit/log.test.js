import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLog, LEVELS } from '../../src/log.js';

test('runner log writes JSON lines, filters by level and flattens errors', () => {
  const lines = [];
  const log = createLog({
    level: 'info',
    stream: { write: (s) => lines.push(s) },
    clock: () => 0,
    component: 'r',
  });
  log.debug('no');
  log.info('hi', { a: 1, err: Object.assign(new Error('bad'), { code: 'E_X' }) });
  log.warn('w');
  log.error('e');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[0]), {
    ts: '1970-01-01T00:00:00.000Z',
    level: 'info',
    component: 'r',
    msg: 'hi',
    a: 1,
    err: { name: 'Error', message: 'bad', code: 'E_X' },
  });
  assert.equal(log.level, 'info');
  assert.equal(log.component, 'r');
  assert.throws(() => createLog({ level: 'loud' }), RangeError);
  assert.equal(LEVELS.silent, 100);
  const quiet = createLog({ level: 'silent', stream: { write: () => lines.push('x') } });
  quiet.error('ignored');
  assert.equal(lines.length, 3);
});
