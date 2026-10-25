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
