import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { SecretProvider } from '../../../src/secrets.js';
import { secretList, secretResolve } from '../../../src/broker/secrets.js';

test('policy gates resolution; list shows configured refs only', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  store.setSecretPolicy(sb.id, ['DEPLOY_TOKEN', 'MISSING']);
  const secrets = new SecretProvider({
    env: { WORKBOX_SECRET_DEPLOY_TOKEN: 'deploy-value-1', WORKBOX_SECRET_OTHER: 'other-value-2' },
  });
  const c = { store, sandboxId: sb.id, secrets };
  assert.deepEqual(secretList(c).refs, ['DEPLOY_TOKEN']);
  assert.deepEqual(secretResolve(c, { refs: ['DEPLOY_TOKEN'] }).env, {
    DEPLOY_TOKEN: 'deploy-value-1',
  });
  assert.throws(() => secretResolve(c, { refs: ['OTHER'] }), /outside this sandbox/);
  store.close();
});
