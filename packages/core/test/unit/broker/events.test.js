import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { eventEmit, assertBoundedJson } from '../../../src/broker/events.js';

test('emit appends with sequence; deep/huge payloads rejected', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const out = eventEmit({ store, sandboxId: sb.id }, { type: 'build.done', payload: { ok: true } });
  assert.equal(out.seq, 1);
  assert.equal(store.listEvents(sb.id)[0].payload.ok, true);
  let deep = {};
  for (let i = 0; i < 40; i++) deep = { a: deep };
  assert.throws(() => assertBoundedJson(deep), /too deeply/);
  store.close();
});
