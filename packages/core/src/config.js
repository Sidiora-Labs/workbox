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
  uid: Object.freeze({ base: 200000, count: 65536 }),
  cgroup: Object.freeze({ root: '/sys/fs/cgroup', parent: 'workbox' }),
  limits: Object.freeze({ memoryBytes: 2 * 1024 ** 3, swapBytes: 0, cpuMillis: 2000, pids: 4096 }),
  network: Object.freeze({ mode: 'egress', allow: Object.freeze([]) }),
  rootfs: 'minimal',
  runtime: 'current',
  session: Object.freeze({ spoolBytes: 8 * 1024 * 1024, stopGraceMs: 5000 }),
  lease: Object.freeze({ ttlMs: 300_000 }),
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

/** @param {object} cfg */
function validate(cfg) {
  const problems = [];
  const pos = (v, name, min = 1) => {
    if (!Number.isInteger(v) || v < min) problems.push(`${name} must be an integer >= ${min}`);
  };
  if (typeof cfg.root !== 'string' || !path.isAbsolute(cfg.root))
    problems.push('root must be an absolute path');
  if (typeof cfg.secretsFile !== 'string' || !path.isAbsolute(cfg.secretsFile))
    problems.push('secretsFile must be an absolute path');
  pos(cfg.uid.base, 'uid.base', 65536);
  pos(cfg.uid.count, 'uid.count', 65536);
  if (typeof cfg.cgroup.root !== 'string' || !path.isAbsolute(cfg.cgroup.root))
    problems.push('cgroup.root must be an absolute path');
  if (
    typeof cfg.cgroup.parent !== 'string' ||
    !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cfg.cgroup.parent)
  )
    problems.push('cgroup.parent must be a single path component');
  pos(cfg.limits.memoryBytes, 'limits.memoryBytes', 16 * 1024 * 1024);
  pos(cfg.limits.swapBytes, 'limits.swapBytes', 0);
  pos(cfg.limits.cpuMillis, 'limits.cpuMillis', 100);
  pos(cfg.limits.pids, 'limits.pids', 16);
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
  pos(cfg.session.spoolBytes, 'session.spoolBytes', 4096);
  pos(cfg.session.stopGraceMs, 'session.stopGraceMs', 0);
  pos(cfg.lease.ttlMs, 'lease.ttlMs', 1000);
  pos(cfg.bootTimeoutMs, 'bootTimeoutMs', 1000);
  if (problems.length)
    throw E.invalid(`invalid configuration: ${problems.join('; ')}`, { problems });
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
 * @param {object} base
 * @param {object} patch
 */
export function merge(base, patch) {
  const out = clone(base);
  for (const [k, val] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = isPlainObject(val) && isPlainObject(out[k]) ? merge(out[k], val) : clone(val);
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
