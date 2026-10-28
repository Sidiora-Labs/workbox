import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { issueLease, leaseStatus, leaseRenew, hashToken } from '../../../src/broker/leases.js';

test('issue stores only the hash; status and renew work without leaking the token', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const c = { store, sandboxId: sb.id, leaseTtlMs: 60_000 };
  const issued = issueLease(c);
  assert.ok(issued.token);
  const stored = store.getLease(sb.id);
  assert.equal(stored.token, hashToken(issued.token));
  assert.ok(
    !JSON.stringify(stored).includes(issued.token.replace('sha256:', '')) ||
      stored.token.startsWith('sha256:'),
  );
  const status = leaseStatus(c).lease;
  assert.equal(status.expired, false);
  assert.equal(status.token, undefined);
  const renewed = leaseRenew(c, { ttlMs: 120_000 }).lease;
  assert.ok(renewed.remainingMs > 60_000);
  store.close();
});
