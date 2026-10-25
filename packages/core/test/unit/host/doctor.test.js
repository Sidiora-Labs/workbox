import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  runDoctor,
  run,
  parseVersion,
  compareVersions,
  parseSubid,
  coversRange,
  findInPath,
  formatReport,
  Status,
} from '../../../src/host/doctor.js';
import { loadConfig } from '../../../src/config.js';
import { tmpDir } from '../../helpers/tmp.js';

test('pure helpers', async () => {
  assert.equal(parseVersion('bubblewrap 0.9.0'), '0.9.0');
  assert.equal(parseVersion('unshare from util-linux 2.39.3'), '2.39.3');
  assert.equal(parseVersion('6.8'), '6.8.0');
  assert.equal(parseVersion('no digits'), null);
  assert.equal(parseVersion(undefined), null);
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
  assert.equal(compareVersions('2.39.3', '2.38'), 1);
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  const ranges = parseSubid('root:200000:1000000\nalice:100000:65536\nbad:line\n# c\n', [
    'root',
    '0',
  ]);
  assert.deepEqual(ranges, [{ start: 200000, count: 1000000 }]);
  assert.ok(coversRange(ranges, 200000, 65536));
  assert.equal(coversRange(ranges, 1_199_999, 2), false);
  assert.equal(coversRange([], 1, 1), false);
  assert.ok(findInPath('sh').endsWith('/sh'));
  assert.equal(findInPath('definitely-not-a-binary-xyz'), null);
  assert.equal(findInPath('sh', '/nonexistent::'), null);
  const ok = await run('sh', ['-c', 'echo out; echo err >&2; exit 3']);
  assert.deepEqual(ok, { code: 3, stdout: 'out\n', stderr: 'err\n' });
  const missing = await run('definitely-not-a-binary-xyz', []);
  assert.equal(missing.code, null);
  assert.match(missing.error, /not found/);
  const slow = await run('sleep', ['5'], { timeoutMs: 50 });
  assert.equal(slow.code, null);
  assert.ok(slow.error);
  assert.deepEqual(Object.values(Status), ['pass', 'fail', 'warn']);
});

test('the real host passes every blocking check', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({
      env: { WORKBOX_ROOT: dir, WORKBOX_CGROUP_PARENT: `workbox-doctor-${process.pid}` },
    });
    const report = await runDoctor(cfg);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    const failures = report.checks
      .filter((c) => c.status === 'fail')
      .map((c) => `${c.id}: ${c.detail}`);
    assert.deepEqual(failures, []);
    assert.equal(report.ok, true);
    for (const id of [
      'privileges',
      'kernel',
      'bwrap',
      'unshare',
      'tool.newuidmap',
      'tool.newgidmap',
      'tool.nsenter',
      'tool.setpriv',
      'subuid',
      'subgid',
      'userns',
      'overlay',
      'cgroup',
      'tool.slirp4netns',
      'tool.nft',
      'disk',
    ]) {
      assert.equal(byId[id].status, 'pass', `${id}: ${byId[id].detail}`);
    }
    assert.equal(byId.rootfs.status, 'warn');
    assert.match(byId.rootfs.remedy, /workbox rootfs build/);
    assert.equal(byId.runtime.status, 'warn');
    assert.equal(
      fs.existsSync(`/sys/fs/cgroup/workbox-doctor-${process.pid}/doctor-${process.pid}`),
      false,
    );
    const text = formatReport(report);
    assert.match(text, /PASS {2}Running as root/);
    assert.match(
      text,
      /WARN {2}Rootfs minimal installed[\s\S]*remedy: workbox rootfs build minimal/,
    );
    assert.match(text, /doctor: host is ready$/);
    fs.rmdirSync(`/sys/fs/cgroup/workbox-doctor-${process.pid}`);
  } finally {
    cleanup();
  }
});

test('misconfiguration surfaces as failures with remedies', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({
      env: { WORKBOX_ROOT: dir },
      overrides: {
        uid: { base: 5_000_000, count: 65536 },
        cgroup: { root: '/nonexistent-cgroup', parent: 'wb' },
        network: { mode: 'none' },
      },
    });
    const report = await runDoctor(cfg, { uid: 1000, release: '5.4.0-generic' });
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    assert.equal(report.ok, false);
    assert.equal(byId.privileges.status, 'fail');
    assert.equal(byId.kernel.status, 'fail');
    assert.equal(byId.subuid.status, 'fail');
    assert.match(byId.subuid.remedy, /5000000:65536/);
    assert.equal(byId.overlay.status, 'fail');
    assert.equal(byId.cgroup.status, 'fail');
    assert.match(formatReport(report), /host is NOT ready$/);
    const warnKernel = await runDoctor(
      loadConfig({
        env: { WORKBOX_ROOT: dir, WORKBOX_CGROUP_PARENT: `workbox-doctor2-${process.pid}` },
      }),
      { release: '5.12.1' },
    );
    assert.equal(warnKernel.checks.find((c) => c.id === 'kernel').status, 'warn');
    fs.rmdirSync(`/sys/fs/cgroup/workbox-doctor2-${process.pid}`);
    const noTools = await runDoctor(
      loadConfig({
        env: { WORKBOX_ROOT: dir, WORKBOX_CGROUP_PARENT: `workbox-doctor3-${process.pid}` },
      }),
      { env: { PATH: '/nonexistent' } },
    );
    assert.equal(noTools.checks.find((c) => c.id === 'tool.newuidmap').status, 'fail');
    assert.equal(
      noTools.checks.find((c) => c.id === 'tool.tar').remedy,
      'apt install util-linux tar',
    );
    fs.rmdirSync(`/sys/fs/cgroup/workbox-doctor3-${process.pid}`);
  } finally {
    cleanup();
  }
});
