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
 * Besides the raw value the redactor matches its JSON-escaped form, base64 (standard and URL-safe,
 * padded and unpadded, and the stable middle of the value at each byte alignment inside a longer
 * base64 string, such as a Basic-auth header), hex in both cases and percent-encoding. All forms
 * are matched in one pass by one escaped, longest-first alternation, rebuilt only when the
 * registered set changes.
 */

/** The shortest secret value the host accepts. The redactor redacts values of any length. */
export const MIN_LENGTH = 8;

/** Deepest nesting applyDeep walks; anything deeper is refused with E_INVALID_PARAMS. */
export const MAX_DEPTH = 64;

/** Keys applyDeep drops rather than copies, so a redacted copy can never reach a prototype. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const NEVER = /[^\s\S]/g;
const UNRESERVED = /^[A-Za-z0-9\-_.!~*'()]$/;

const escapeRe = (s) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
const unpad = (s) => s.replace(/=+$/, '');
const urlSafe = (s) => s.replace(/\+/g, '-').replace(/\//g, '_');
const latin1 = (s) => Buffer.from(s).toString('latin1');

/** @param {Buffer} bytes @returns {string[]} */
function base64Forms(bytes) {
  const std = bytes.toString('base64');
  const forms = [std, unpad(std)];
  for (const shift of [0, 1, 2]) {
    const enc = unpad(Buffer.concat([Buffer.alloc(shift), bytes]).toString('base64'));
    const head = shift === 0 ? 0 : shift + 1;
    const tail = (shift + bytes.length) % 3 === 0 ? 0 : 1;
    const middle = enc.slice(head, enc.length - tail);
    if (middle.length >= MIN_LENGTH) forms.push(middle);
  }
  return [...forms, ...forms.map(urlSafe)];
}

/** @param {Buffer} bytes @returns {string[]} */
function percentForms(bytes) {
  let reserved = '';
  let every = '';
  for (const b of bytes) {
    const code = `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    const ch = String.fromCharCode(b);
    every += code;
    reserved += UNRESERVED.test(ch) ? ch : code;
  }
  const lower = (s) => s.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
  return [reserved, lower(reserved), every, lower(every)];
}

/** @param {string} value @returns {string[]} every form of the value the redactor matches */
function formsOf(value) {
  const bytes = Buffer.from(value);
  const hex = bytes.toString('hex');
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    ...base64Forms(bytes),
    hex,
    hex.toUpperCase(),
    ...percentForms(bytes),
  ];
}

/**
 * @typedef {object} Matcher
 * @property {RegExp} re one alternation of every form, longest first
 * @property {Map<string, string>} markers form -> replacement marker
 * @property {string[]} sorted every form in code-unit order, for the prefix check
 * @property {number} longest length of the longest form
 */

/**
 * @param {Map<string, string>} values value -> label
 * @param {boolean} binary match latin1 views of UTF-8 bytes instead of strings
 * @returns {Matcher}
 */
function compile(values, binary) {
  const markers = new Map();
  for (const [value, label] of values) {
    const marker = `[REDACTED:${label}]`;
    for (const form of formsOf(value))
      markers.set(binary ? latin1(form) : form, binary ? latin1(marker) : marker);
  }
  const byLength = [...markers.keys()].sort((a, b) => b.length - a.length);
  return {
    re: byLength.length ? new RegExp(byLength.map(escapeRe).join('|'), 'g') : NEVER,
    markers,
    sorted: [...byLength].sort(),
    longest: byLength.length ? byLength[0].length : 0,
  };
}

/** @param {string} text @param {Matcher} m */
function replaceAll(text, m) {
  return text.replace(m.re, (hit) => m.markers.get(hit));
}

/**
 * True when `s` is a proper prefix of some form, so a match could continue into the next chunk.
 * @param {string} s @param {Matcher} m
 */
function continues(s, m) {
  let lo = 0;
  let hi = m.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (m.sorted[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  if (m.sorted[lo] === s) lo++;
  return lo < m.sorted.length && m.sorted[lo].startsWith(s);
}

/**
 * First index at or after `from` whose suffix could still grow into a match.
 * @param {string} buf @param {number} from @param {Matcher} m
 */
function holdFrom(buf, from, m) {
  for (let i = Math.max(from, buf.length - m.longest + 1); i < buf.length; i++)
    if (continues(buf.slice(i), m)) return i;
  return buf.length;
}

export class Redactor {
  constructor() {
    /** @type {Map<string, string>} value -> label */
    this.values = new Map();
    /** @type {{text: Matcher|null, binary: Matcher|null}} */
    this.compiled = { text: null, binary: null };
  }

  /**
   * Register a value. Any non-empty string is accepted and redacted, however short.
   * @param {string} value the secret
   * @param {string} [label] shown in the replacement marker
   * @returns {boolean} false when the value is not a non-empty string
   */
  add(value, label = 'secret') {
    if (typeof value !== 'string' || value.length === 0) return false;
    if (this.values.get(value) !== label) {
      this.values.set(value, label);
      this.compiled = { text: null, binary: null };
    }
    return true;
  }

  /** @param {string} value */
  remove(value) {
    const had = this.values.delete(value);
    if (had) this.compiled = { text: null, binary: null };
    return had;
  }

  get size() {
    return this.values.size;
  }

  /** @param {boolean} binary @returns {Matcher} */
  _matcher(binary) {
    const key = binary ? 'binary' : 'text';
    this.compiled[key] ??= compile(this.values, binary);
    return this.compiled[key];
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  apply(text) {
    if (typeof text !== 'string' || !this.values.size) return text;
    return replaceAll(text, this._matcher(false));
  }

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

  /**
   * A redacting view of one output stream whose values may be split across chunks.
   * @param {{binary?: boolean}} [opts] binary: chunks are Buffers, matched byte-wise
   * @returns {RedactStream}
   */
  stream(opts = {}) {
    return new RedactStream(this, opts.binary === true);
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

/**
 * Redacts a stream of chunks (spool output, log lines). Each push returns the output that is now
 * final. Only a trailing run that could still be the start of a registered form is held for the
 * next push, never more than the longest form minus one, so a value split across any number of
 * chunks is redacted exactly once, output keeps its order, nothing is emitted twice, and a chunk
 * whose end cannot begin a value (a finished line, say) comes back whole. Call end() to flush.
 * The concatenated output equals Redactor.apply over the concatenated input.
 */
export class RedactStream {
  /** @param {Redactor} redactor @param {boolean} binary */
  constructor(redactor, binary) {
    this.redactor = redactor;
    this.binary = binary;
    this.tail = '';
  }

  /**
   * @param {string|Buffer} chunk a Buffer in binary mode, a string otherwise
   * @returns {string|Buffer} the redacted output that is final, possibly empty
   */
  push(chunk) {
    const m = this.redactor._matcher(this.binary);
    const buf = this.tail + this._decode(chunk);
    let out = '';
    let pos = 0;
    let hold = holdFrom(buf, 0, m);
    m.re.lastIndex = 0;
    for (let hit = m.re.exec(buf); hit && hit.index < hold; hit = m.re.exec(buf)) {
      out += buf.slice(pos, hit.index) + m.markers.get(hit[0]);
      pos = hit.index + hit[0].length;
      if (pos > hold) hold = holdFrom(buf, pos, m);
    }
    m.re.lastIndex = 0;
    this.tail = buf.slice(hold);
    return this._encode(out + buf.slice(pos, hold));
  }

  /** Flush the held tail. @returns {string|Buffer} */
  end() {
    const out = replaceAll(this.tail, this.redactor._matcher(this.binary));
    this.tail = '';
    return this._encode(out);
  }

  /** @param {string|Buffer} chunk */
  _decode(chunk) {
    if (!this.binary) return String(chunk);
    return (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).toString('latin1');
  }

  /** @param {string} s */
  _encode(s) {
    return this.binary ? Buffer.from(s, 'latin1') : s;
  }
}
