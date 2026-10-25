import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  CgroupManager,
  parseMax,
  parseKV,
  REQUIRED_CONTROLLERS,
  CPU_PERIOD_USEC,
} from '../../../src/host/cgroup.js';

const PARENT = `workbox-test-${process.pid}`;

test('parsers', () => {
  assert.equal(parseMax('max\n'), Infinity);
  assert.equal(parseMax(' 42 '), 42);
  assert.deepEqual(parseKV('low 0\nhigh 1\noom_kill 3\n'), { low: 0, high: 1, oom_kill: 3 });
  assert.deepEqual(parseKV(''), {});
  assert.deepEqual(REQUIRED_CONTROLLERS, ['cpu', 'memory', 'pids']);
  assert.equal(CPU_PERIOD_USEC, 100_000);
  assert.throws(
    () => new CgroupManager({ parent: 'a/b' }),
    (e) => e.code === 'E_INVALID_PARAMS',
  );
});

test('parent creation, child limits, stats and removal on the real cgroup tree', async () => {
  const cg = new CgroupManager({ parent: PARENT });
  try {
    assert.equal(cg.parentPath, `/sys/fs/cgroup/${PARENT}`);
    assert.ok(cg.rootControllers().includes('memory'));
    const parent = cg.ensureParent();
    assert.equal(parent.path, cg.parentPath);
    for (const c of REQUIRED_CONTROLLERS) assert.ok(parent.controllers.includes(c), c);
    assert.deepEqual(cg.ensureParent().controllers, parent.controllers);
    assert.deepEqual(cg.list(), []);

    const limits = { memoryBytes: 256 * 1024 * 1024, swapBytes: 0, cpuMillis: 1500, pids: 64 };
    const p = cg.create('child-a', limits);
    assert.equal(p, path.join(cg.parentPath, 'child-a'));
    assert.ok(cg.exists(p));
    assert.deepEqual(cg.readLimits(p), limits);
    assert.equal(fs.readFileSync(path.join(p, 'cpu.max'), 'utf8').trim(), '150000 100000');
    assert.deepEqual(cg.list(), ['child-a']);
    assert.throws(
      () => cg.create('child-a', limits),
      (e) => e.code === 'E_CONFLICT',
    );
    assert.throws(
      () => cg.create('bad name', limits),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    assert.throws(
      () => cg.create('child-b', { ...limits, pids: 0 }),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    assert.equal(fs.existsSync(path.join(cg.parentPath, 'child-b')), false);
    assert.throws(
      () => cg.create('child-c', { ...limits, memoryBytes: 1.5 }),
      (e) => e.code === 'E_INVALID_PARAMS',
    );

    const stats = cg.stats(p);
    assert.equal(stats.procs, 0);
    assert.equal(stats.pidsCurrent, 0);
    assert.equal(stats.memoryEvents.oom_kill, 0);
    assert.equal(typeof stats.cpuUsageUsec, 'number');
    assert.deepEqual(cg.procs(p), []);
    assert.equal(await cg.waitEmpty(p, { timeoutMs: 100 }), true);

    cg.applyLimits(p, { ...limits, cpuMillis: 250 });
    assert.equal(cg.readLimits(p).cpuMillis, 250);
    assert.throws(
      () => cg.readLimits(path.join(cg.parentPath, 'nope')),
      (e) => e.code === 'E_UNAVAILABLE',
    );
    assert.throws(
      () => cg.applyLimits(path.join(cg.parentPath, 'nope'), limits),
      (e) => e.code === 'E_UNAVAILABLE',
    );

    const removed = await cg.remove(p);
    assert.equal(removed.removed, true);
    assert.equal(removed.method, 'cgroup.kill');
    assert.equal(cg.exists(p), false);
    assert.deepEqual(await cg.remove(p), { removed: false, reason: 'absent' });
    assert.throws(
      () => cg.childPath('../escape'),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
  } finally {
    for (const name of cg.list()) await cg.remove(cg.childPath(name)).catch(() => {});
    fs.rmdirSync(cg.parentPath, { recursive: false });
  }
});

test('ensureParent rejects a root without the required controllers', () => {
  const cg = new CgroupManager({ root: '/nonexistent-cgroup-root', parent: 'x' });
  assert.throws(
    () => cg.ensureParent(),
    (e) => e.code === 'E_UNAVAILABLE',
  );
  assert.deepEqual(cg.list(), []);
});
