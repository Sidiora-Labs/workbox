import { E } from '../errors.js';

/**
 * Ask notification channels. A channel is `{name, deliver(ask)}`; `deliver` may return a promise.
 * Channels only tell a human that an ask is open — answers still arrive through the host API.
 * Every delivery attempt is audited with its outcome.
 */

/**
 * One NDJSON line per ask on a writable stream (the daemon's stdout by default).
 * @param {{write: (s: string) => unknown}} [stream]
 */
export function stdoutChannel(stream = process.stdout) {
  return {
    name: 'stdout',
    deliver(ask) {
      stream.write(`${JSON.stringify({ type: 'ask', ask })}\n`);
    },
  };
}

/**
 * POST `{type: 'ask', ask}` as JSON to an http(s) URL; a non-2xx reply is a failed delivery.
 * @param {{url: string, timeoutMs?: number, headers?: Record<string, string>}} opts
 */
export function webhookChannel(opts) {
  let url;
  try {
    url = new URL(opts.url);
  } catch {
    throw E.invalid(`invalid webhook url ${String(opts.url)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw E.invalid(`webhook url must be http or https, got ${url.protocol}`);
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return {
    name: 'webhook',
    async deliver(ask) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify({ type: 'ask', ask }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (!res.ok) throw E.unavailable(`webhook answered ${res.status}`, { status: res.status });
    },
  };
}

/**
 * Deliver an ask to every channel, auditing each outcome. Never throws.
 * @param {{audit?: {append: Function}, sandboxId?: string}} ctx
 * @param {Array<{name: string, deliver: (ask: object) => unknown}>} channels
 * @param {object} ask public ask view
 * @returns {Promise<Array<{channel: string, ok: boolean, error?: string}>>}
 */
export async function notifyAsk(ctx, channels, ask) {
  const results = [];
  for (const channel of channels) {
    const result = { channel: channel.name, ok: true };
    try {
      await channel.deliver(ask);
    } catch (e) {
      result.ok = false;
      result.error = e.message;
    }
    ctx.audit?.append({
      actor: 'broker',
      action: 'ask.notify',
      sandboxId: ask.sandboxId ?? ctx.sandboxId,
      data: { askId: ask.askId, ...result },
    });
    results.push(result);
  }
  return results;
}
