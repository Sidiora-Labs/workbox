import dns from 'node:dns';
import net from 'node:net';
import { E } from './errors.js';

/**
 * The target guard of outbound webhook requests. A target is an `https:` URL (`http:` only with
 * `allowHttp`) without credentials, at most MAX_TARGET_URL_LENGTH characters long, whose host
 * resolves only to public addresses (any address with `allowPrivate`). The check runs when a
 * webhook is created or changed and again before every delivery; the request then connects to
 * the address that was checked, so a DNS answer that changes in between cannot reach a private
 * address.
 */

/** Longest webhook URL accepted. */
export const MAX_TARGET_URL_LENGTH = 2048;

/**
 * Address ranges that are not public: this network, private and shared address space, loopback,
 * link-local, protocol assignments, documentation and benchmarking ranges (198.18.0.0/15 also
 * holds the host's sandbox proxy link), multicast, reserved, and their IPv6 counterparts. An
 * IPv4-mapped IPv6 address is judged by its IPv4 address.
 */
export const NOT_PUBLIC_RANGES = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '64:ff9b::/96',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '2001:db8::/32',
]);

const NOT_PUBLIC = new net.BlockList();
for (const range of NOT_PUBLIC_RANGES) {
  const [address, prefix] = range.split('/');
  NOT_PUBLIC.addSubnet(address, Number(prefix), net.isIPv4(address) ? 'ipv4' : 'ipv6');
}

/** `::ffff:a.b.c.d` in the hex form the URL parser writes, e.g. `::ffff:7f00:1`. */
const MAPPED_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;

/**
 * The IPv4 address an IPv4-mapped IPv6 address carries, or null.
 * @param {string} address an IPv6 address
 * @returns {string|null}
 */
export function mappedIpv4(address) {
  let canonical;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const m = MAPPED_HEX.exec(canonical);
  if (!m) return null;
  const hi = Number.parseInt(m[1], 16);
  const lo = Number.parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
}

/**
 * True when `address` is an IP address outside every NOT_PUBLIC_RANGES range. Anything that is
 * not an IP address is not public.
 * @param {string} address
 * @returns {boolean}
 */
export function isPublicAddress(address) {
  const bare = String(address ?? '').split('%')[0];
  const family = net.isIP(bare);
  if (family === 4) return !NOT_PUBLIC.check(bare, 'ipv4');
  if (family !== 6) return false;
  const v4 = mappedIpv4(bare);
  if (v4 !== null) return isPublicAddress(v4);
  return !NOT_PUBLIC.check(bare, 'ipv6');
}

/**
 * @typedef {object} TargetPolicy
 * @property {boolean} [allowHttp] accept `http:` URLs
 * @property {boolean} [allowPrivate] accept hosts that resolve to addresses that are not public
 */

/**
 * The checks that need no DNS: the URL parses, uses `https:` (or `http:` with `allowHttp`),
 * carries no user name or password and is at most MAX_TARGET_URL_LENGTH characters.
 * @param {string} text
 * @param {TargetPolicy} [policy]
 * @returns {URL}
 */
export function parseTargetUrl(text, policy = {}) {
  if (typeof text !== 'string' || text === '') throw E.invalid('the webhook url is required');
  if (text.length > MAX_TARGET_URL_LENGTH)
    throw E.invalid(`the webhook url is longer than ${MAX_TARGET_URL_LENGTH} characters`);
  let url;
  try {
    url = new URL(text);
  } catch {
    throw E.invalid('the webhook url is not a valid URL');
  }
  const allowed = policy.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowed.includes(url.protocol))
    throw E.invalid(
      policy.allowHttp
        ? `the webhook url must use https or http, not ${url.protocol}`
        : `the webhook url must use https, not ${url.protocol}`,
      { protocol: url.protocol },
    );
  if (url.username || url.password) throw E.invalid('the webhook url must not carry credentials');
  if (!url.hostname) throw E.invalid('the webhook url has no host');
  return url;
}

/**
 * @typedef {object} Target
 * @property {URL} url
 * @property {string} host the host name or IP address, without brackets
 * @property {string} address the checked address to connect to
 * @property {4|6} family
 * @property {{address: string, family: number}[]} addresses every address the host resolved to
 */

/**
 * Check a webhook URL and resolve its host. Every address the host resolves to must be public
 * unless `allowPrivate`; a refusal is E_INVALID_PARAMS naming the host and the refused addresses.
 * @param {string} text
 * @param {TargetPolicy} [policy]
 * @returns {Promise<Target>}
 */
export async function resolveTarget(text, policy = {}) {
  const url = parseTargetUrl(text, policy);
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try {
      addresses = await dns.promises.lookup(host, { all: true, verbatim: true });
    } catch (e) {
      throw E.invalid(`the webhook host ${host} does not resolve (${e.code ?? e.message})`, {
        host,
      });
    }
    if (!addresses.length) throw E.invalid(`the webhook host ${host} has no address`, { host });
  }
  if (!policy.allowPrivate) {
    const refused = addresses.map((a) => a.address).filter((a) => !isPublicAddress(a));
    if (refused.length)
      throw E.invalid(
        `the webhook host ${host} resolves to an address that is not public (${refused.join(', ')})`,
        { host, addresses: refused },
      );
  }
  const first = addresses[0];
  return { url, host, address: first.address, family: first.family === 6 ? 6 : 4, addresses };
}

/**
 * A `lookup` for http.request that answers every query with one checked address, so the
 * connection goes where the guard looked.
 * @param {string} address
 * @param {4|6} family
 * @returns {(hostname: string, options: object|Function, callback?: Function) => void}
 */
export function pinnedLookup(address, family) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof options === 'object' && options?.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}
