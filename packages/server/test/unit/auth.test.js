import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashToken, SCOPES } from '../../src/auth.js';

test('bearer auth with hashed tokens and scope checks', () => {
  const auth = createAuth({
    keys: [
      { id: 'ro', token: 'read-token', scopes: ['read'] },
      { id: 'root', tokenSha256: hashToken('admin-token'), scopes: ['admin'] },
    ],
  });
  assert.equal(SCOPES.length, 4);
  const ro = auth.authenticate('Bearer read-token');
  assert.equal(ro.id, 'ro');
  assert.equal(auth.authorize(ro, 'read'), true);
  assert.equal(auth.authorize(ro, 'exec'), false);
  assert.equal(
    auth.authorize(auth.authenticate('Bearer admin-token'), 'exec'),
    true,
    'admin implies all',
  );
  assert.equal(auth.authenticate('Bearer wrong'), null);
  assert.equal(auth.authenticate(undefined), null);
  assert.throws(
    () => createAuth({ keys: [{ id: 'x', token: 't', scopes: ['nope'] }] }),
    /unknown scope/,
  );
});
