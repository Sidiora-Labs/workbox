import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, nullLogger, errorToJSON, LEVELS } from '../../src/log.js';
import { Redactor } from '../../src/redact.js';
import { fakeClock } from '../helpers/tmp.js';

function sink() {
  const lines = [];
  return { lines, write: (s) => (lines.push(s), true) };
}

test('writes JSON lines with ts, level, component and data, honouring the threshold', () => {
  const s = sink();
  const log = createLogger({ component: 'core', level: 'info', stream: s, clock: fakeClock(0) });
  log.debug('hidden');
  log.info('hello', { a: 1 });
  log.warn('careful');
  log.error('bad', { err: Object.assign(new Error('boom'), { code: 'E_X', data: { k: 1 } }) });
  assert.equal(s.lines.length, 3);
  const first = JSON.parse(s.lines[0]);
  assert.deepEqual(first, {
    ts: '1970-01-01T00:00:00.000Z',
    level: 'info',
    component: 'core',
    msg: 'hello',
    a: 1,
  });
  const err = JSON.parse(s.lines[2]).err;
  assert.equal(err.name, 'Error');
  assert.equal(err.code, 'E_X');
  assert.deepEqual(err.data, { k: 1 });
  assert.ok(err.stack.split('\n').length <= 8);
  assert.equal(log.level, 'info');
  assert.equal(log.component, 'core');
  assert.deepEqual(Object.keys(LEVELS), ['debug', 'info', 'warn', 'error', 'silent']);
});

test('child loggers extend the component; redactor scrubs the line', () => {
  const s = sink();
  const r = new Redactor();
  r.add('supersecret', 'tok');
  const log = createLogger({ component: 'core', level: 'debug', stream: s, redactor: r });
  const child = log.child('store');
  child.debug('opened supersecret', { token: 'supersecret' });
  const rec = JSON.parse(s.lines[0]);
  assert.equal(rec.component, 'core.store');
  assert.equal(rec.msg, 'opened [REDACTED:tok]');
  assert.equal(rec.token, '[REDACTED:tok]');
  assert.throws(() => createLogger({ level: 'loud' }), RangeError);
  const quiet = nullLogger();
  quiet.error('ignored');
  assert.equal(quiet.level, 'silent');
  const env = process.env.WORKBOX_LOG_LEVEL;
  process.env.WORKBOX_LOG_LEVEL = 'warn';
  try {
    assert.equal(createLogger({ stream: s }).level, 'warn');
  } finally {
    if (env === undefined) delete process.env.WORKBOX_LOG_LEVEL;
    else process.env.WORKBOX_LOG_LEVEL = env;
  }
});

test('errorToJSON includes causes and tolerates missing fields', () => {
  const inner = new TypeError('inner');
  const outer = new Error('outer', { cause: inner });
  const j = errorToJSON(outer);
  assert.equal(j.cause.name, 'TypeError');
  assert.equal(j.cause.message, 'inner');
  const bare = errorToJSON({ name: 'X', message: 'm' });
  assert.deepEqual(bare, { name: 'X', message: 'm' });
});
