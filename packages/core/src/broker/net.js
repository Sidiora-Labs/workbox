import net from 'node:net';
import { E } from '../errors.js';

/**
 * `broker.net.*`: report the effective policy and test a target the way the sandbox's proxy
 * would decide it. `ctx.netState()` is the sandbox's live SandboxNet (null when detached); an
 * allowed target is then probed by TCP from the host at the address the policy checked.
 */

function effectivePolicy(ctx) {
  const policy = ctx.network ??
    ctx.store.requireSandbox(ctx.sandboxId).profile?.network ?? { mode: 'none' };
  return { mode: policy.mode ?? 'none', allow: policy.allow ?? [], ports: policy.ports ?? [] };
}

/** @param {object} ctx */
export function netPolicy(ctx) {
  const policy = effectivePolicy(ctx);
  const state = ctx.netState?.() ?? null;
  const out = { ...policy, proxy: policy.mode === 'none' ? null : (state?.proxyUrl ?? null) };
  ctx.audit?.append({
    actor: 'broker',
    action: 'net.policy',
    sandboxId: ctx.sandboxId,
    data: { mode: out.mode, proxy: out.proxy },
  });
  return out;
}

async function verdictFor(ctx, policy, target) {
  if (policy.mode === 'none') return { allowed: false, reason: 'network-none' };
  const state = ctx.netState?.() ?? null;
  if (!state) return { allowed: false, reason: 'network-detached' };
  return state.check(target);
}

/**
 * Test host:port under the sandbox policy. Never throws for a denied or unreachable target.
 * @param {object} ctx @param {{host: string, port: number, timeoutMs?: number}} params
 */
export async function netTest(ctx, params) {
  if (typeof params.host !== 'string' || params.host.length === 0 || params.host.length > 253)
    throw E.invalid('host must be a hostname');
  const started = Date.now();
  const policy = effectivePolicy(ctx);
  const verdict = await verdictFor(ctx, policy, { host: params.host, port: params.port });
  let result = { reachable: false };
  if (verdict.allowed) {
    const probe = ctx.netProbe ?? defaultProbe;
    result = await probe(verdict.address, params.port, params.timeoutMs ?? 5000);
  }
  const out = {
    host: params.host,
    port: params.port,
    mode: policy.mode,
    ...verdict,
    ...result,
    durationMs: Date.now() - started,
  };
  ctx.audit?.append({
    actor: 'broker',
    action: 'net.test',
    sandboxId: ctx.sandboxId,
    data: {
      host: out.host,
      port: out.port,
      allowed: out.allowed,
      reason: out.reason ?? null,
      reachable: out.reachable,
    },
  });
  return out;
}

async function defaultProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (reachable, error) => {
      socket.destroy();
      resolve(error ? { reachable, error } : { reachable });
    };
    socket.setTimeout(timeoutMs, () => done(false, 'timeout'));
    socket.once('connect', () => done(true));
    socket.once('error', (e) => done(false, e.code ?? e.message));
  });
}
