import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  States,
  Health,
  TRANSITIONS,
  LIVE_STATES,
  canTransition,
  assertTransition,
  isLive,
  isTerminal,
} from '../../../src/sandbox/state.js';

test('state vocabulary matches the specification', () => {
  assert.deepEqual(Object.keys(States), [
    'REQUESTED',
    'PROVISIONING',
    'BOOTSTRAPPING',
    'READY',
    'DRAINING',
    'DELETING',
    'DELETED',
    'QUARANTINED',
  ]);
  assert.deepEqual(Object.keys(Health), ['HEALTHY', 'SUSPECT', 'UNKNOWN', 'ABSENT']);
  assert.ok(Object.isFrozen(TRANSITIONS) && Object.isFrozen(TRANSITIONS.READY));
  for (const s of Object.keys(States)) assert.ok(Array.isArray(TRANSITIONS[s]), s);
  assert.deepEqual(TRANSITIONS.DELETED, []);
  assert.deepEqual(LIVE_STATES, [
    'PROVISIONING',
    'BOOTSTRAPPING',
    'READY',
    'DRAINING',
    'QUARANTINED',
  ]);
});

test('the happy path and every quarantine branch are legal; skips are not', () => {
  const happy = [
    'REQUESTED',
    'PROVISIONING',
    'BOOTSTRAPPING',
    'READY',
    'DRAINING',
    'DELETING',
    'DELETED',
  ];
  for (let i = 0; i < happy.length - 1; i++)
    assert.ok(canTransition(happy[i], happy[i + 1]), `${happy[i]} -> ${happy[i + 1]}`);
  for (const s of ['PROVISIONING', 'BOOTSTRAPPING', 'READY', 'DRAINING', 'DELETING'])
    assert.ok(canTransition(s, 'QUARANTINED'), s);
  assert.ok(canTransition('QUARANTINED', 'DELETING'));
  assert.ok(canTransition('QUARANTINED', 'DRAINING'));
  assert.equal(canTransition('REQUESTED', 'READY'), false);
  assert.equal(canTransition('READY', 'PROVISIONING'), false);
  assert.equal(canTransition('DELETED', 'READY'), false);
  assert.equal(canTransition('BOGUS', 'READY'), false);
  assert.throws(
    () => assertTransition('READY', 'REQUESTED'),
    (e) => e.code === 'E_STATE' && e.data.from === 'READY' && e.data.allowed.includes('DRAINING'),
  );
  assert.throws(
    () => assertTransition('READY', 'NOPE'),
    (e) => e.code === 'E_INVALID_PARAMS',
  );
  assert.doesNotThrow(() => assertTransition('READY', 'DRAINING'));
  assert.ok(isLive('READY'));
  assert.equal(isLive('REQUESTED'), false);
  assert.equal(isLive('DELETED'), false);
  assert.ok(isTerminal('DELETED'));
  assert.equal(isTerminal('DELETING'), false);
});
