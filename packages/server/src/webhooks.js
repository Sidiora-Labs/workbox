import { v, validate } from '@workbox/protocol';
import {
  DEFAULTS,
  E,
  MAX_TARGET_URL_LENGTH,
  newWebhookSecret,
  resolveTarget,
  testEvent,
} from '@workbox/core';
import { isBound, sandboxVisible } from './access.js';

/**
 * Webhook management: create, change, rotate, test and delete webhooks and retry their
 * deliveries. A webhook belongs to the principal that created it and carries a copy of that
 * principal's binding, which limits the events it receives. A bound principal sees and manages
 * only the webhooks it created; any other answers as missing. Unbound principals see every
 * webhook. The signing secret is returned on create and rotate only.
 */

/** An event type, or `prefix.*` for every type that starts with `prefix.`. */
export const WEBHOOK_TYPE_PATTERN = /^[a-z][a-z0-9_.-]*(\.\*)?$/;

const typesSchema = v.optional(
  v.array(v.string({ min: 1, max: 128, pattern: WEBHOOK_TYPE_PATTERN }), { max: 64 }),
);
const urlSchema = v.string({ min: 1, max: MAX_TARGET_URL_LENGTH });

/** Body of `POST /v1/webhooks`. */
export const WEBHOOK_CREATE_SCHEMA = v.object(
  {
    url: urlSchema,
    types: typesSchema,
    sandboxId: v.optional(v.string({ min: 1, max: 128 })),
    labels: v.optional(v.record(v.string({ max: 256 }), { max: 32, keyPattern: /^.{1,128}$/su })),
    description: v.optional(v.string({ max: 1024 })),
  },
  { required: ['url'] },
);

/** Body of `PATCH /v1/webhooks/:webhookId`. */
export const WEBHOOK_UPDATE_SCHEMA = v.object({
  url: v.optional(urlSchema),
  types: typesSchema,
  description: v.optional(v.nullable(v.string({ max: 1024 }))),
  enabled: v.optional(v.boolean()),
});

/** The delivery states `GET /v1/webhooks/:webhookId/deliveries?status=` accepts. */
export const DELIVERY_STATUSES = Object.freeze(['pending', 'delivered', 'failed']);

/**
 * @typedef {{id: string, binding?: {labels?: Record<string, string>, sandboxIds?: readonly string[]}|null}} Owner
 * @typedef {import('@workbox/core').WebhookConfig} WebhookConfig
 */

function checked(schema, body) {
  const result = validate(schema, body);
  if (!result.ok) {
    const first = result.errors[0];
    throw E.invalid(`invalid ${first.path}: ${first.message}`, { errors: result.errors });
  }
  return body;
}

function webhookNotFound(id) {
  return E.notFound(`webhook ${id} not found`, { webhookId: id });
}

/**
 * True when the principal may see and manage the webhook: it is unbound, or it created it.
 * @param {Owner|null|undefined} principal
 * @param {{ownerKey: string|null}|null|undefined} row
 */
export function webhookVisible(principal, row) {
  if (!principal || !row) return false;
  return !isBound(principal) || row.ownerKey === principal.id;
}

/**
 * The webhook if the principal may see it, else E_NOT_FOUND (the same as a missing one).
 * @param {import('@workbox/core').Store} store
 * @param {Owner} principal
 * @param {string} id
 */
export function ownedWebhook(store, principal, id) {
  const row = store.getWebhook(id);
  if (!webhookVisible(principal, row)) throw webhookNotFound(id);
  return row;
}

/**
 * Register a webhook for the principal. The URL must pass the target guard under `policy`; a
 * `sandboxId` the principal cannot see is E_NOT_FOUND. The result carries the signing secret,
 * which is not shown again (rotate it to get a new one).
 * @param {import('@workbox/core').Store} store
 * @param {{url: string, types?: string[], sandboxId?: string, labels?: Record<string, string>, description?: string}} input
 * @param {Owner} principal the creator; its id and binding are recorded
 * @param {Partial<WebhookConfig>} [policy] default: the engine defaults
 */
export async function createWebhook(store, input, principal, policy = DEFAULTS.webhooks) {
  checked(WEBHOOK_CREATE_SCHEMA, input);
  if (input.sandboxId !== undefined) {
    const sandbox = store.getSandbox(input.sandboxId);
    if (!sandbox || !sandboxVisible(principal, sandbox))
      throw E.notFound(`sandbox ${input.sandboxId} not found`, { id: input.sandboxId });
  }
  const target = await resolveTarget(input.url, policy);
  const secret = newWebhookSecret();
  const row = store.createWebhook({
    url: target.url.href,
    secret,
    types: [...new Set(input.types ?? [])],
    sandboxId: input.sandboxId ?? null,
    labels: input.labels ?? null,
    description: input.description ?? null,
    ownerKey: principal.id,
    binding: principal.binding ?? null,
  });
  return { ...row, secret };
}

/**
 * Change a webhook's URL (checked again by the target guard), types, description or enabled
 * state. Enabling clears `disabledReason`.
 * @param {import('@workbox/core').Store} store
 * @param {string} id
 * @param {{url?: string, types?: string[], description?: string|null, enabled?: boolean}} patch
 * @param {Owner} principal
 * @param {Partial<WebhookConfig>} [policy]
 */
export async function updateWebhook(store, id, patch, principal, policy = DEFAULTS.webhooks) {
  checked(WEBHOOK_UPDATE_SCHEMA, patch);
  ownedWebhook(store, principal, id);
  const change = {};
  if (patch.url !== undefined) change.url = (await resolveTarget(patch.url, policy)).url.href;
  if (patch.types !== undefined) change.types = [...new Set(patch.types)];
  if (patch.description !== undefined) change.description = patch.description;
  if (patch.enabled !== undefined) change.enabled = patch.enabled;
  return store.updateWebhook(id, change);
}

/**
 * Replace the signing secret. Deliveries signed from now on use the new one, retries included.
 * @param {import('@workbox/core').Store} store @param {string} id @param {Owner} principal
 */
export function rotateWebhookSecret(store, id, principal) {
  ownedWebhook(store, principal, id);
  const secret = newWebhookSecret();
  return { ...store.updateWebhook(id, { secret }), secret };
}

/** @param {import('@workbox/core').Store} store @param {string} id @param {Owner} principal */
export function deleteWebhook(store, id, principal) {
  ownedWebhook(store, principal, id);
  return store.deleteWebhook(id);
}

/**
 * The webhooks the principal may see, in creation order.
 * @param {import('@workbox/core').Store} store @param {Owner} principal
 * @returns {{webhooks: import('@workbox/core').WebhookRow[]}}
 */
export function listWebhooks(store, principal) {
  return {
    webhooks: store.listWebhooks(isBound(principal) ? { ownerKey: principal.id } : {}),
  };
}

/**
 * Queue one `webhook.test` delivery. It is not an event log row: its `seq` and `sandboxId` are
 * null.
 * @param {import('@workbox/core').Store} store @param {string} id @param {Owner} principal
 */
export function queueTestDelivery(store, id, principal) {
  ownedWebhook(store, principal, id);
  return store.queueWebhookDelivery(id, testEvent(id, store.clock()));
}

/**
 * One page of a webhook's deliveries, newest first.
 * @param {import('@workbox/core').Store} store @param {string} id @param {Owner} principal
 * @param {{status?: string, limit?: number, cursor?: string}} [opts]
 */
export function listDeliveries(store, id, principal, opts = {}) {
  ownedWebhook(store, principal, id);
  if (opts.status !== undefined && !DELIVERY_STATUSES.includes(opts.status))
    throw E.invalid(`status must be one of ${DELIVERY_STATUSES.join(', ')}`, {
      status: opts.status,
    });
  return store.listWebhookDeliveries(id, opts);
}

/**
 * Send a delivery again as soon as possible.
 * @param {import('@workbox/core').Store} store @param {string} id the webhook
 * @param {string} deliveryId @param {Owner} principal
 */
export function retryDelivery(store, id, deliveryId, principal) {
  ownedWebhook(store, principal, id);
  const delivery = store.getWebhookDelivery(deliveryId);
  if (!delivery || delivery.webhookId !== id)
    throw E.notFound(`delivery ${deliveryId} not found`, { webhookId: id, deliveryId });
  return store.retryWebhookDelivery(deliveryId);
}

/**
 * The route handlers of `/v1/webhooks`, for createServer.
 * @param {import('@workbox/core').Store} store
 * @param {{policy: () => Partial<WebhookConfig>, notify: () => void, page: (url: URL) => {limit?: number, cursor?: string}}} deps
 *   `policy` is the target guard's configuration, `notify` wakes the dispatcher and `page`
 *   reads `limit` and `cursor` from a query
 */
export function webhookHandlers(store, deps) {
  const audit = (row) => ({ webhookId: row.id, url: row.url });
  return {
    'POST /v1/webhooks': async ({ body, principal }) => {
      const row = await createWebhook(store, body, principal, deps.policy());
      deps.notify();
      return { status: 201, body: row, audit: audit(row) };
    },
    'GET /v1/webhooks': ({ principal }) => ({ body: listWebhooks(store, principal) }),
    'GET /v1/webhooks/:webhookId': ({ params, principal }) => ({
      body: ownedWebhook(store, principal, params.webhookId),
    }),
    'PATCH /v1/webhooks/:webhookId': async ({ params, body, principal }) => {
      const row = await updateWebhook(store, params.webhookId, body, principal, deps.policy());
      deps.notify();
      return { body: row, audit: { ...audit(row), enabled: row.enabled } };
    },
    'DELETE /v1/webhooks/:webhookId': ({ params, principal }) => {
      const row = deleteWebhook(store, params.webhookId, principal);
      return { body: row, audit: audit(row) };
    },
    'POST /v1/webhooks/:webhookId/rotate-secret': ({ params, principal }) => {
      const row = rotateWebhookSecret(store, params.webhookId, principal);
      return { body: row, audit: audit(row) };
    },
    'POST /v1/webhooks/:webhookId/test': ({ params, principal }) => {
      const delivery = queueTestDelivery(store, params.webhookId, principal);
      deps.notify();
      return { status: 202, body: delivery, audit: { deliveryId: delivery.id } };
    },
    'GET /v1/webhooks/:webhookId/deliveries': ({ params, url, principal }) => ({
      body: listDeliveries(store, params.webhookId, principal, {
        ...deps.page(url),
        status: url.searchParams.get('status') ?? undefined,
      }),
    }),
    'POST /v1/webhooks/:webhookId/deliveries/:deliveryId/retry': ({ params, principal }) => {
      const delivery = retryDelivery(store, params.webhookId, params.deliveryId, principal);
      deps.notify();
      return { status: 202, body: delivery };
    },
  };
}
