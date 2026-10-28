import fs from 'node:fs';
import { E } from './errors.js';

/**
 * Host-side secret provider. Values come from a 0600 JSON file ({ "REF": "value" }) and/or the
 * process environment (`WORKBOX_SECRET_<REF>`). Values are held in memory only: never logged,
 * never written to the store. The per-sandbox policy (store `secret_policy`) is enforced by the
 * broker before resolution.
 */
export class SecretProvider {
  /**
   * @param {{file?: string|null, env?: NodeJS.ProcessEnv, envPrefix?: string}} [opts]
   */
  constructor(opts = {}) {
    this.file = opts.file ?? null;
    this.env = opts.env ?? process.env;
    this.envPrefix = opts.envPrefix ?? 'WORKBOX_SECRET_';
    /** @type {Map<string, string>} */
    this.values = new Map();
    if (this.file) this.loadFile(this.file);
    for (const [k, val] of Object.entries(this.env)) {
      if (k.startsWith(this.envPrefix) && typeof val === 'string' && val.length > 0)
        this.values.set(k.slice(this.envPrefix.length), val);
    }
  }

  /** @param {string} file a 0600 JSON object mapping ref -> value */
  loadFile(file) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return this;
    }
    if ((st.mode & 0o077) !== 0)
      throw E.denied(`secrets file ${file} must not be group/world readable`, { file });
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw E.invalid(`secrets file ${file} is not valid JSON: ${e.message}`, { file });
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw E.invalid(`secrets file ${file} must contain a JSON object`, { file });
    for (const [ref, val] of Object.entries(parsed)) {
      assertRef(ref);
      if (typeof val !== 'string' || val.length === 0)
        throw E.invalid(`secret ${ref} must be a non-empty string`, { ref });
      this.values.set(ref, val);
    }
    return this;
  }

  /** @param {string} ref @param {string} value */
  set(ref, value) {
    assertRef(ref);
    if (typeof value !== 'string' || value.length === 0)
      throw E.invalid(`secret ${ref} must be a non-empty string`, { ref });
    this.values.set(ref, value);
    return this;
  }

  /** Reference names only — safe to list. @returns {string[]} */
  refs() {
    return [...this.values.keys()].sort();
  }

  /** @param {string} ref */
  has(ref) {
    return this.values.has(ref);
  }

  /**
   * Map refs to child env vars. Ref `FOO` becomes env `FOO`; `REF=ENVNAME` renames.
   * @param {string[]} refs
   * @returns {Record<string, string>}
   */
  resolveEnv(refs) {
    const env = {};
    for (const raw of refs) {
      const { ref, envName } = parseRef(raw);
      const val = this.values.get(ref);
      if (val === undefined)
        throw E.notFound(`secret ${ref} is not configured on the host`, { ref });
      env[envName] = val;
    }
    return env;
  }

  /** All values, for the redactor. Treat as sensitive. @returns {string[]} */
  allValues() {
    return [...this.values.values()];
  }
}

/** @param {string} raw @returns {{ref: string, envName: string}} */
export function parseRef(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256)
    throw E.invalid(`invalid secret reference ${String(raw)}`);
  const eq = raw.indexOf('=');
  const ref = eq === -1 ? raw : raw.slice(0, eq);
  const envName = eq === -1 ? raw : raw.slice(eq + 1);
  assertRef(ref);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName))
    throw E.invalid(`invalid env name in secret reference ${raw}`, { ref: raw });
  return { ref, envName };
}

/** @param {string} ref */
export function assertRef(ref) {
  if (typeof ref !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(ref))
    throw E.invalid(`invalid secret reference ${String(ref)}`, { ref: String(ref) });
}
