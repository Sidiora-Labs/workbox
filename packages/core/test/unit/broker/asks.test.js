import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import {
  askRaise,
  askStatus,
  askList,
  askWait,
  answerAskHost,
  validateAnswer,
} from '../../../src/broker/asks.js';

function ctx() {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  return { store, sandboxId: sb.id };
}

test('raise -> host answer -> wait resolves; kind schemas enforced', async () => {
  const c = ctx();
  const ask = askRaise(c, { kind: 'decision', title: 'pick', options: ['a', 'b'] });
  assert.equal(askStatus(c, { askId: ask.askId }).status, 'open');
  assert.equal(askList(c, {}).asks.length, 1);
  assert.throws(() => answerAskHost(c, ask.askId, { answer: 'c' }), /one of the options/);
  setTimeout(() => answerAskHost(c, ask.askId, { answer: 'b', by: 'op' }), 30);
  const waited = await askWait(c, { askId: ask.askId, timeoutMs: 5000 }, { pollMs: 10 });
  assert.equal(waited.answer, 'b');
  assert.throws(() => validateAnswer({ kind: 'permission' }, 'yes'), /boolean/);
  assert.throws(() => validateAnswer({ kind: 'secret' }, 'not a ref!'), /reference name/);
  c.store.close();
});

test('wait times out and other sandboxes cannot see the ask', async () => {
  const c = ctx();
  const ask = askRaise(c, { kind: 'question', title: 'q?' });
  await assert.rejects(
    () => askWait(c, { askId: ask.askId, timeoutMs: 50 }, { pollMs: 10 }),
    /not answered/,
  );
  assert.throws(() => askStatus({ ...c, sandboxId: 'other' }, { askId: ask.askId }), /not found/);
  c.store.close();
});
