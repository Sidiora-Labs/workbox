import net from 'node:net';
import { E } from '../errors.js';

/** `broker.net.*`: report the effective policy and probe reachability from the host side. */

/** @param {object} ctx */
export function netPolicy(ctx) {
  const policy = ctx.network ??
    ctx.store.requireSandbox(ctx.sandboxId).profile?.network ?? { mode: 'none' };
  return {
    mode: policy.mode ?? 'none',
    allow: policy.allow ?? [],
    proxy: policy.mode === 'none' ? null : (policy.proxy ?? 'http://10.0.2.2:8080'),
  };
}

/**
 * Probe host:port (TCP connect from where the broker runs — inside the sandbox netns when
 * invoked through the manager's net hook, otherwise the host). Never throws for unreachable.
 * @param {object} ctx @param {{host: string, port: number, timeoutMs?: number}} params
 */
export async function netTest(ctx, params) {
  if (typeof params.host !== 'string' || params.host.length === 0 || params.host.length > 253)
    throw E.invalid('host must be a hostname');
  const started = Date.now();
  const probe = ctx.netProbe ?? defaultProbe;
  const result = await probe(params.host, params.port, params.timeoutMs ?? 5000);
  return { host: params.host, port: params.port, ...result, durationMs: Date.now() - started };
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
