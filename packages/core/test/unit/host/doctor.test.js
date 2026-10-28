import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  runDoctor,
  run,
  parseVersion,
  compareVersions,
  parseSubid,
  coversRange,
  subidOverlaps,
  findInPath,
  formatReport,
  withProbeCgroup,
  nodeCheck,
  proxyLinkCheck,
  networkDeviceChecks,
  kernelModule,
  blockingAncestor,
  MIN_NODE,
  Status,
} from '../../../src/host/doctor.js';
import { CgroupManager } from '../../../src/host/cgroup.js';
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
  assert.deepEqual(
    subidOverlaps(
      'root:200000:65536\nbob:165536:65536\ncarol:265536:65536\neve:100000:100000\nx:y\n',
      ['root', '0'],
      200000,
      65536,
    ),
    ['bob:165536:65536'],
  );
  assert.deepEqual(subidOverlaps('0:200000:1\n:5:5\n', ['root', '0'], 200000, 65536), []);
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
      'tool.xz',
      'tun',
      'dummy',
      'node',
      'disk',
    ]) {
      assert.equal(byId[id].status, 'pass', `${id}: ${byId[id].detail}`);
    }
    const rootStat = fs.statSync(dir);
    assert.equal(rootStat.mode & 0o7777, 0o710, 'the probe prepared the root as a launch does');
    assert.equal(rootStat.gid, cfg.uid.base);
    assert.deepEqual(
      fs.readdirSync(dir).filter((n) => n.startsWith('.doctor-')),
      [],
      'the overlay probe ran under the root and cleaned up',
    );
    assert.notEqual(byId['proxy-link'].status, 'fail');
    const subuidText = fs.readFileSync('/etc/subuid', 'utf8');
    const shared = subidOverlaps(subuidText, ['0', 'root'], cfg.uid.base, cfg.uid.count);
    assert.equal(byId['subuid.exclusive'].status, shared.length ? 'warn' : 'pass');
    assert.ok(byId['subgid.exclusive']);
    for (const c of report.checks.filter((x) => x.status !== 'pass'))
      assert.ok(c.remedy, `${c.id} reports ${c.status} without a remedy`);
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
    assert.match(byId.overlay.detail, new RegExp(`Workbox root ${dir} on \\w+`));
    assert.match(byId.overlay.remedy, /never overlayfs itself/);
    assert.equal(byId.cgroup.status, 'fail');
    for (const c of report.checks.filter((x) => x.status !== 'pass'))
      assert.ok(c.remedy, `${c.id} reports ${c.status} without a remedy`);
    assert.match(formatReport(report), /host is NOT ready$/);
    const warnKernel = await runDoctor(
      loadConfig({
        env: { WORKBOX_ROOT: dir, WORKBOX_CGROUP_PARENT: `workbox-doctor2-${process.pid}` },
      }),
      { release: '5.12.1' },
    );
    assert.equal(warnKernel.checks.find((c) => c.id === 'kernel').status, 'warn');
    assert.match(warnKernel.checks.find((c) => c.id === 'kernel').remedy, /5\.14/);
    fs.rmdirSync(`/sys/fs/cgroup/workbox-doctor2-${process.pid}`);
    const noTools = await runDoctor(
      loadConfig({
        env: { WORKBOX_ROOT: dir, WORKBOX_CGROUP_PARENT: `workbox-doctor3-${process.pid}` },
      }),
      { env: { PATH: '/nonexistent' } },
    );
    assert.equal(noTools.checks.find((c) => c.id === 'tool.newuidmap').status, 'fail');
    const xz = noTools.checks.find((c) => c.id === 'tool.xz');
    assert.equal(xz.status, 'fail', 'no runtime installed yet, so runtime install needs xz');
    assert.equal(xz.remedy, 'apt install xz-utils');
    assert.equal(
      noTools.checks.find((c) => c.id === 'tool.tar').remedy,
      'apt install util-linux tar',
    );
    fs.rmdirSync(`/sys/fs/cgroup/workbox-doctor3-${process.pid}`);
  } finally {
    cleanup();
  }
});

test('a Workbox root below a directory the mapped root cannot search fails with that directory named', async () => {
  const { dir, cleanup } = tmpDir();
  const parent = `workbox-doctor-anc-${process.pid}`;
  try {
    fs.chmodSync(dir, 0o700);
    const root = path.join(dir, 'nested', 'root');
    fs.mkdirSync(path.dirname(root), { mode: 0o755 });
    const cfg = loadConfig({ env: { WORKBOX_ROOT: root, WORKBOX_CGROUP_PARENT: parent } });
    assert.deepEqual(blockingAncestor(root, cfg.uid.base), {
      dir,
      mode: '0700',
      owner: `${process.getuid()}:${process.getgid()}`,
    });
    const report = await runDoctor(cfg);
    const overlay = report.checks.find((c) => c.id === 'overlay');
    assert.equal(overlay.status, 'fail');
    assert.match(overlay.detail, new RegExp(`^${dir} \\(mode 0700, owner \\d+:\\d+\\) keeps`));
    assert.equal(
      overlay.remedy,
      `chmod o+x ${dir}, or move the Workbox root under directories every user can search.`,
    );
    fs.chmodSync(dir, 0o750);
    fs.chownSync(dir, process.getuid(), cfg.uid.base);
    assert.equal(blockingAncestor(root, cfg.uid.base), null, 'group search is enough');
    assert.equal(blockingAncestor('/', cfg.uid.base), null);
  } finally {
    if (fs.existsSync(`/sys/fs/cgroup/${parent}`)) fs.rmdirSync(`/sys/fs/cgroup/${parent}`);
    cleanup();
  }
});

test('kernel network support is read from fixtures: devices, loaded, built-in and loadable modules', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const release = '6.1.0-test';
    const kernel = {
      tun: path.join(dir, 'dev-net-tun'),
      modules: path.join(dir, 'sys-module'),
      libModules: path.join(dir, 'lib-modules'),
    };
    fs.mkdirSync(path.join(kernel.libModules, release), { recursive: true });
    fs.mkdirSync(kernel.modules);
    const ids = (checks) => checks.map((c) => [c.id, c.status]);

    const bare = networkDeviceChecks('egress', kernel, release);
    assert.deepEqual(ids(bare), [
      ['tun', 'fail'],
      ['dummy', 'fail'],
    ]);
    assert.match(bare[0].detail, /missing; egress and allowlist sandboxes cannot start/);
    assert.match(bare[0].remedy, /CONFIG_TUN, or set network.mode to none/);
    assert.match(bare[1].remedy, /CONFIG_DUMMY/);
    assert.deepEqual(ids(networkDeviceChecks('none', kernel, release)), [
      ['tun', 'warn'],
      ['dummy', 'warn'],
    ]);

    fs.writeFileSync(kernel.tun, '');
    fs.writeFileSync(
      path.join(kernel.libModules, release, 'modules.dep'),
      'kernel/drivers/net/tun.ko.zst:\nkernel/drivers/net/xt_dummy.ko:\n',
    );
    const regular = networkDeviceChecks('allowlist', kernel, release);
    assert.deepEqual(ids(regular), [
      ['tun', 'fail'],
      ['dummy', 'fail'],
    ]);
    assert.match(regular[0].detail, /is not a character device/);
    assert.match(regular[0].remedy, /^modprobe tun \(the kernel has it module\)/);
    assert.equal(kernelModule('tun', kernel, release), 'module');
    assert.equal(kernelModule('dummy', kernel, release), null, 'xt_dummy is not dummy');

    fs.writeFileSync(
      path.join(kernel.libModules, release, 'modules.builtin'),
      'kernel/drivers/net/dummy.ko\n',
    );
    assert.equal(kernelModule('dummy', kernel, release), 'built in');
    fs.mkdirSync(path.join(kernel.modules, 'dummy'));
    assert.equal(kernelModule('dummy', kernel, release), 'loaded');

    const real = networkDeviceChecks('egress', { ...kernel, tun: '/dev/null' }, release);
    assert.deepEqual(ids(real), [
      ['tun', 'pass'],
      ['dummy', 'pass'],
    ]);
    assert.equal(real[1].detail, 'dummy loaded');
  } finally {
    cleanup();
  }
});

test('a doctor probe check that fails midway leaves no probe cgroup, even with a live process', async () => {
  const cg = new CgroupManager({ parent: `workbox-doctor-probe-${process.pid}` });
  let sleeper = null;
  try {
    cg.ensureParent();
    const name = `doctor-${process.pid}`;
    const probe = cg.childPath(name);
    await assert.rejects(
      withProbeCgroup(cg, name, (p) => {
        assert.equal(p, probe);
        sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
        cg.addProcess(p, sleeper.pid);
        assert.deepEqual(cg.procs(p), [sleeper.pid]);
        return fs.readFileSync(path.join(p, 'no-such-controller.file'));
      }),
      (e) => e.code === 'ENOENT',
    );
    assert.equal(fs.existsSync(probe), false, 'probe cgroup removed after the check threw');
    assert.deepEqual(cg.list(), []);
    if (sleeper.exitCode === null && sleeper.signalCode === null)
      await new Promise((resolve) => sleeper.once('exit', resolve));
    assert.equal(sleeper.signalCode, 'SIGKILL', 'the process that joined the probe was killed');
    assert.equal(
      await withProbeCgroup(cg, name, (p) => fs.existsSync(path.join(p, 'cgroup.kill'))),
      true,
    );
    assert.equal(fs.existsSync(probe), false, 'probe removed after a passing check too');
  } finally {
    if (sleeper && sleeper.exitCode === null && sleeper.signalCode === null)
      sleeper.kill('SIGKILL');
    for (const child of cg.list()) await cg.remove(cg.childPath(child)).catch(() => undefined);
    if (fs.existsSync(cg.parentPath)) fs.rmdirSync(cg.parentPath);
  }
});

test('the Node.js probe passes at the engines floor and fails below it with a remedy', () => {
  assert.equal(nodeCheck(process.versions.node).status, 'pass');
  assert.equal(nodeCheck(MIN_NODE).status, 'pass');
  const old = nodeCheck('20.18.1');
  assert.equal(old.status, 'fail');
  assert.equal(old.id, 'node');
  assert.match(old.remedy, /Install Node\.js 22\.13\.0 or newer/);
  assert.equal(nodeCheck(undefined).status, 'fail');
});

test('the proxy link probe only reads links: present, missing address and absent', async () => {
  const before = fs.readdirSync('/sys/class/net').sort();
  const lo = await proxyLinkCheck('lo', '127.0.0.1');
  assert.equal(lo.status, 'pass', lo.detail);
  assert.equal(lo.id, 'proxy-link');
  assert.equal(lo.detail, 'lo has 127.0.0.1/8');
  const noAddr = await proxyLinkCheck('lo', '198.18.0.250');
  assert.equal(noAddr.status, 'warn');
  assert.equal(noAddr.remedy, 'ip addr replace 198.18.0.250/32 dev lo');
  const name = `wbdoc${process.pid % 100000}`;
  const absent = await proxyLinkCheck(name, '198.18.0.1');
  assert.equal(absent.status, 'warn');
  assert.match(absent.detail, new RegExp(`${name} absent`));
  assert.match(
    absent.remedy,
    new RegExp(`ip link add ${name} type dummy && ip addr replace 198.18.0.1/32 dev ${name}`),
  );
  assert.deepEqual(fs.readdirSync('/sys/class/net').sort(), before, 'no link created');
  const host = await proxyLinkCheck();
  assert.equal(host.title, 'Proxy link workbox0 with 198.18.0.1');
  assert.equal(host.status === 'pass', fs.existsSync('/sys/class/net/workbox0'));
});
