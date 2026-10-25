/**
 * Replaces registered secret values in text and objects. Values shorter than MIN_LENGTH are
 * refused because redacting them would destroy ordinary output.
 */
export const MIN_LENGTH = 6;

export class Redactor {
  constructor() {
    /** @type {Map<string, string>} value -> label */
    this.values = new Map();
    this.sorted = [];
  }

  /**
   * @param {string} value the secret
   * @param {string} [label] shown in the replacement marker
   * @returns {boolean} false when the value is too short to redact safely
   */
  add(value, label = 'secret') {
    if (typeof value !== 'string' || value.length < MIN_LENGTH) return false;
    this.values.set(value, label);
    this.sorted = [...this.values.keys()].sort((a, b) => b.length - a.length);
    return true;
  }

  /** @param {string} value */
  remove(value) {
    const had = this.values.delete(value);
    this.sorted = [...this.values.keys()].sort((a, b) => b.length - a.length);
    return had;
  }

  get size() {
    return this.values.size;
  }

  /**
   * @param {string} text
   * @returns {string}
   */
  apply(text) {
    if (typeof text !== 'string' || !this.sorted.length) return text;
    let out = text;
    for (const value of this.sorted) {
      if (out.includes(value)) out = out.split(value).join(`[REDACTED:${this.values.get(value)}]`);
    }
    return out;
  }

  /**
   * Redact every string inside a JSON-like value, returning a new value.
   * @template T
   * @param {T} value
   * @returns {T}
   */
  applyDeep(value) {
    if (typeof value === 'string') return this.apply(value);
    if (Array.isArray(value)) return value.map((x) => this.applyDeep(x));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(value)) out[this.apply(k)] = this.applyDeep(val);
      return out;
    }
    return value;
  }
}
