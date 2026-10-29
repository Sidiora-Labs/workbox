import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Checking a Workbox webhook request on the receiving side. Workbox signs each request per
 * Standard Webhooks: `webhook-signature` holds `v1,` and base64 of HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${body}`, keyed with the base64-decoded part of the secret
 * after `whsec_`.
 */

/** The prefix of a webhook signing secret. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Default largest distance between `webhook-timestamp` and now, in seconds. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Why verifyWebhook refused a request; `code` is always `E_WEBHOOK_INVALID`. */
export class WebhookVerificationError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = 'E_WEBHOOK_INVALID';
  }
}

/** One header from a Headers object or a plain (node:http) header object. */
function header(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) ?? undefined;
  for (const [k, value] of Object.entries(headers ?? {}))
    if (k.toLowerCase() === name) return Array.isArray(value) ? value[0] : value;
  return undefined;
}

/**
 * Check a webhook request and return its parsed payload. The signature is compared in constant
 * time, and the request is refused when `webhook-timestamp` is more than `toleranceSeconds` away
 * from `now`, so a captured request cannot be replayed later. Pass the body exactly as received:
 * a body re-serialized after parsing no longer matches its signature. Deduplicate on
 * `webhook-id`, which stays the same across retries of one delivery.
 * @param {string} secret the `whsec_...` secret returned when the webhook was created or rotated
 * @param {Headers|Record<string, string|string[]|undefined>} headers the request headers
 * @param {string|Uint8Array} body the raw request body
 * @param {{toleranceSeconds?: number, now?: number}} [opts] `now` in milliseconds (default
 *   Date.now())
 * @returns {{type: string, timestamp: string, data: object}}
 * @throws {WebhookVerificationError}
 */
export function verifyWebhook(secret, headers, body, opts = {}) {
  const key = signingKey(secret);
  const { id, timestamp, signatures } = signedHeaders(headers);
  const tolerance = opts.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs((opts.now ?? Date.now()) / 1000 - Number(timestamp)) > tolerance)
    throw new WebhookVerificationError('webhook-timestamp is outside the tolerance window');
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body ?? []);
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(raw).digest();
  if (!anySignatureMatches(signatures, expected))
    throw new WebhookVerificationError('no webhook-signature matches the body');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new WebhookVerificationError('the body is not JSON');
  }
}

/** The HMAC key of a `whsec_` secret. */
function signingKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith(WEBHOOK_SECRET_PREFIX))
    throw new WebhookVerificationError(`the secret must start with ${WEBHOOK_SECRET_PREFIX}`);
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (!key.length) throw new WebhookVerificationError('the secret holds no key');
  return key;
}

/** The three Standard Webhooks headers, all present and the timestamp in unix seconds. */
function signedHeaders(headers) {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures)
    throw new WebhookVerificationError(
      'missing webhook-id, webhook-timestamp or webhook-signature header',
    );
  if (!/^\d{1,15}$/.test(timestamp))
    throw new WebhookVerificationError('webhook-timestamp is not a unix time in seconds');
  return { id, timestamp, signatures };
}

/** True when a `v1,` entry of the space-separated list equals `expected`, compared in constant time. */
function anySignatureMatches(signatures, expected) {
  let matched = false;
  for (const entry of String(signatures).split(' ')) {
    const comma = entry.indexOf(',');
    if (comma < 0 || entry.slice(0, comma) !== 'v1') continue;
    const given = Buffer.from(entry.slice(comma + 1), 'base64');
    if (given.length === expected.length && timingSafeEqual(given, expected)) matched = true;
  }
  return matched;
}
