import fs from 'node:fs';
import path from 'node:path';
import { E } from './errors.js';

export const DEFAULT_ROOT = '/var/lib/workbox';
export const DEFAULT_SECRETS_FILE = '/etc/workbox/secrets.json';
export const NETWORK_MODES = Object.freeze(['none', 'egress', 'allowlist']);

/** Built-in defaults. Every key can be overridden by file, environment or caller. */
export const DEFAULTS = Object.freeze({
  root: DEFAULT_ROOT,
  secretsFile: DEFAULT_SECRETS_FILE,
  uid: Object.freeze({ base: 300000, count: 65536 }),
  cgroup: Object.freeze({ root: '/sys/fs/cgroup', parent: 'workbox' }),
  limits: Object.freeze({ memoryBytes: 2 * 1024 ** 3, swapBytes: 0, cpuMillis: 2000, pids: 4096 }),
  network: Object.freeze({ mode: 'egress', allow: Object.freeze([]) }),
  rootfs: 'minimal',
  runtime: 'current',
  session: Object.freeze({ spoolBytes: 8 * 1024 * 1024, stopGraceMs: 5000 }),
  lease: Object.freeze({ ttlMs: 300_000 }),
  events: Object.freeze({ retentionDays: 30 }),
  webhooks: Object.freeze({
    allowPrivate: false,
    allowHttp: false,
    timeoutMs: 15_000,
    concurrency: 8,
    retryDelaysMs: Object.freeze([
      5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000,
    ]),
  }),
  bootTimeoutMs: 20_000,
});

/** Environment variables honoured by loadConfig, with the config path each one sets. */
export const ENV_KEYS = Object.freeze({
  WORKBOX_ROOT: 'root',
  WORKBOX_SECRETS_FILE: 'secretsFile',
  WORKBOX_UID_BASE: 'uid.base',
  WORKBOX_UID_COUNT: 'uid.count',
  WORKBOX_CGROUP_ROOT: 'cgroup.root',
  WORKBOX_CGROUP_PARENT: 'cgroup.parent',
  WORKBOX_NETWORK_MODE: 'network.mode',
  WORKBOX_ROOTFS: 'rootfs',
  WORKBOX_RUNTIME: 'runtime',
});

const INT_PATHS = new Set(['uid.base', 'uid.count']);

/** Keys that could reach an object prototype; merge drops them at every depth. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
/** Deepest config document merge accepts; real configs nest two levels. */
export const MAX_CONFIG_DEPTH = 64;
/** Top-level keys the code writes itself; accepted on input and always re-derived. */
const DERIVED_KEYS = new Set(['paths']);

/**
 * Upper bounds for numeric settings, each mirroring the kernel, cgroup or wire limit the value
 * ends up in. Larger values cannot take effect and are rejected instead of silently clamped.
 */
export const MAXIMA = Object.freeze({
  /** Largest valid uid_t is 2^32 - 2; (uid_t)-1 means "no change" to the kernel. */
  uidEnd: 2 ** 32 - 1,
  /** MAX_PHYSMEM_BITS is at most 52 on any 64-bit Linux; memory + swap stays exact (<= 2^53). */
  memoryBytes: 2 ** 52,
  swapBytes: 2 ** 52,
  /** NR_CPUS tops out at 8192 (MAXSMP); a quota above every CPU's full share means nothing. */
  cpuMillis: 8192 * 1000,
  /** PID_MAX_LIMIT on 64-bit kernels. */
  pids: 4 * 1024 * 1024,
  /** session.start spoolBytes bound in the protocol. */
  spoolBytes: 64 * 1024 * 1024,
  /** session.stop graceMs bound in the protocol. */
  stopGraceMs: 600_000,
  /** broker.lease.renew ttlMs bound in the protocol. */
  ttlMs: 24 * 3600 * 1000,
  /** Largest delay a Node timer honours; beyond it setTimeout fires after 1 ms. */
  bootTimeoutMs: 2 ** 31 - 1,
  /** ECMAScript time values span 10^8 days either side of the epoch; no older cutoff exists. */
  retentionDays: 1e8,
  /** Largest delay a Node timer honours: the bound of a webhook request and of each retry delay. */
  webhookDelayMs: 2 ** 31 - 1,
  /** Webhook requests in flight at once. */
  webhookConcurrency: 256,
  /** Retries after the first webhook attempt. */
  webhookRetries: 32,
});

/**
 * @typedef {object} Config
 * @property {string} root
 * @property {string} secretsFile
 * @property {{base: number, count: number}} uid
 * @property {{root: string, parent: string}} cgroup
 * @property {{memoryBytes: number, swapBytes: number, cpuMillis: number, pids: number}} limits
 * @property {{mode: 'none'|'egress'|'allowlist', allow: string[]}} network
 * @property {string} rootfs
 * @property {string} runtime
 * @property {{spoolBytes: number, stopGraceMs: number}} session
 * @property {{ttlMs: number}} lease
 * @property {{retentionDays: number}} events days the event log keeps a row
 * @property {{allowPrivate: boolean, allowHttp: boolean, timeoutMs: number, concurrency: number, retryDelaysMs: number[]}} webhooks
 *   outbound webhook deliveries: which targets are allowed, the request timeout, how many run at
 *   once and the delays between attempts
 * @property {number} bootTimeoutMs
 * @property {Paths} paths
 */

/**
 * @typedef {object} Paths
 * @property {string} root
 * @property {string} rootfs directory holding one subdirectory per rootfs name
 * @property {string} runtime directory holding one subdirectory per runtime version plus `current`
 * @property {string} sandboxes one subdirectory per sandbox id
 * @property {string} db the SQLite file
 * @property {string} audit NDJSON audit files
 * @property {string} artifacts content-addressed store
 * @property {string} checkpoints checkpoint tarballs
 * @property {string} cgroup absolute path of the parent cgroup
 */

/**
 * Resolve the configuration: defaults, then the JSON file (WORKBOX_CONFIG or `file`), then
 * environment variables, then explicit overrides. The result is deep-frozen and validated.
 * @param {{file?: string, env?: NodeJS.ProcessEnv, overrides?: object}} [opts]
 * @returns {Config}
 */
export function loadConfig(opts = {}) {
  const env = opts.env ?? process.env;
  let cfg = clone(DEFAULTS);
  const file = opts.file ?? env.WORKBOX_CONFIG;
  if (file) cfg = merge(cfg, readConfigFile(file));
  for (const [key, target] of Object.entries(ENV_KEYS)) {
    if (env[key] === undefined || env[key] === '') continue;
    setPath(cfg, target, INT_PATHS.has(target) ? parseIntStrict(env[key], key) : env[key]);
  }
  if (opts.overrides) cfg = merge(cfg, opts.overrides);
  validate(cfg);
  cfg.paths = derivePaths(cfg);
  return deepFreeze(cfg);
}

/**
 * @param {{root: string, cgroup: {root: string, parent: string}}} cfg
 * @returns {Paths}
 */
export function derivePaths(cfg) {
  const root = path.resolve(cfg.root);
  return {
    root,
    rootfs: path.join(root, 'rootfs'),
    runtime: path.join(root, 'runtime'),
    sandboxes: path.join(root, 'sandboxes'),
    db: path.join(root, 'workbox.db'),
    audit: path.join(root, 'audit'),
    artifacts: path.join(root, 'artifacts'),
    checkpoints: path.join(root, 'checkpoints'),
    cgroup: path.join(cfg.cgroup.root, cfg.cgroup.parent),
  };
}

/** @param {string} file */
function readConfigFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw E.invalid(`config file ${file} is not readable: ${e.message}`, { file });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw E.invalid(`config file ${file} is not valid JSON: ${e.message}`, { file });
  }
  if (!isPlainObject(parsed))
    throw E.invalid(`config file ${file} must contain a JSON object`, { file });
  return parsed;
}

/**
 * Keys absent from DEFAULTS and groups that are not objects. Checked before the field rules so
 * a typo or a scalar in place of a group fails closed with every offending path listed.
 * @param {object} cfg
 * @param {object} shape
 * @param {string} prefix
 * @param {string[]} unknown collects dotted paths of unknown keys
 * @param {string[]} problems
 */
function checkShape(cfg, shape, prefix, unknown, problems) {
  for (const [key, val] of Object.entries(cfg)) {
    const name = `${prefix}${key}`;
    if (!Object.hasOwn(shape, key)) {
      if (!(prefix === '' && DERIVED_KEYS.has(key))) unknown.push(name);
      continue;
    }
    const expected = shape[key];
    if (!isPlainObject(expected)) continue;
    if (isPlainObject(val)) checkShape(val, expected, `${name}.`, unknown, problems);
    else problems.push(`${name} must be an object`);
  }
}

/** @param {object} cfg */
function validateShape(cfg) {
  const unknown = [];
  const problems = [];
  checkShape(cfg, DEFAULTS, '', unknown, problems);
  for (const name of unknown) problems.push(`unknown key ${name}`);
  if (problems.length)
    throw E.invalid(`invalid configuration: ${problems.join('; ')}`, { problems, unknown });
}

/** @param {object} cfg */
function validate(cfg) {
  validateShape(cfg);
  const problems = [];
  const pos = (v, name, min = 1, max = Number.MAX_SAFE_INTEGER) => {
    if (!Number.isInteger(v) || v < min || v > max)
      problems.push(`${name} must be an integer >= ${min} and <= ${max}`);
  };
  if (typeof cfg.root !== 'string' || !path.isAbsolute(cfg.root))
    problems.push('root must be an absolute path');
  if (typeof cfg.secretsFile !== 'string' || !path.isAbsolute(cfg.secretsFile))
    problems.push('secretsFile must be an absolute path');
  pos(cfg.uid.base, 'uid.base', 65536, MAXIMA.uidEnd - 65536);
  pos(cfg.uid.count, 'uid.count', 65536, MAXIMA.uidEnd - 65536);
  if (cfg.uid.base + cfg.uid.count > MAXIMA.uidEnd)
    problems.push(`uid.base + uid.count must be <= ${MAXIMA.uidEnd}`);
  if (typeof cfg.cgroup.root !== 'string' || !path.isAbsolute(cfg.cgroup.root))
    problems.push('cgroup.root must be an absolute path');
  if (
    typeof cfg.cgroup.parent !== 'string' ||
    !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cfg.cgroup.parent)
  )
    problems.push('cgroup.parent must be a single path component');
  pos(cfg.limits.memoryBytes, 'limits.memoryBytes', 16 * 1024 * 1024, MAXIMA.memoryBytes);
  pos(cfg.limits.swapBytes, 'limits.swapBytes', 0, MAXIMA.swapBytes);
  pos(cfg.limits.cpuMillis, 'limits.cpuMillis', 100, MAXIMA.cpuMillis);
  pos(cfg.limits.pids, 'limits.pids', 16, MAXIMA.pids);
  if (!NETWORK_MODES.includes(cfg.network.mode))
    problems.push(`network.mode must be one of ${NETWORK_MODES.join(', ')}`);
  if (!Array.isArray(cfg.network.allow) || cfg.network.allow.some((h) => typeof h !== 'string'))
    problems.push('network.allow must be an array of hostnames');
  if (
    typeof cfg.rootfs !== 'string' ||
    !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cfg.rootfs)
  )
    problems.push('rootfs must be a name');
  if (
    typeof cfg.runtime !== 'string' ||
    !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cfg.runtime)
  )
    problems.push('runtime must be a name');
  pos(cfg.session.spoolBytes, 'session.spoolBytes', 4096, MAXIMA.spoolBytes);
  pos(cfg.session.stopGraceMs, 'session.stopGraceMs', 0, MAXIMA.stopGraceMs);
  pos(cfg.lease.ttlMs, 'lease.ttlMs', 1000, MAXIMA.ttlMs);
  pos(cfg.events.retentionDays, 'events.retentionDays', 1, MAXIMA.retentionDays);
  validateWebhooks(cfg.webhooks, pos, problems);
  pos(cfg.bootTimeoutMs, 'bootTimeoutMs', 1000, MAXIMA.bootTimeoutMs);
  if (problems.length)
    throw E.invalid(`invalid configuration: ${problems.join('; ')}`, { problems });
}

/**
 * @param {object} webhooks the `webhooks` group
 * @param {(v: unknown, name: string, min?: number, max?: number) => void} pos integer range check
 * @param {string[]} problems
 */
function validateWebhooks(webhooks, pos, problems) {
  for (const flag of ['allowPrivate', 'allowHttp'])
    if (typeof webhooks[flag] !== 'boolean')
      problems.push(`webhooks.${flag} must be true or false`);
  pos(webhooks.timeoutMs, 'webhooks.timeoutMs', 100, MAXIMA.webhookDelayMs);
  pos(webhooks.concurrency, 'webhooks.concurrency', 1, MAXIMA.webhookConcurrency);
  const delays = webhooks.retryDelaysMs;
  if (
    !Array.isArray(delays) ||
    delays.length > MAXIMA.webhookRetries ||
    delays.some((d) => !Number.isInteger(d) || d < 0 || d > MAXIMA.webhookDelayMs)
  )
    problems.push(
      `webhooks.retryDelaysMs must be at most ${MAXIMA.webhookRetries} integers >= 0 and <= ${MAXIMA.webhookDelayMs}`,
    );
}

function parseIntStrict(text, name) {
  if (!/^\d+$/.test(text))
    throw E.invalid(`${name} must be a non-negative integer, got ${JSON.stringify(text)}`, {
      name,
    });
  return Number(text);
}

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function clone(x) {
  return structuredClone(x);
}

/**
 * Deep merge where objects recurse and everything else (arrays included) is replaced.
 * `__proto__`, `constructor` and `prototype` keys are dropped at every depth of the patch, and
 * a patch nested deeper than MAX_CONFIG_DEPTH is refused with a coded error.
 * @param {object} base
 * @param {object} patch
 */
export function merge(base, patch) {
  return mergeAt(base, patch, 0);
}

function mergeAt(base, patch, depth) {
  guardDepth(depth);
  const out = clone(base);
  for (const [k, val] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    out[k] =
      isPlainObject(val) && isPlainObject(out[k])
        ? mergeAt(out[k], val, depth + 1)
        : safeCopy(val, depth + 1);
  }
  return out;
}

/** @param {number} depth */
function guardDepth(depth) {
  if (depth > MAX_CONFIG_DEPTH)
    throw E.invalid(`configuration nests deeper than ${MAX_CONFIG_DEPTH} levels`, {
      maxDepth: MAX_CONFIG_DEPTH,
    });
}

/** Copy JSON-shaped data, dropping prototype keys and refusing excessive nesting. */
function safeCopy(val, depth) {
  guardDepth(depth);
  if (Array.isArray(val)) return val.map((item) => safeCopy(item, depth + 1));
  if (!isPlainObject(val)) return clone(val);
  const out = {};
  for (const [k, item] of Object.entries(val)) {
    if (!UNSAFE_KEYS.has(k)) out[k] = safeCopy(item, depth + 1);
  }
  return out;
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

/** @template T @param {T} obj @returns {T} */
export function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) deepFreeze(val);
  return obj;
}
