import fs from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { v, validate } from '@workbox/protocol';
import { E } from '@workbox/core';

/**
 * Bearer API keys with scopes (`read`, `exec`, `admin`, `answer`). Config entries are
 * `{id, tokenSha256, scopes}` (preferred) or `{id, token, scopes}` (hashed at load) and are
 * unbound. Stored keys live in the store's `api_keys` table: they may expire, may be revoked and
 * may be bound to sandboxes by label or id. Config comparison is constant-time over the digest;
 * a stored key is looked up by its digest.
 */

/** All scopes the server understands. */
export const SCOPES = Object.freeze(['read', 'exec', 'admin', 'answer']);

/** The route scope every valid key satisfies, whatever scopes it holds. */
export const ANY_KEY = 'any';

/**
 * The least-privilege matrix: the one scope each route requires (`admin` implies every scope).
 * `read` observes, `exec` runs code and writes files inside a sandbox, `answer` answers asks,
 * `admin` changes the fleet. Keys are `METHOD template`; `:name` segments are parameters.
 */
export const SCOPE_MATRIX = Object.freeze({
  'GET /metrics': 'read',
  'GET /v1/sandboxes': 'read',
  'POST /v1/sandboxes': 'admin',
  'GET /v1/sandboxes/:id': 'read',
  'DELETE /v1/sandboxes/:id': 'admin',
  'POST /v1/sandboxes/:id/drain': 'admin',
  'POST /v1/sandboxes/:id/exec': 'exec',
  'GET /v1/sandboxes/:id/files': 'read',
  'PUT /v1/sandboxes/:id/files': 'exec',
  'DELETE /v1/sandboxes/:id/files': 'exec',
  'POST /v1/sandboxes/:id/files/mkdir': 'exec',
  'GET /v1/sandboxes/:id/files/raw': 'read',
  'PUT /v1/sandboxes/:id/files/raw': 'exec',
  'GET /v1/sandboxes/:id/sessions': 'read',
  'POST /v1/sandboxes/:id/sessions': 'exec',
  'GET /v1/sandboxes/:id/sessions/:sessionId': 'read',
  'DELETE /v1/sandboxes/:id/sessions/:sessionId': 'exec',
  'GET /v1/sandboxes/:id/sessions/:sessionId/output': 'read',
  'POST /v1/sandboxes/:id/sessions/:sessionId/wait': 'read',
  'POST /v1/sandboxes/:id/sessions/:sessionId/input': 'exec',
  'POST /v1/sandboxes/:id/sessions/:sessionId/signal': 'exec',
  'POST /v1/sandboxes/:id/sessions/:sessionId/stop': 'exec',
  'POST /v1/sandboxes/:id/sessions/:sessionId/resize': 'exec',
  'GET /v1/sandboxes/:id/sessions/:sessionId/ws': 'exec',
  'GET /v1/sandboxes/:id/evidence': 'read',
  'GET /v1/sandboxes/:id/artifacts': 'read',
  'GET /v1/sandboxes/:id/artifacts/:sha256': 'read',
  'GET /v1/sandboxes/:id/checkpoints': 'read',
  'POST /v1/sandboxes/:id/checkpoints': 'admin',
  'GET /v1/sandboxes/:id/events': 'read',
  'GET /v1/sandboxes/:id/events/ws': 'read',
  'GET /v1/events': 'read',
  'GET /v1/events/ws': 'read',
  'POST /v1/reconcile': 'admin',
  'GET /v1/asks': 'read',
  'POST /v1/asks/:askId/answer': 'answer',
  'GET /v1/whoami': ANY_KEY,
  'POST /v1/keys': 'admin',
  'GET /v1/keys': 'admin',
  'DELETE /v1/keys/:keyId': 'admin',
});

/** Routes that act on the whole fleet. A key bound to sandboxes is refused on them with 403. */
export const FLEET_ROUTES = Object.freeze([
  'GET /metrics',
  'POST /v1/reconcile',
  'POST /v1/keys',
  'GET /v1/keys',
  'DELETE /v1/keys/:keyId',
]);

/** The shape of a stored key's token: `wbk_` and 43 base64url characters (32 random bytes). */
export const KEY_TOKEN = /^wbk_[A-Za-z0-9_-]{43}$/;

/** The longest lifetime a stored key may be given: ten years. */
export const MAX_KEY_TTL_SECONDS = 10 * 365 * 86_400;

/** Body of a key creation: `POST /v1/keys`, and `workbox key create` on the local engine. */
export const KEY_CREATE_SCHEMA = v.object(
  {
    name: v.string({ min: 1, max: 128 }),
    scopes: v.array(v.enum(SCOPES), { min: 1, max: SCOPES.length }),
    labels: v.optional(v.record(v.string({ max: 256 }), { max: 32, keyPattern: /^.{1,128}$/su })),
    sandboxIds: v.optional(v.array(v.string({ min: 1, max: 128 }), { max: 1000 })),
    ttlSeconds: v.optional(v.integer({ min: 1, max: MAX_KEY_TTL_SECONDS })),
  },
  { required: ['name', 'scopes'] },
);

const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

/** @param {string} token */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/** A fresh stored-key token: `wbk_` and 32 random bytes in base64url. */
export function newKeyToken() {
  return `wbk_${randomBytes(32).toString('base64url')}`;
}

/**
 * Mint a stored key: validate the request, generate the token and keep only its digest. The
 * token is in the result and nowhere else; it cannot be shown again. `labels` and `sandboxIds`
 * bind the key; without either it is unbound.
 * @param {import('@workbox/core').Store} store
 * @param {{name: string, scopes: string[], labels?: Record<string, string>, sandboxIds?: string[], ttlSeconds?: number}} input
 * @param {string|null} [createdBy] the principal or tool minting it
 * @returns {{id: string, name: string, token: string, scopes: string[], binding: {labels?: Record<string, string>, sandboxIds?: string[]}|null, createdAt: number, expiresAt: number|null}}
 */
export function createStoredKey(store, input, createdBy = null) {
  const result = validate(KEY_CREATE_SCHEMA, input);
  if (!result.ok) {
    const first = result.errors[0];
    throw E.invalid(`invalid ${first.path}: ${first.message}`, { errors: result.errors });
  }
  const token = newKeyToken();
  const row = store.createApiKey({
    name: input.name,
    tokenSha256: hashToken(token),
    scopes: [...new Set(input.scopes)],
    binding: bindingOf(input),
    ttlMs: input.ttlSeconds ? input.ttlSeconds * 1000 : undefined,
    createdBy,
  });
  return {
    id: row.id,
    name: row.name,
    token,
    scopes: row.scopes,
    binding: row.binding,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function bindingOf(input) {
  const binding = {};
  if (input.labels && Object.keys(input.labels).length) binding.labels = { ...input.labels };
  if (input.sandboxIds?.length) binding.sandboxIds = [...new Set(input.sandboxIds)];
  return Object.keys(binding).length ? binding : null;
}

/**
 * Read scoped keys from a JSON config file: `{"keys": [{id, tokenSha256|token, scopes}]}`.
 * @param {string} file
 * @returns {{id: string, token?: string, tokenSha256?: string, scopes: string[]}[]}
 */
export function loadKeysFile(file) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || !Array.isArray(doc.keys)) throw new Error(`${file}: expected {"keys": [...]}`);
  return doc.keys;
}

/**
 * H15: a request a browser could have sent (it carries `Origin` or `Sec-Fetch-Site`) or one
 * addressed to a foreign `Host` (DNS rebinding) is refused before authentication runs.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string[]} [serverNames] extra accepted host names
 * @returns {string|null} the reason to refuse, or null to proceed
 */
export function browserGuard(headers, serverNames = []) {
  if (headers.origin !== undefined) return 'browser-originated request (Origin)';
  if (headers['sec-fetch-site'] !== undefined) return 'browser-originated request (Sec-Fetch-Site)';
  const host = hostName(headers.host);
  if (host === null) return 'missing Host header';
  if (!LOCAL_HOSTS.includes(host) && !serverNames.includes(host))
    return `host ${host} is not served`;
  return null;
}

function hostName(header) {
  if (typeof header !== 'string' || header === '') return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(header);
  if (bracketed) return bracketed[1].toLowerCase();
  return header.replace(/:\d+$/, '').toLowerCase();
}

/**
 * @typedef {object} Principal
 * @property {string} id
 * @property {readonly string[]} scopes
 * @property {{labels?: Record<string, string>, sandboxIds?: string[]}|null} binding
 * @property {'config'|'store'} source
 * @property {number|null} expiresAt
 */

/**
 * Bearer authentication over the configured keys and, when a store is given, the stored ones.
 * A stored key that is revoked or past its expiry authenticates as nobody.
 * @param {{keys?: {id: string, token?: string, tokenSha256?: string, scopes: string[]}[], keysFile?: string, store?: import('@workbox/core').Store|null, clock?: () => number}} [opts]
 */
export function createAuth(opts = {}) {
  const entries = [...(opts.keys ?? []), ...(opts.keysFile ? loadKeysFile(opts.keysFile) : [])];
  const keys = entries.map((k) => {
    const scopes = k.scopes ?? [];
    for (const s of scopes)
      if (!SCOPES.includes(s)) throw new Error(`unknown scope ${s} for key ${k.id}`);
    const digest = k.tokenSha256 ?? (k.token ? hashToken(k.token) : null);
    if (!digest || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error(`key ${k.id} has no usable token digest`);
    const principal = Object.freeze({
      id: k.id,
      scopes: Object.freeze([...scopes]),
      binding: null,
      source: 'config',
      expiresAt: null,
    });
    return { digest: Buffer.from(digest, 'hex'), principal };
  });
  const store = opts.store ?? null;
  const clock = opts.clock ?? store?.clock ?? Date.now;

  return {
    /** Number of configured keys. */
    get size() {
      return keys.length;
    },
    /**
     * @param {string|undefined} header Authorization header value
     * @returns {Principal|null}
     */
    authenticate(header) {
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      const token = header.slice('Bearer '.length);
      const digest = hashToken(token);
      const given = Buffer.from(digest, 'hex');
      for (const key of keys)
        if (given.length === key.digest.length && timingSafeEqual(given, key.digest))
          return key.principal;
      if (!store || !KEY_TOKEN.test(token)) return null;
      return storedPrincipal(store, digest, clock());
    },
    /** @param {{scopes: readonly string[]}|null} principal @param {string} scope */
    authorize(principal, scope) {
      if (!principal) return false;
      if (scope === ANY_KEY) return true;
      return principal.scopes.includes('admin') || principal.scopes.includes(scope);
    },
  };
}

/** @returns {Principal|null} */
function storedPrincipal(store, digest, now) {
  const row = store.getApiKeyByDigest(digest);
  if (!row || row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt <= now) return null;
  store.touchApiKey(row.id);
  return Object.freeze({
    id: row.id,
    scopes: Object.freeze([...row.scopes]),
    binding: freezeBinding(row.binding),
    source: 'store',
    expiresAt: row.expiresAt,
  });
}

function freezeBinding(binding) {
  if (!binding) return null;
  const out = {};
  if (binding.labels) out.labels = Object.freeze({ ...binding.labels });
  if (binding.sandboxIds) out.sandboxIds = Object.freeze([...binding.sandboxIds]);
  return Object.freeze(out);
}
