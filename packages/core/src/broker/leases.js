import { randomBytes, createHash } from 'node:crypto';
import { E } from '../errors.js';

/**
 * `broker.lease.*`: one lease per sandbox. The token is stored SHA-256-hashed at rest; the
 * plaintext is returned exactly once at issue. Expiry never auto-kills in v1 — it is reported.
 */

/** @param {string} token */
export function hashToken(token) {
  return `sha256:${createHash('sha256').update(String(token)).digest('hex')}`;
}

/** Issue (or re-issue) the sandbox lease. Host/manager-initiated. @param {object} ctx @param {{ttlMs?: number}} [opts] */
export function issueLease(ctx, opts = {}) {
  const token = randomBytes(24).toString('hex');
  const ttlMs = opts.ttlMs ?? ctx.leaseTtlMs ?? 300_000;
  const lease = ctx.store.issueLease(ctx.sandboxId, { token: hashToken(token), ttlMs });
  return { ...leaseView(ctx, lease), token };
}

/** @param {object} ctx */
export function leaseStatus(ctx) {
  const lease = ctx.store.getLease(ctx.sandboxId);
  if (!lease) return { lease: null };
  return { lease: leaseView(ctx, lease) };
}

/** @param {object} ctx @param {{ttlMs?: number, token?: string}} params */
export function leaseRenew(ctx, params) {
  const lease = ctx.store.getLease(ctx.sandboxId);
  if (!lease) throw E.notFound('sandbox has no lease', { sandboxId: ctx.sandboxId });
  const ttlMs = params.ttlMs ?? ctx.leaseTtlMs ?? 300_000;
  // wb renews without holding the plaintext token: the broker channel is the sandbox's own
  // control channel, so renewal re-issues under the same stored hash.
  const stored = lease.token;
  const renewed = ctx.store.renewLease(
    ctx.sandboxId,
    params.token ? hashToken(params.token) : stored,
    ttlMs,
  );
  ctx.audit?.append({
    actor: 'broker',
    action: 'lease.renew',
    sandboxId: ctx.sandboxId,
    data: { generation: renewed.generation },
  });
  return { lease: leaseView(ctx, renewed) };
}

function leaseView(ctx, lease) {
  const now = (ctx.clock ?? Date.now)();
  return {
    sandboxId: lease.sandboxId,
    generation: lease.generation,
    issuedAt: lease.issuedAt,
    renewedAt: lease.renewedAt,
    expiresAt: lease.expiresAt,
    offlineDeadline: lease.expiresAt,
    expired: lease.expiresAt <= now,
    remainingMs: Math.max(0, lease.expiresAt - now),
  };
}
