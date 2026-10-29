import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHmac, randomBytes } from 'node:crypto';
import { DEFAULTS } from './config.js';
import { E } from './errors.js';
import { nullLogger } from './log.js';
import { pinnedLookup, resolveTarget } from './webhook-target.js';

/**
 * Webhook deliveries. A dispatcher turns event log rows into deliveries for every webhook that
 * matches them, then POSTs each delivery to its webhook's URL, signed per Standard Webhooks
 * (`webhook-id`, `webhook-timestamp`, `webhook-signature`). Delivery is at least once and
 * unordered; the payload carries the event `seq` for ordering and de-duplication. Deliveries live
 * in the store, so a receiver or a Workbox server that is down for a while loses nothing: pending
 * deliveries are retried on the configured schedule and resumed after a restart.
 */

/** The prefix of a webhook signing secret; the rest is base64 of the HMAC key. */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';

/** Bytes of a generated signing key. */
export const WEBHOOK_SECRET_BYTES = 24;

/** Most bytes of a failed response body kept in a delivery's `lastError`. */
export const MAX_WEBHOOK_ERROR_BYTES = 4096;

/** How often the dispatcher looks for work it was not told about (another process's changes). */
export const WEBHOOK_POLL_MS = 5_000;

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** The `user-agent` of every webhook request. */
export const WEBHOOK_USER_AGENT = `Workbox-Webhooks/${PACKAGE_VERSION}`;

/** A fresh signing secret: `whsec_` and base64 of 24 random bytes. */
export function newWebhookSecret() {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(WEBHOOK_SECRET_BYTES).toString('base64')}`;
}

/**
 * The HMAC key of a signing secret: the base64-decoded part after `whsec_`.
 * @param {string} secret
 * @returns {Buffer}
 */
export function webhookKey(secret) {
  if (typeof secret !== 'string' || !secret.startsWith(WEBHOOK_SECRET_PREFIX))
    throw E.invalid(`a webhook secret starts with ${WEBHOOK_SECRET_PREFIX}`);
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (!key.length) throw E.invalid('the webhook secret holds no key');
  return key;
}

/**
 * The `webhook-signature` value of one request: `v1,` and base64 of
 * HMAC-SHA256(key, `${id}.${timestamp}.${body}`).
 * @param {string} secret `whsec_...`
 * @param {string} id the `webhook-id`
 * @param {number|string} timestamp the `webhook-timestamp`, unix seconds
 * @param {string|Buffer} body the exact request body
 * @returns {string}
 */
export function signWebhook(secret, id, timestamp, body) {
  const mac = createHmac('sha256', webhookKey(secret))
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest('base64');
  return `v1,${mac}`;
}

/**
 * The request body of a delivery: `{type, timestamp, data}` where `timestamp` is when the event
 * happened (ISO-8601) and `data` is the event row.
 * @param {import('./store.js').WebhookEvent} event
 * @returns {string}
 */
export function webhookBody(event) {
  return JSON.stringify({
    type: event.type,
    timestamp: new Date(event.at).toISOString(),
    data: event,
  });
}

/**
 * When to make the next attempt after `attempts` attempts failed, or null when none is left:
 * attempt n + 1 waits `delays[n - 1]` after attempt n.
 * @param {number} attempts attempts made so far, at least 1
 * @param {number} now ms
 * @param {readonly number[]} delays
 * @returns {number|null}
 */
export function nextAttemptAt(attempts, now, delays) {
  const delay = delays[attempts - 1];
  return delay === undefined ? null : now + delay;
}

/** A test event for `POST /v1/webhooks/:webhookId/test`. @param {string} webhookId @param {number} at */
export function testEvent(webhookId, at) {
  return {
    seq: null,
    sandboxId: null,
    type: 'webhook.test',
    source: 'host',
    payload: { webhookId },
    causation: null,
    at,
  };
}

/**
 * @typedef {object} WebhookConfig
 * @property {boolean} allowPrivate deliver to hosts that resolve to addresses that are not public
 * @property {boolean} allowHttp deliver to `http:` URLs
 * @property {number} timeoutMs bound of one request, connection to response
 * @property {number} concurrency requests in flight at once
 * @property {readonly number[]} retryDelaysMs the waits between attempts
 */

/**
 * The outcome of one attempt.
 * @typedef {{status: number|null, body?: string, error?: string}} Attempt
 */

export class WebhookDispatcher {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {Partial<WebhookConfig>} [deps.config] the engine config's `webhooks` (defaults filled in)
   * @param {import('./log.js').Logger} [deps.logger]
   * @param {number} [deps.pollMs] the longest wait between two looks at the store
   */
  constructor(deps) {
    this.store = deps.store;
    /** @type {WebhookConfig} */
    this.config = Object.freeze({ ...DEFAULTS.webhooks, ...(deps.config ?? {}) });
    this.log = (deps.logger ?? nullLogger()).child('webhooks');
    this.pollMs = deps.pollMs ?? WEBHOOK_POLL_MS;
    this.running = false;
    this.aborting = false;
    this.scheduled = false;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {Map<string, Promise<void>>} delivery id -> its attempt */
    this.inflight = new Map();
    /** @type {Set<import('node:http').ClientRequest>} */
    this.requests = new Set();
  }

  /** Begin delivering: queue what the event log holds past each cursor and send what is due. */
  start() {
    this.running = true;
    this.aborting = false;
    this.notify();
    return this;
  }

  /**
   * Stop: no new attempts, then wait up to `timeoutMs` (default 5000) for those in flight. Any
   * still running then is cut off without being recorded; its delivery stays pending and is sent
   * again after its lease ends.
   * @param {{timeoutMs?: number}} [opts]
   */
  async stop(opts = {}) {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    const pending = [...this.inflight.values()];
    if (!pending.length) return;
    let timer;
    const bound = new Promise((resolve) => {
      timer = setTimeout(resolve, opts.timeoutMs ?? 5_000);
    });
    await Promise.race([Promise.allSettled(pending), bound]);
    clearTimeout(timer);
    if (!this.inflight.size) return;
    this.aborting = true;
    for (const req of this.requests) req.destroy(new Error('the webhook dispatcher stopped'));
    await Promise.allSettled([...this.inflight.values()]);
  }

  /** Look for work soon: new events, new webhooks, deliveries queued or retried. */
  notify() {
    if (!this.running || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => this._cycle());
  }

  /** Number of attempts in flight. */
  get busy() {
    return this.inflight.size;
  }

  _cycle() {
    this.scheduled = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.running) return;
    let more = false;
    try {
      more = this._fanOut();
      this._sendDue();
    } catch (e) {
      this.log.warn('webhook cycle failed', { err: e });
    }
    if (more) this.notify();
    else this._arm();
  }

  /** Queue deliveries for every active webhook. @returns {boolean} true when events are left */
  _fanOut() {
    let more = false;
    for (const hook of this.store.listActiveWebhooks()) {
      let left = true;
      for (let batch = 0; left && batch < 10; batch++)
        left = this.store.enqueueWebhookEvents(hook.id).more;
      more ||= left;
    }
    return more;
  }

  _sendDue() {
    const free = this.config.concurrency - this.inflight.size;
    if (free <= 0) return;
    const leaseMs = this.config.timeoutMs * 2 + 1_000;
    for (const d of this.store.claimWebhookDeliveries({ limit: free, leaseMs })) {
      const attempt = this._attempt(d)
        .catch((e) => this.log.warn('webhook attempt not recorded', { deliveryId: d.id, err: e }))
        .finally(() => {
          this.inflight.delete(d.id);
          this.notify();
        });
      this.inflight.set(d.id, attempt);
    }
  }

  _arm() {
    if (!this.running) return;
    let wait = this.pollMs;
    if (this.inflight.size < this.config.concurrency) {
      const next = this.store.nextWebhookDeliveryAt();
      if (next !== null) wait = Math.min(wait, Math.max(0, next - this.store.clock()));
    }
    this.timer = setTimeout(() => this._cycle(), wait);
    this.timer.unref();
  }

  /** @param {import('./store.js').WebhookDeliveryRow} d */
  async _attempt(d) {
    const hook = this.store.getWebhook(d.webhookId);
    const secret = this.store.getWebhookSecret(d.webhookId);
    if (!hook || secret === null) return;
    const result = await this._send(hook.url, d.id, secret, webhookBody(d.event));
    if (this.aborting) return;
    this._record(d, hook, result);
  }

  /**
   * POST one signed request. Resolves with the status and up to MAX_WEBHOOK_ERROR_BYTES of the
   * body, or with the error that stopped it; never rejects.
   * @returns {Promise<Attempt>}
   */
  async _send(url, id, secret, body) {
    let target;
    try {
      target = await resolveTarget(url, this.config);
    } catch (e) {
      return { status: null, error: `target refused: ${e.message}` };
    }
    if (this.aborting) return { status: null, error: 'the webhook dispatcher stopped' };
    const timestamp = Math.floor(this.store.clock() / 1000);
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'user-agent': WEBHOOK_USER_AGENT,
      'webhook-id': id,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': signWebhook(secret, id, timestamp, body),
    };
    return post(target, headers, body, this.config.timeoutMs, this.requests);
  }

  /**
   * @param {import('./store.js').WebhookDeliveryRow} d
   * @param {import('./store.js').WebhookRow} hook
   * @param {Attempt} result
   */
  _record(d, hook, result) {
    const now = this.store.clock();
    const status = result.status;
    if (status !== null && status >= 200 && status < 300) {
      this.store.recordWebhookAttempt(d.id, { status: 'delivered', lastStatus: status });
      return;
    }
    const lastError = result.error ?? describeAnswer(status, result.body);
    if (status === 410) {
      this.store.recordWebhookAttempt(d.id, { status: 'failed', lastStatus: status, lastError });
      this.store.updateWebhook(hook.id, {
        enabled: false,
        disabledReason: 'the endpoint answered 410 Gone',
      });
      this.log.info('webhook disabled', { webhookId: hook.id, deliveryId: d.id, status });
      return;
    }
    const nextAt = nextAttemptAt(d.attempts + 1, now, this.config.retryDelaysMs);
    this.store.recordWebhookAttempt(d.id, {
      status: nextAt === null ? 'failed' : 'pending',
      nextAt,
      lastStatus: status,
      lastError,
    });
    this.log.info('webhook attempt failed', {
      webhookId: hook.id,
      deliveryId: d.id,
      attempt: d.attempts + 1,
      status,
      retry: nextAt !== null,
    });
  }
}

/** `lastError` of an answer that was not 2xx: its body, or a note when it had none. */
function describeAnswer(status, body) {
  if (status >= 300 && status < 400)
    return body ? `redirects are not followed: ${body}` : 'redirects are not followed';
  return body || `the endpoint answered ${status}`;
}

/**
 * POST `body` to the checked address of `target`; at most `timeoutMs` from start to the end of
 * the response.
 * @param {import('./webhook-target.js').Target} target
 * @param {Record<string, string>} headers
 * @param {string} body
 * @param {number} timeoutMs
 * @param {Set<import('node:http').ClientRequest>} live requests in flight, for stop()
 * @returns {Promise<Attempt>}
 */
function post(target, headers, body, timeoutMs, live) {
  return new Promise((resolve) => {
    const client = target.url.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      live.delete(req);
      resolve(result);
    };
    const req = client.request(
      target.url,
      {
        method: 'POST',
        headers,
        agent: false,
        lookup: pinnedLookup(target.address, target.family),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        const answer = () => {
          const text = Buffer.concat(chunks).subarray(0, MAX_WEBHOOK_ERROR_BYTES).toString('utf8');
          finish({ status: res.statusCode ?? null, body: text });
        };
        res.on('data', (chunk) => {
          if (size >= MAX_WEBHOOK_ERROR_BYTES) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_WEBHOOK_ERROR_BYTES) {
            answer();
            res.destroy();
          }
        });
        res.on('end', answer);
        res.on('error', answer);
        res.on('close', answer);
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    live.add(req);
    req.on('error', (e) => finish({ status: null, error: e.message }));
    req.end(body);
  });
}
