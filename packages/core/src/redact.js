import { Redactor as StreamingRedactor, RedactStream } from '@workbox/protocol';
import { E } from './errors.js';

/**
 * Replaces registered secret values in text, byte streams and objects.
 *
 * Redaction is defence in depth. The invariant that keeps a secret out of the record is that its
 * value is only ever injected into the env of the child that asked for it; the redactor scrubs
 * whatever that child, a log line or an audit entry echoes back.
 *
 * Every registered value is redacted whatever its length, so a value never leaks for being short.
 * Values that short would shred ordinary output, so the host refuses them before they get here:
 * the SecretProvider rejects any value shorter than MIN_LENGTH with E_INVALID_PARAMS.
 *
 * The matcher (the raw value, its JSON-escaped, base64, hex and percent-encoded forms, one
 * longest-first alternation and the chunk-safe RedactStream) lives in @workbox/protocol, so the
 * in-box runner redacts session output by the same rules; this module adds the walk over
 * JSON-like values.
 */

/** The shortest secret value the host accepts. The redactor redacts values of any length. */
export const MIN_LENGTH = 8;

/** Deepest nesting applyDeep walks; anything deeper is refused with E_INVALID_PARAMS. */
export const MAX_DEPTH = 64;

/** Keys applyDeep drops rather than copies, so a redacted copy can never reach a prototype. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export { RedactStream };

/** The protocol Redactor plus applyDeep, for audit entries and other JSON-like values. */
export class Redactor extends StreamingRedactor {
  /**
   * Redact every string inside a JSON-like value, returning a new value. `__proto__`,
   * `constructor` and `prototype` keys are dropped; nesting deeper than MAX_DEPTH (including a
   * cycle) is refused with E_INVALID_PARAMS.
   * @template T
   * @param {T} value
   * @returns {T}
   */
  applyDeep(value) {
    return walk(this, value, 0);
  }
}

/** @param {Redactor} r @param {unknown} value @param {number} depth */
function walk(r, value, depth) {
  if (typeof value === 'string') return r.apply(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH)
    throw E.invalid(`value nests deeper than ${MAX_DEPTH} levels`, { maxDepth: MAX_DEPTH });
  if (Array.isArray(value)) return value.map((x) => walk(r, x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(value)) {
    const key = r.apply(k);
    if (!UNSAFE_KEYS.has(key)) out[key] = walk(r, val, depth + 1);
  }
  return out;
}
