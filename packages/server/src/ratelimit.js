/**
 * A fixed-window counter of failed authentications per client address. Once an address has
 * failed `max` times in a window that started with its first failure, it is refused until that
 * window ends. The map holds at most `maxEntries` addresses: expired windows are dropped first,
 * then the oldest window.
 */

/** Defaults: 20 failures per 60 s window, at most 10 000 addresses tracked. */
export const AUTH_FAILURE_DEFAULTS = Object.freeze({
  max: 20,
  windowMs: 60_000,
  maxEntries: 10_000,
});

/**
 * The key an address is counted under: an IPv4-mapped IPv6 address as its IPv4 form, any other
 * IPv6 address as its /64 network, since one host usually holds a whole /64.
 * @param {string|undefined} address a socket's remoteAddress
 * @returns {string}
 */
export function addressKey(address) {
  if (typeof address !== 'string' || address === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1];
  if (!address.includes(':')) return address;
  const [head, tail] = address.split('%')[0].split('::');
  const groups = head ? head.split(':') : [];
  if (tail !== undefined) {
    const right = tail ? tail.split(':') : [];
    const width = right.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
    groups.push(...Array(Math.max(0, 8 - groups.length - width)).fill('0'), ...right);
  }
  const net = groups.slice(0, 4).map((g) => (Number.parseInt(g, 16) || 0).toString(16));
  return `${net.join(':')}::/64`;
}

/**
 * @param {{max?: number, windowMs?: number, maxEntries?: number}} [opts]
 */
export function createFailureLimiter(opts = {}) {
  const max = opts.max ?? AUTH_FAILURE_DEFAULTS.max;
  const windowMs = opts.windowMs ?? AUTH_FAILURE_DEFAULTS.windowMs;
  const maxEntries = opts.maxEntries ?? AUTH_FAILURE_DEFAULTS.maxEntries;
  for (const [name, value] of Object.entries({ max, windowMs, maxEntries }))
    if (!Number.isInteger(value) || value < 1)
      throw new RangeError(`authFailures.${name} must be a positive integer`);
  /** Insertion order is window start order: a new window is always inserted last. */
  const windows = new Map();

  function prune(now) {
    for (const [key, w] of windows) {
      if (now - w.start < windowMs) break;
      windows.delete(key);
    }
  }

  return {
    /** Number of addresses currently tracked. */
    get size() {
      return windows.size;
    },
    /**
     * Seconds until `key` may try again (rounded up, at least 1), or 0 when it is not refused.
     * @param {string} key @param {number} [now]
     */
    retryAfter(key, now = Date.now()) {
      const w = windows.get(key);
      if (!w || w.count < max) return 0;
      const left = w.start + windowMs - now;
      if (left <= 0) {
        windows.delete(key);
        return 0;
      }
      return Math.max(1, Math.ceil(left / 1000));
    },
    /**
     * Count one failed authentication from `key`.
     * @param {string} key @param {number} [now]
     */
    fail(key, now = Date.now()) {
      prune(now);
      const w = windows.get(key);
      if (w) {
        w.count++;
        return;
      }
      if (windows.size >= maxEntries) windows.delete(windows.keys().next().value);
      windows.set(key, { start: now, count: 1 });
    },
  };
}
