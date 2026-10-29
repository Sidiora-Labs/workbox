import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Methods,
  Events,
  PROTOCOL_VERSION,
  SESSION_READ_DEFAULT_BYTES,
  SESSION_READ_MAX_BYTES,
  validateParams,
  isBrokerMethod,
  methodNames,
} from '../../src/methods.js';
import { validate } from '../../src/schema.js';
import { Codes } from '../../src/errors.js';

test('catalogue is complete, documented and frozen', () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.ok(Object.isFrozen(Methods));
  assert.ok(Object.isFrozen(Events));
  const names = methodNames();
  assert.deepEqual(names, [...names].sort());
  for (const n of names) {
    assert.ok(Methods[n].doc.length > 10, n);
    assert.equal(Methods[n].params.kind, 'object', n);
  }
  assert.equal(names.filter(isBrokerMethod).length, 19);
  assert.equal(isBrokerMethod('session.start'), false);
});

test('validateParams enforces each method schema', () => {
  assert.deepEqual(validateParams('runner.status'), {});
  assert.deepEqual(validateParams('runner.hello', { protocol: 1 }), { protocol: 1 });
  assert.throws(
    () => validateParams('runner.hello', { protocol: 0 }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('runner.hello', { protocol: 1, role: 'admin' }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('runner.go', { network: { mode: 'open' } }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('session.signal', { sessionId: 's', signal: 'TERM' }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.ok(validateParams('session.signal', { sessionId: 's', signal: 'SIGTERM' }));
  assert.throws(
    () => validateParams('session.input', { sessionId: 's', data: '!!' }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('fs.write', { path: '', data: '' }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('broker.event.emit', { type: 'Bad.Type' }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('broker.preset.manifest', { name: 'Web', manifest: {} }),
    (e) => e.code === Codes.INVALID_PARAMS,
  );
  assert.throws(
    () => validateParams('session.start', { argv: ['x'], unknown: 1 }),
    (e) => e.data.errors[0].path === '$.unknown',
  );
  assert.throws(
    () => validateParams('missing.method'),
    (e) => e.code === Codes.UNKNOWN_METHOD,
  );
});

test('session.read takes a session, a start sequence and a byte budget of at most 4 MiB', () => {
  assert.equal(SESSION_READ_DEFAULT_BYTES, 1024 * 1024);
  assert.equal(SESSION_READ_MAX_BYTES, 4 * 1024 * 1024);
  assert.deepEqual(validateParams('session.read', { sessionId: 's' }), { sessionId: 's' });
  assert.ok(
    validateParams('session.read', {
      sessionId: 's',
      fromSeq: 7,
      maxBytes: SESSION_READ_MAX_BYTES,
    }),
  );
  for (const bad of [
    {},
    { sessionId: 's', fromSeq: -1 },
    { sessionId: 's', maxBytes: 0 },
    { sessionId: 's', maxBytes: SESSION_READ_MAX_BYTES + 1 },
  ])
    assert.throws(
      () => validateParams('session.read', bad),
      (e) => e.code === Codes.INVALID_PARAMS,
      JSON.stringify(bad),
    );
});

test('event schemas accept the runner event shapes', () => {
  assert.ok(
    validate(Events['session.output'], { sessionId: 's', stream: 'stdout', seq: 0, data: 'aGk=' })
      .ok,
  );
  assert.equal(
    validate(Events['session.output'], { sessionId: 's', stream: 'tty', seq: 0, data: '' }).ok,
    false,
  );
  assert.ok(
    validate(Events['session.exit'], { sessionId: 's', code: 0, signal: null, seq: 3, at: 1 }).ok,
  );
  assert.ok(
    validate(Events['session.exit'], {
      sessionId: 's',
      code: null,
      signal: 'SIGKILL',
      seq: 3,
      at: 1,
    }).ok,
  );
  assert.ok(
    validate(Events['session.started'], {
      sessionId: 's',
      name: null,
      pid: 4,
      argv: ['sh'],
      startedAt: 1,
    }).ok,
  );
  assert.ok(validate(Events['runner.log'], { level: 'info', msg: 'hi' }).ok);
  assert.ok(validate(Events['ask.answered'], { askId: 'a', answer: 'yes' }).ok);
});
