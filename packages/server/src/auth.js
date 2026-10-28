import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Bearer API keys with scopes (`read`, `exec`, `admin`, `answer`). Config entries are
 * `{id, tokenSha256, scopes}` (preferred) or `{id, token, scopes}` (hashed at load).
 * Comparison is constant-time over the digest.
 */

/** All scopes the server understands. */
export const SCOPES = Object.freeze(['read', 'exec', 'admin', 'answer']);

/** @param {string} token */
export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @param {{keys?: {id: string, token?: string, tokenSha256?: string, scopes: string[]}[]}} [opts]
 */
export function createAuth(opts = {}) {
  const keys = (opts.keys ?? []).map((k) => {
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
