import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import {
  eventEmit,
  assertBoundedJson,
  appendLogged,
  RESERVED_EVENT_PREFIXES,
} from '../../../src/broker/events.js';

test('emit appends with sequence; deep/huge payloads rejected', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const out = eventEmit({ store, sandboxId: sb.id }, { type: 'build.done', payload: { ok: true } });
  assert.equal(out.seq, 1);
  assert.equal(store.listEvents(sb.id)[0].payload.ok, true);
  assert.equal(store.listEvents(sb.id)[0].source, 'wb');
  let deep = {};
  for (let i = 0; i < 40; i++) deep = { a: deep };
  assert.throws(() => assertBoundedJson(deep), /too deeply/);
  store.close();
});

test('wb may not emit a type under a prefix the host records', () => {
  const store = Store.open(':memory:');
  try {
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const ctx = { store, sandboxId: sb.id };
    assert.deepEqual(RESERVED_EVENT_PREFIXES, [
      'sandbox.',
      'session.',
      'exec.',
      'ask.',
      'checkpoint.',
      'artifact.',
      'webhook.',
      'key.',
    ]);
    for (const prefix of RESERVED_EVENT_PREFIXES)
      assert.throws(
        () => eventEmit(ctx, { type: `${prefix}forged`, payload: { x: 1 } }),
        (e) => e.code === 'E_INVALID_PARAMS' && e.data.prefix === prefix,
        prefix,
      );
    assert.deepEqual(store.listEvents(sb.id), [], 'nothing reserved reached the log');
    for (const type of ['sandboxes.listed', 'sessionx', 'build.session.done', 'keys'])
      assert.equal(eventEmit(ctx, { type }).type, type);
    assert.equal(store.listEvents(sb.id).length, 4);
  } finally {
    store.close();
  }
});

test('without an engine hook appendLogged writes a host event straight to the store', () => {
  const store = Store.open(':memory:');
  try {
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const seq = appendLogged({ store, sandboxId: sb.id }, 'artifact.added', { size: 1 });
    const row = store.getEvent(seq);
    assert.deepEqual(
      [row.sandboxId, row.type, row.source, row.payload],
      [sb.id, 'artifact.added', 'host', { size: 1 }],
    );
  } finally {
    store.close();
  }
});
