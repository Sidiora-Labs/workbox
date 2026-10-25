import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Time-ordered, URL-safe, 26-character identifier: 48 bits of milliseconds then 80 random bits,
 * Crockford base32. Sorting lexically sorts by creation time.
 * @param {number} [now] milliseconds since the epoch
 * @returns {string}
 */
export function newId(now = Date.now()) {
  let t = BigInt(now);
  const chars = new Array(26);
  for (let i = 9; i >= 0; i--) {
    chars[i] = ALPHABET[Number(t & 31n)];
    t >>= 5n;
  }
  const rnd = randomBytes(10);
  let acc = 0n;
  for (const b of rnd) acc = (acc << 8n) | BigInt(b);
  for (let i = 25; i >= 10; i--) {
    chars[i] = ALPHABET[Number(acc & 31n)];
    acc >>= 5n;
  }
  return chars.join('');
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** @param {unknown} s */
export function isId(s) {
  return typeof s === 'string' && ID_RE.test(s);
}

/**
 * @param {string} id
 * @returns {number} the millisecond timestamp encoded in the id
 */
export function idTime(id) {
  if (!isId(id)) throw new TypeError('not an id');
  let t = 0n;
  for (let i = 0; i < 10; i++) t = (t << 5n) | BigInt(ALPHABET.indexOf(id[i]));
  return Number(t);
}
