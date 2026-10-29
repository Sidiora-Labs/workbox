import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxVisible, isBound, requireUnbound, createLabels } from '../../src/access.js';

const sb = (id, labels) => ({ id, labels });
const unbound = { id: 'root', scopes: ['admin'], binding: null };
const byLabels = { id: 'key_a', scopes: ['admin'], binding: { labels: { team: 'a', env: 'ci' } } };
const byIds = { id: 'key_b', scopes: ['read'], binding: { sandboxIds: ['sb-2', 'sb-3'] } };
const both = {
  id: 'key_c',
  scopes: ['read'],
  binding: { labels: { team: 'a' }, sandboxIds: ['sb-9'] },
};

test('an unbound principal sees every sandbox; nobody sees a missing one', () => {
  assert.equal(isBound(unbound), false);
  assert.equal(isBound({ id: 'legacy', scopes: ['read'] }), false);
  assert.equal(isBound(null), false);
  assert.equal(sandboxVisible(unbound, sb('sb-1', {})), true);
  assert.equal(sandboxVisible({ id: 'legacy', scopes: ['read'] }, sb('sb-1')), true);
  assert.equal(sandboxVisible(unbound, null), false);
  assert.equal(sandboxVisible(null, sb('sb-1', {})), false);
});

test('a label binding needs every label to match exactly', () => {
  assert.equal(isBound(byLabels), true);
  assert.equal(sandboxVisible(byLabels, sb('sb-1', { team: 'a', env: 'ci', x: 'y' })), true);
  assert.equal(sandboxVisible(byLabels, sb('sb-1', { team: 'a' })), false);
  assert.equal(sandboxVisible(byLabels, sb('sb-1', { team: 'a', env: 'cd' })), false);
  assert.equal(sandboxVisible(byLabels, sb('sb-1', { team: 'a', env: 1 })), false);
  assert.equal(sandboxVisible(byLabels, sb('sb-1', {})), false);
  assert.equal(sandboxVisible(byLabels, sb('sb-1')), false);
  const inherited = Object.create({ team: 'a', env: 'ci' });
  assert.equal(sandboxVisible(byLabels, sb('sb-1', inherited)), false, 'own labels only');
});

test('an id binding sees its ids; ids and labels together are either', () => {
  assert.equal(sandboxVisible(byIds, sb('sb-2', {})), true);
  assert.equal(sandboxVisible(byIds, sb('sb-3', { team: 'a' })), true);
  assert.equal(sandboxVisible(byIds, sb('sb-4', { team: 'a', env: 'ci' })), false);
  assert.equal(sandboxVisible(both, sb('sb-9', {})), true);
  assert.equal(sandboxVisible(both, sb('sb-5', { team: 'a' })), true);
  assert.equal(sandboxVisible(both, sb('sb-5', { team: 'b' })), false);
  const empty = { id: 'key_e', scopes: ['read'], binding: {} };
  assert.equal(isBound(empty), true);
  assert.equal(sandboxVisible(empty, sb('sb-1', {})), false, 'an empty binding sees nothing');
});

test('requireUnbound refuses a bound principal with E_DENIED', () => {
  requireUnbound(unbound);
  requireUnbound(null);
  for (const p of [byLabels, byIds, both])
    assert.throws(
      () => requireUnbound(p),
      (e) => e.code === 'E_DENIED' && e.status === 403 && /not bound to sandboxes/.test(e.message),
    );
});

test('createLabels forces a label binding and refuses conflicts and id-only bindings', () => {
  const given = { role: 'worker' };
  assert.equal(createLabels(unbound, given), given);
  assert.equal(createLabels(unbound, undefined), undefined);
  assert.deepEqual(createLabels(byLabels, undefined), { team: 'a', env: 'ci' });
  assert.deepEqual(createLabels(byLabels, given), { role: 'worker', team: 'a', env: 'ci' });
  assert.deepEqual(given, { role: 'worker' }, 'the request labels are not changed');
  assert.deepEqual(createLabels(byLabels, { team: 'a' }), { team: 'a', env: 'ci' });
  assert.deepEqual(createLabels(both, {}), { team: 'a' });
  assert.throws(
    () => createLabels(byLabels, { team: 'b' }),
    (e) => e.code === 'E_DENIED' && /label team must be "a"/.test(e.message),
  );
  assert.throws(
    () => createLabels(byIds, {}),
    (e) => e.code === 'E_DENIED' && /sandbox ids cannot create/.test(e.message),
  );
});
