import { E } from '../errors.js';
import { parseRef } from '../secrets.js';

/**
 * `broker.secret.*`. `list` is wb-visible and returns references only. `resolve` returns values
 * as child env vars and is reachable only by the runner over the control channel (the runner
 * refuses to relay it from local peers). Policy is the store's per-sandbox allowed-ref set.
 */

/** @param {object} ctx */
export function secretList(ctx) {
  const policy = ctx.store.getSecretPolicy(ctx.sandboxId);
  const configured = new Set(ctx.secrets?.refs() ?? []);
  return { refs: policy.filter((r) => configured.has(parseRef(r).ref)) };
}

/** @param {object} ctx @param {{refs: string[]}} params */
export function secretResolve(ctx, params) {
  if (!ctx.secrets) throw E.unavailable('no secret provider configured on the host');
  const policy = new Set(ctx.store.getSecretPolicy(ctx.sandboxId).map((r) => parseRef(r).ref));
  for (const raw of params.refs) {
    const { ref } = parseRef(raw);
    if (!policy.has(ref)) throw E.denied(`secret ${ref} is outside this sandbox's policy`, { ref });
  }
  const env = ctx.secrets.resolveEnv(params.refs);
  ctx.audit?.append({
    actor: 'broker',
    action: 'secret.resolve',
    sandboxId: ctx.sandboxId,
    data: { refs: params.refs.map((r) => parseRef(r).ref) },
  });
  return { env };
}
