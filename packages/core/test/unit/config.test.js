import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadConfig,
  derivePaths,
  merge,
  deepFreeze,
  DEFAULTS,
  DEFAULT_ROOT,
  ENV_KEYS,
  NETWORK_MODES,
  MAXIMA,
  MAX_CONFIG_DEPTH,
} from '../../src/config.js';
import { tmpDir } from '../helpers/tmp.js';

test('defaults resolve with derived paths and are frozen', () => {
  const cfg = loadConfig({ env: {} });
  assert.equal(cfg.root, DEFAULT_ROOT);
  assert.equal(cfg.uid.base, 200000);
  assert.equal(cfg.network.mode, 'egress');
  assert.equal(cfg.paths.db, path.join(DEFAULT_ROOT, 'workbox.db'));
  assert.equal(cfg.paths.cgroup, '/sys/fs/cgroup/workbox');
  assert.ok(Object.isFrozen(cfg) && Object.isFrozen(cfg.limits) && Object.isFrozen(cfg.paths));
  assert.throws(() => {
    cfg.limits.pids = 1;
  }, TypeError);
  assert.deepEqual(NETWORK_MODES, ['none', 'egress', 'allowlist']);
  assert.ok(Object.isFrozen(DEFAULTS));
});

test('environment variables override defaults with type checks', () => {
  const cfg = loadConfig({
    env: {
      WORKBOX_ROOT: '/srv/wb',
      WORKBOX_UID_BASE: '300000',
      WORKBOX_NETWORK_MODE: 'none',
      WORKBOX_CGROUP_PARENT: 'wb.slice',
      WORKBOX_ROOTFS: 'dev',
      WORKBOX_SECRETS_FILE: '/srv/s.json',
    },
  });
  assert.equal(cfg.root, '/srv/wb');
  assert.equal(cfg.uid.base, 300000);
  assert.equal(cfg.network.mode, 'none');
  assert.equal(cfg.paths.cgroup, '/sys/fs/cgroup/wb.slice');
  assert.equal(cfg.rootfs, 'dev');
  assert.equal(cfg.secretsFile, '/srv/s.json');
  assert.throws(
    () => loadConfig({ env: { WORKBOX_UID_BASE: 'abc' } }),
    (e) => e.code === 'E_INVALID_PARAMS' && /WORKBOX_UID_BASE/.test(e.message),
  );
  assert.equal(Object.keys(ENV_KEYS).length, 9);
  const ignored = loadConfig({ env: { WORKBOX_ROOT: '' } });
  assert.equal(ignored.root, DEFAULT_ROOT);
});

test('config file merges beneath env and above defaults; overrides win', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        root: '/from/file',
        limits: { pids: 99 },
        network: { mode: 'allowlist', allow: ['registry.npmjs.org'] },
      }),
    );
    const cfg = loadConfig({
      file,
      env: { WORKBOX_ROOT: '/from/env' },
      overrides: { limits: { cpuMillis: 500 } },
    });
    assert.equal(cfg.root, '/from/env');
    assert.equal(cfg.limits.pids, 99);
    assert.equal(cfg.limits.cpuMillis, 500);
    assert.equal(cfg.limits.memoryBytes, DEFAULTS.limits.memoryBytes);
    assert.deepEqual(cfg.network.allow, ['registry.npmjs.org']);
    const viaEnv = loadConfig({ env: { WORKBOX_CONFIG: file } });
    assert.equal(viaEnv.root, '/from/file');
    fs.writeFileSync(file, '{bad');
    assert.throws(() => loadConfig({ file, env: {} }), /not valid JSON/);
    fs.writeFileSync(file, '[1]');
    assert.throws(() => loadConfig({ file, env: {} }), /must contain a JSON object/);
    assert.throws(
      () => loadConfig({ file: path.join(dir, 'missing.json'), env: {} }),
      /not readable/,
    );
  } finally {
    cleanup();
  }
});

test('validation rejects unsafe values with every problem listed', () => {
  const bad = () =>
    loadConfig({
      env: {},
      overrides: {
        root: 'relative',
        uid: { base: 1000 },
        limits: { memoryBytes: 1, pids: 1 },
        network: { mode: 'open', allow: 'x' },
        cgroup: { parent: 'a/b' },
        rootfs: 'bad name',
        session: { spoolBytes: 1 },
        lease: { ttlMs: 1 },
      },
    });
  assert.throws(bad, (e) => {
    assert.equal(e.code, 'E_INVALID_PARAMS');
    const p = e.data.problems.join('\n');
    for (const needle of [
      'root must be',
      'uid.base',
      'limits.memoryBytes',
      'limits.pids',
      'network.mode',
      'network.allow',
      'cgroup.parent',
      'rootfs must be',
      'session.spoolBytes',
      'lease.ttlMs',
    ]) {
      assert.match(p, new RegExp(needle));
    }
    return true;
  });
  assert.throws(
    () => loadConfig({ env: {}, overrides: { secretsFile: 'rel.json' } }),
    /secretsFile/,
  );
  assert.throws(
    () => loadConfig({ env: {}, overrides: { cgroup: { root: 'rel' } } }),
    /cgroup.root/,
  );
  assert.throws(() => loadConfig({ env: {}, overrides: { runtime: 'x y' } }), /runtime must be/);
  assert.throws(() => loadConfig({ env: {}, overrides: { bootTimeoutMs: 1 } }), /bootTimeoutMs/);
  assert.throws(
    () => loadConfig({ env: {}, overrides: { limits: { swapBytes: -1 } } }),
    /limits.swapBytes/,
  );
});

test('merge, derivePaths and deepFreeze helpers', () => {
  const merged = merge({ a: { b: 1, c: [1] }, d: 1 }, { a: { c: [2, 3] }, e: null });
  assert.deepEqual(merged, { a: { b: 1, c: [2, 3] }, d: 1, e: null });
  const paths = derivePaths({ root: '/x/../y', cgroup: { root: '/sys/fs/cgroup', parent: 'p' } });
  assert.equal(paths.root, '/y');
  assert.equal(paths.sandboxes, '/y/sandboxes');
  assert.equal(paths.cgroup, '/sys/fs/cgroup/p');
  const frozen = deepFreeze({ a: { b: [1, { c: 2 }] } });
  assert.ok(Object.isFrozen(frozen.a.b[1]));
  assert.equal(deepFreeze(5), 5);
  assert.equal(deepFreeze(null), null);
});

test('a __proto__ patch is dropped at every depth and leaves Object.prototype untouched', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const hostile =
      '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}},' +
      '"limits":{"__proto__":{"polluted":3},"pids":64},' +
      '"network":{"allow":[{"__proto__":{"polluted":4}}]}}';
    const patch = JSON.parse(hostile);
    const merged = merge({ limits: { pids: 1 }, network: {} }, patch);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(Object.keys(merged), ['limits', 'network']);
    assert.equal(Object.hasOwn(merged.limits, '__proto__'), false);
    assert.equal(Object.getPrototypeOf(merged.limits), Object.prototype);
    assert.equal(merged.limits.pids, 64);
    assert.equal(Object.hasOwn(merged.network.allow[0], '__proto__'), false);
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, '{"__proto__":{"polluted":5},"limits":{"__proto__":{"pids":1}}}');
    const cfg = loadConfig({ file, env: {}, overrides: JSON.parse('{"__proto__":{"x":1}}') });
    assert.equal(cfg.limits.pids, DEFAULTS.limits.pids);
    assert.equal(Object.prototype.polluted, undefined);
    assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  } finally {
    cleanup();
  }
});

test('unknown keys and non-object groups are rejected with a coded error', () => {
  assert.throws(
    () => loadConfig({ env: {}, overrides: { limits: { memoryByte: 1 }, netwrok: {} } }),
    (e) => {
      assert.equal(e.code, 'E_INVALID_PARAMS');
      assert.deepEqual(e.data.unknown, ['limits.memoryByte', 'netwrok']);
      assert.match(e.message, /unknown key limits\.memoryByte/);
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ env: {}, overrides: { uid: null, session: 5 } }),
    (e) =>
      e.code === 'E_INVALID_PARAMS' &&
      e.data.problems.includes('uid must be an object') &&
      e.data.problems.includes('session must be an object'),
  );
  const { dir, cleanup } = tmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ lease: { ttl: 5000 } }));
    assert.throws(
      () => loadConfig({ file, env: {} }),
      (e) => e.code === 'E_INVALID_PARAMS' && e.data.unknown[0] === 'lease.ttl',
    );
  } finally {
    cleanup();
  }
  const derived = loadConfig({ env: {}, overrides: { paths: { db: '/elsewhere' } } });
  assert.equal(derived.paths.db, path.join(DEFAULT_ROOT, 'workbox.db'), 'paths is re-derived');
});

test('a 1000-deep config document is refused with a code, not a stack overflow', () => {
  let deep = 'leaf';
  for (let i = 0; i < 1000; i++) deep = { n: deep };
  assert.throws(
    () => merge({}, { deep }),
    (e) => e.code === 'E_INVALID_PARAMS' && e.data.maxDepth === MAX_CONFIG_DEPTH,
  );
  const { dir, cleanup } = tmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, `${'{"limits":'.repeat(1000)}1${'}'.repeat(1000)}`);
    assert.throws(
      () => loadConfig({ file, env: {} }),
      (e) => e.code === 'E_INVALID_PARAMS' && /deeper than 64/.test(e.message),
    );
  } finally {
    cleanup();
  }
});

test('numeric settings above their kernel, cgroup or wire maxima are rejected', () => {
  const over = {
    'limits.memoryBytes': { limits: { memoryBytes: 2 ** 53 } },
    'limits.swapBytes': { limits: { swapBytes: MAXIMA.swapBytes + 1 } },
    'limits.cpuMillis': { limits: { cpuMillis: MAXIMA.cpuMillis + 1 } },
    'limits.pids': { limits: { pids: MAXIMA.pids + 1 } },
    'session.spoolBytes': { session: { spoolBytes: MAXIMA.spoolBytes + 1 } },
    'session.stopGraceMs': { session: { stopGraceMs: MAXIMA.stopGraceMs + 1 } },
    'lease.ttlMs': { lease: { ttlMs: MAXIMA.ttlMs + 1 } },
    bootTimeoutMs: { bootTimeoutMs: MAXIMA.bootTimeoutMs + 1 },
    'uid.base \\+ uid.count': { uid: { base: 2 ** 32 - 65536, count: 65536 } },
    'uid.count': { uid: { count: 2 ** 32 } },
  };
  for (const [name, overrides] of Object.entries(over)) {
    assert.throws(
      () => loadConfig({ env: {}, overrides }),
      (e) => e.code === 'E_INVALID_PARAMS' && new RegExp(`${name} must be`).test(e.message),
      name,
    );
  }
  const atMax = loadConfig({
    env: {},
    overrides: {
      uid: { base: 2 ** 32 - 1 - 65536, count: 65536 },
      limits: {
        memoryBytes: MAXIMA.memoryBytes,
        swapBytes: MAXIMA.swapBytes,
        cpuMillis: MAXIMA.cpuMillis,
        pids: MAXIMA.pids,
      },
      session: { spoolBytes: MAXIMA.spoolBytes, stopGraceMs: MAXIMA.stopGraceMs },
      lease: { ttlMs: MAXIMA.ttlMs },
      bootTimeoutMs: MAXIMA.bootTimeoutMs,
    },
  });
  assert.equal(atMax.limits.pids, 4 * 1024 * 1024);
  assert.equal(atMax.limits.memoryBytes, 2 ** 52);
  const total = atMax.limits.memoryBytes + atMax.limits.swapBytes;
  assert.equal(total, 2 ** 53);
  assert.equal(total - 1, Number.MAX_SAFE_INTEGER, 'the sum is still exact');
});
