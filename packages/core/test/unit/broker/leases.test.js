import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../../src/store.js';
import { issueLease, leaseStatus, leaseRenew, hashToken } from '../../../src/broker/leases.js';
import { tmpDir, fakeClock } from '../../helpers/tmp.js';

test('issue stores only the hash; status and renew work without leaking the token', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const c = { store, sandboxId: sb.id, leaseTtlMs: 60_000 };
  const issued = issueLease(c);
  assert.ok(issued.token);
  const stored = store.getLease(sb.id);
  assert.equal(stored.token, hashToken(issued.token));
  assert.equal(JSON.stringify(stored).includes(issued.token), false);
  const status = leaseStatus(c).lease;
  assert.equal(status.expired, false);
  assert.equal(status.token, undefined);
  const renewed = leaseRenew(c, { ttlMs: 120_000 }).lease;
  assert.ok(renewed.remainingMs > 60_000);
  assert.equal(renewed.token, undefined);
  store.close();
});

test('a presented token reaches the store as presented: the stored digest is refused', () => {
  const t = tmpDir();
  try {
    const file = path.join(t.dir, 'workbox.db');
    const clock = fakeClock();
    const store = Store.open(file, { clock });
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const c = { store, sandboxId: sb.id, leaseTtlMs: 60_000, clock };
    const { token } = issueLease(c);
    const reader = new DatabaseSync(file, { readOnly: true });
    const { token: digest } = reader.prepare('SELECT token FROM leases').get();
    reader.close();
    assert.equal(digest, hashToken(token));
    const mismatch = { code: 'E_DENIED', message: 'lease token mismatch' };
    assert.throws(() => leaseRenew(c, { token: digest }), mismatch);
    const lastFlipped = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    assert.throws(() => leaseRenew(c, { token: lastFlipped }), mismatch);
    assert.throws(() => leaseRenew(c, { token: '' }), mismatch);
    assert.equal(store.getLease(sb.id).renewedAt, null, 'nothing was renewed');
    clock.advance(1000);
    const renewed = leaseRenew(c, { token, ttlMs: 90_000 }).lease;
    assert.equal(renewed.renewedAt, clock());
    assert.equal(renewed.remainingMs, 90_000);
    clock.advance(1000);
    const channel = leaseRenew(c, {}).lease;
    assert.equal(channel.renewedAt, clock(), 'the sandbox channel renews without a token');
    assert.equal(channel.generation, renewed.generation);
    assert.equal(store.getLease(sb.id).token, digest, 'renewal never rewrites the digest');
    clock.advance(60_001);
    assert.throws(() => leaseRenew(c, { token }), { code: 'E_STATE' });
    assert.throws(() => leaseRenew(c, {}), { code: 'E_STATE' });
    const other = { ...c, sandboxId: 'sb-without-lease' };
    assert.throws(() => leaseRenew(other, { token }), { code: 'E_NOT_FOUND' });
    store.close();
  } finally {
    t.cleanup();
  }
});
