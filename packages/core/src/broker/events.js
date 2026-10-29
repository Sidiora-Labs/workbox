import { E } from '../errors.js';

/** `broker.event.emit`: append a bounded, structured event to the sandbox event log. */

/** Maximum serialised payload bytes persisted per event. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

/** Type prefixes of the events the host records; `wb event emit` may not use them. */
export const RESERVED_EVENT_PREFIXES = Object.freeze([
  'sandbox.',
  'session.',
  'exec.',
  'ask.',
  'checkpoint.',
  'artifact.',
  'webhook.',
  'key.',
]);

/**
 * Append to the context's sandbox event log: through `ctx.logEvent` when the engine provides it,
 * so the append is announced, otherwise straight to the store.
 * @param {object} ctx @param {string} type @param {object} [payload]
 * @param {{causation?: string, source?: 'host'|'wb'}} [opts]
 * @returns {number} the event sequence number
 */
export function appendLogged(ctx, type, payload, opts = {}) {
  if (ctx.logEvent) return ctx.logEvent(type, payload, opts).seq;
  return ctx.store.appendEvent(ctx.sandboxId, type, payload, opts);
}

/**
 * Bound an arbitrary JSON value by depth and serialised size (fail closed).
 * @param {unknown} value @param {number} [depth]
 */
export function assertBoundedJson(value, depth = 0) {
  if (depth > 32) throw E.invalid('value is nested too deeply (max 32)');
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value) ? value : Object.values(value);
    if (entries.length > 1024) throw E.invalid('value has too many entries');
    for (const v of entries) assertBoundedJson(v, depth + 1);
  }
  return value;
}

/** @param {object} ctx @param {{type: string, payload?: object, causation?: string}} params */
export function eventEmit(ctx, params) {
  const reserved = RESERVED_EVENT_PREFIXES.find((p) => params.type.startsWith(p));
  if (reserved)
    throw E.invalid(`event type ${params.type} is reserved for the host (${reserved}*)`, {
      type: params.type,
      prefix: reserved,
    });
  const payload = params.payload ?? null;
  if (payload !== null) {
    assertBoundedJson(payload);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > MAX_EVENT_PAYLOAD_BYTES)
      throw E.limit(`event payload is ${bytes} bytes, max ${MAX_EVENT_PAYLOAD_BYTES}`, { bytes });
  }
  const seq = appendLogged(ctx, params.type, payload ?? undefined, {
    causation: params.causation,
    source: 'wb',
  });
  ctx.audit?.append({
    actor: 'broker',
    action: 'event.emit',
    sandboxId: ctx.sandboxId,
    data: { seq, type: params.type, causation: params.causation ?? null },
  });
  return { seq, type: params.type, causation: params.causation ?? null };
}
