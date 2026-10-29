import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer API keys with scopes (`read`, `exec`, `admin`, `answer`). Config entries are
 * `{id, tokenSha256, scopes}` (preferred) or `{id, token, scopes}` (hashed at load).
 * Comparison is constant-time over the digest.
 */

/** All scopes the server understands. */
export const SCOPES = Object.freeze(['read', 'exec', 'admin', 'answer']);

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
  'POST /v1/reconcile': 'admin',
  'GET /v1/asks': 'read',
  'POST /v1/asks/:askId/answer': 'answer',
});

const LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);

/** @param {string} token */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
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
 * @param {{keys?: {id: string, token?: string, tokenSha256?: string, scopes: string[]}[], keysFile?: string}} [opts]
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
    return { id: k.id, digest, scopes: Object.freeze([...scopes]) };
  });

  return {
    /** Number of configured keys. */
    get size() {
      return keys.length;
    },
    /**
     * @param {string|undefined} header Authorization header value
     * @returns {{id: string, scopes: readonly string[]}|null}
     */
    authenticate(header) {
      if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
      const given = Buffer.from(hashToken(header.slice('Bearer '.length)), 'hex');
      for (const key of keys) {
        const want = Buffer.from(key.digest, 'hex');
        if (given.length === want.length && timingSafeEqual(given, want))
          return { id: key.id, scopes: key.scopes };
      }
      return null;
    },
    /** @param {{scopes: readonly string[]}|null} principal @param {string} scope */
    authorize(principal, scope) {
      if (!principal) return false;
      return principal.scopes.includes('admin') || principal.scopes.includes(scope);
    },
  };
}
