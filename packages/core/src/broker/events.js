import { E } from '../errors.js';

/** `broker.event.emit`: append a bounded, structured event to the sandbox event log. */

/** Maximum serialised payload bytes persisted per event. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

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
  const payload = params.payload ?? null;
  if (payload !== null) {
    assertBoundedJson(payload);
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    if (bytes > MAX_EVENT_PAYLOAD_BYTES)
      throw E.limit(`event payload is ${bytes} bytes, max ${MAX_EVENT_PAYLOAD_BYTES}`, { bytes });
  }
  const seq = ctx.store.appendEvent(ctx.sandboxId, params.type, payload ?? undefined, {
    causation: params.causation,
    source: 'wb',
  });
  return { seq, type: params.type };
}
