import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  sandboxDirs,
  prepareDirs,
  writeBootFile,
  hashNonce,
  bwrapArgs,
  launchEnv,
  spawnSandbox,
  readLaunchLog,
  rotateLaunchLog,
  removeDirs,
  hostMountsFor,
  pidAlive,
  CAPABILITIES,
  CAPABILITY_MASK,
  LAUNCH_SCRIPT,
  RUNTIME_MOUNT,
  RUN_MOUNT,
  SANDBOX_PATH,
  LAUNCH_LOG_MAX_BYTES,
} from '../../../src/host/launch.js';
import { tmpDir } from '../../helpers/tmp.js';

const BASE = 200000;

test('sandboxDirs, prepareDirs and the generated /etc files', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dirs = sandboxDirs(dir, 'SBX1');
    assert.equal(dirs.root, path.join(dir, 'SBX1'));
    assert.equal(dirs.log, path.join(dir, 'SBX1', 'launch.log'));
    prepareDirs(dirs, {
      uidBase: BASE,
      hostname: 'box',
      nameservers: ['10.0.2.3'],
      address: '10.0.2.100',
    });
    for (const d of [
      dirs.upper,
      dirs.work,
      dirs.merged,
      dirs.run,
      path.join(dirs.run, 'outbox'),
      path.join(dirs.run, 'inbox'),
    ]) {
      const st = fs.statSync(d);
      assert.equal(st.uid, BASE, d);
      assert.equal(st.mode & 0o777, 0o755, d);
    }
    assert.equal(fs.statSync(dirs.root).mode & 0o777, 0o711);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
    assert.equal(
      fs.readFileSync(path.join(dirs.etc, 'resolv.conf'), 'utf8'),
      'nameserver 10.0.2.3\noptions ndots:0\n',
    );
    assert.match(
      fs.readFileSync(path.join(dirs.etc, 'hosts'), 'utf8'),
      /^127\.0\.0\.1\tlocalhost\n::1\tlocalhost.*\n10\.0\.2\.100\tbox\n$/,
    );
    assert.equal(fs.readFileSync(path.join(dirs.etc, 'hostname'), 'utf8'), 'box\n');
    prepareDirs(dirs, { uidBase: BASE, hostname: 'box', nameservers: [] });
    assert.equal(
      fs.readFileSync(path.join(dirs.etc, 'resolv.conf'), 'utf8'),
      '# no network\noptions ndots:0\n',
    );
    assert.match(fs.readFileSync(path.join(dirs.etc, 'hosts'), 'utf8'), /127\.0\.1\.1\tbox\n$/);
    assert.deepEqual(hostMountsFor(dirs), []);
    removeDirs(dirs);
    assert.equal(fs.existsSync(dirs.root), false);
    removeDirs(dirs);
  } finally {
    cleanup();
  }
});

test('writeBootFile issues a fresh single-use identity owned by the sandbox root', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dirs = sandboxDirs(dir, 'SBX2');
    prepareDirs(dirs, { uidBase: BASE, hostname: 'h', nameservers: [] });
    const a = writeBootFile(dirs, { sandboxId: 'SBX2', uidBase: BASE, runtimeVersion: 'v1' });
    const file = path.join(dirs.run, 'boot.json');
    const st = fs.statSync(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(st.uid, BASE);
    const body = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(body.bootId, a.bootId);
    assert.equal(body.nonce, a.nonce);
    assert.equal(body.sandboxId, 'SBX2');
    assert.equal(body.protocol, 1);
    assert.equal(body.runtime, 'v1');
    assert.equal(body.socket, `${RUN_MOUNT}/runner.sock`);
    assert.equal(a.nonce.length, 64);
    assert.equal(a.nonceHash, createHash('sha256').update(a.nonce).digest('hex'));
    assert.equal(hashNonce(a.nonce), a.nonceHash);
    const b = writeBootFile(dirs, { sandboxId: 'SBX2', uidBase: BASE, runtimeVersion: 'v1' });
    assert.notEqual(a.bootId, b.bootId);
    assert.notEqual(a.nonce, b.nonce);
  } finally {
    cleanup();
  }
});

test('bwrapArgs and launchEnv encode the isolation profile', () => {
  const dirs = sandboxDirs('/sb', 'ID');
  const spec = {
    sandboxId: 'ID',
    hostname: 'wb-id',
    rootfsDir: '/rootfs/minimal',
    runtimeDir: '/runtime/v',
    dirs,
    cgroupPath: '/sys/fs/cgroup/workbox/ID',
    uid: { base: BASE, count: 65536 },
    env: { EXTRA: '1' },
  };
  const args = bwrapArgs(spec);
  for (const flag of [
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    '--new-session',
    '--clearenv',
  ])
    assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes('--die-with-parent'), 'sandboxes outlive the daemon');
  assert.ok(!args.includes('--unshare-user'), 'the user namespace comes from unshare, not bwrap');
  const joined = args.join(' ');
  assert.match(joined, /--hostname wb-id/);
  assert.match(
    joined,
    new RegExp(
      `--bind /sb/ID/merged / --ro-bind /runtime/v ${RUNTIME_MOUNT} --bind /sb/ID/run ${RUN_MOUNT}`,
    ),
  );
  assert.match(joined, /--ro-bind \/sb\/ID\/etc\/resolv.conf \/etc\/resolv.conf/);
  assert.match(
    joined,
    /--proc \/proc --dev \/dev --perms 1777 --tmpfs \/tmp --perms 1777 --tmpfs \/dev\/shm --chdir \/workspace/,
  );
  assert.match(joined, new RegExp(`--setenv PATH ${SANDBOX_PATH}`));
  assert.match(joined, /--setenv HOME \/root/);
  assert.match(joined, /--setenv WORKBOX_SANDBOX ID/);
  assert.match(joined, /--setenv EXTRA 1/);
  assert.ok(args.indexOf('--clearenv') < args.indexOf('--setenv'), 'clearenv precedes setenv');
  assert.ok(args.includes('--cap-drop') && args[args.indexOf('--cap-drop') + 1] === 'ALL');
  assert.equal(args.filter((a) => a === '--cap-add').length, CAPABILITIES.length);
  assert.equal(CAPABILITIES.length, 14);
  assert.equal(CAPABILITY_MASK, '00000000a80425fb');
  assert.ok(!args.includes('--seccomp'));
  assert.deepEqual(args.slice(-2), ['--', `${RUNTIME_MOUNT}/bin/init.sh`]);
  const withSeccomp = bwrapArgs({ ...spec, seccompFd: 7 });
  assert.ok(
    withSeccomp.includes('--seccomp') && withSeccomp[withSeccomp.indexOf('--seccomp') + 1] === '7',
  );
  const env = launchEnv(spec);
  assert.deepEqual(Object.keys(env).sort(), [
    'PATH',
    'WB_CGROUP',
    'WB_LOWER',
    'WB_MAP',
    'WB_MERGED',
    'WB_UPPER',
    'WB_WORK',
  ]);
  assert.equal(env.WB_MAP, `${BASE},0,65536`);
  assert.equal(env.WB_CGROUP, '/sys/fs/cgroup/workbox/ID');
  assert.ok(fs.existsSync(LAUNCH_SCRIPT));
  assert.equal(fs.statSync(LAUNCH_SCRIPT).mode & 0o111, 0o111);
});

test('spawnSandbox runs the real launch script and a bad cgroup path lands in launch.log', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dirs = sandboxDirs(dir, 'SBX3');
    prepareDirs(dirs, { uidBase: BASE, hostname: 'h', nameservers: [] });
    assert.equal(readLaunchLog(dirs), '');
    const spec = {
      sandboxId: 'SBX3',
      hostname: 'h',
      rootfsDir: '/nonexistent',
      runtimeDir: '/nonexistent',
      dirs,
      cgroupPath: path.join(dir, 'no-such-cgroup'),
      uid: { base: BASE, count: 65536 },
    };
    const { pid, child } = spawnSandbox(spec);
    assert.ok(pid > 0);
    assert.equal(pidAlive(pid), true);
    child.ref();
    await new Promise((resolve) => child.once('exit', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pidAlive(pid), false);
    assert.equal(pidAlive(1), true);
    const log = readLaunchLog(dirs);
    assert.match(log, /no-such-cgroup\/cgroup.procs/);
    assert.equal(fs.statSync(dirs.log).mode & 0o777, 0o600);
    fs.writeFileSync(dirs.log, 'x'.repeat(100));
    assert.equal(readLaunchLog(dirs, 10).length, 10);
  } finally {
    cleanup();
  }
});

test('removeDirs deletes only the sandbox root: links out of it are unlinked, never followed', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const sandboxes = path.join(dir, 'sandboxes');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'host data');
    const dirs = sandboxDirs(sandboxes, 'SBX5');
    const sibling = sandboxDirs(sandboxes, 'SBX6');
    prepareDirs(dirs, { uidBase: BASE, hostname: 'a', nameservers: [] });
    prepareDirs(sibling, { uidBase: BASE, hostname: 'b', nameservers: [] });
    fs.writeFileSync(path.join(sibling.upper, 'mine'), 'sibling data');
    fs.symlinkSync(outside, path.join(dirs.upper, 'to-host'));
    fs.symlinkSync(sibling.root, path.join(dirs.upper, 'to-sibling'));
    fs.symlinkSync('/', path.join(dirs.run, 'slash'));
    removeDirs(dirs);
    assert.equal(fs.existsSync(dirs.root), false);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'host data');
    assert.equal(fs.readFileSync(path.join(sibling.upper, 'mine'), 'utf8'), 'sibling data');
    assert.ok(fs.existsSync(sandboxes), 'the sandboxes directory itself stays');

    fs.symlinkSync(outside, dirs.root);
    removeDirs(dirs);
    assert.equal(fs.existsSync(dirs.root), false, 'a sandbox root that is a link is unlinked');
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'host data');
    assert.ok(fs.existsSync(sibling.root));
  } finally {
    cleanup();
  }
});

test('launch.log stays under its cap across many launches and a live O_APPEND writer', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dirs = sandboxDirs(dir, 'SBX7');
    prepareDirs(dirs, { uidBase: BASE, hostname: 'h', nameservers: [] });
    assert.equal(LAUNCH_LOG_MAX_BYTES, 1024 * 1024);
    assert.equal(rotateLaunchLog(dirs), false, 'no log yet');
    fs.writeFileSync(dirs.log, `${'old line\n'.repeat(120_000)}tail-marker\n`, { mode: 0o600 });
    assert.ok(fs.statSync(dirs.log).size > LAUNCH_LOG_MAX_BYTES);
    const spec = {
      sandboxId: 'SBX7',
      hostname: 'h',
      rootfsDir: '/nonexistent',
      runtimeDir: '/nonexistent',
      dirs,
      cgroupPath: path.join(dir, 'no-such-cgroup'),
      uid: { base: BASE, count: 65536 },
    };
    for (let i = 0; i < 5; i++) {
      const { child } = spawnSandbox(spec);
      child.ref();
      await new Promise((resolve) => child.once('exit', resolve));
      assert.ok(fs.statSync(dirs.log).size <= LAUNCH_LOG_MAX_BYTES, `launch ${i}`);
      assert.ok(fs.statSync(`${dirs.log}.1`).size <= LAUNCH_LOG_MAX_BYTES, `launch ${i}`);
    }
    const rotated = fs.readFileSync(`${dirs.log}.1`, 'utf8');
    assert.ok(rotated.endsWith('tail-marker\n'), 'launch.log.1 keeps the newest bytes');
    assert.equal(fs.statSync(`${dirs.log}.1`).mode & 0o777, 0o600);
    assert.equal(fs.readdirSync(dirs.root).includes('launch.log.1.tmp'), false);
    const current = readLaunchLog(dirs);
    assert.equal(current.match(/no-such-cgroup\/cgroup.procs/g).length, 5, current);

    const cap = 64 * 1024;
    const chunk = Buffer.alloc(10_000, 'a');
    const fd = fs.openSync(dirs.log, 'a', 0o600);
    try {
      let rotations = 0;
      for (let i = 0; i < 200; i++) {
        fs.writeSync(fd, chunk);
        if (rotateLaunchLog(dirs, cap)) rotations++;
        assert.ok(fs.statSync(dirs.log).size <= cap, `append ${i}`);
        if (rotations > 0) assert.ok(fs.statSync(`${dirs.log}.1`).size <= cap, `append ${i}`);
      }
      assert.ok(rotations >= 25, `rotated ${rotations} times over 2 MB of appends`);
      fs.writeSync(fd, 'after rotation\n');
      assert.ok(readLaunchLog(dirs).endsWith('after rotation\n'), 'the live writer keeps going');
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    cleanup();
  }
});

test('readLaunchLog reads only a byte-capped tail and never splits a character', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const dirs = sandboxDirs(dir, 'SBX8');
    prepareDirs(dirs, { uidBase: BASE, hostname: 'h', nameservers: [] });
    fs.writeFileSync(dirs.log, `${'x'.repeat(4 * 1024 * 1024)}end\n`);
    assert.equal(readLaunchLog(dirs).length, 16 * 1024);
    assert.ok(readLaunchLog(dirs).endsWith('xend\n'));
    fs.writeFileSync(dirs.log, 'ab\u00e9\u20ac!');
    assert.equal(readLaunchLog(dirs, 3), '!', 'a cut euro sign is dropped, not mangled');
    assert.equal(readLaunchLog(dirs, 4), '\u20ac!');
    assert.equal(readLaunchLog(dirs, 5), '\u20ac!', 'a cut e-acute is dropped');
    assert.equal(readLaunchLog(dirs, 6), '\u00e9\u20ac!');
    assert.equal(readLaunchLog(dirs, 1000), 'ab\u00e9\u20ac!');
  } finally {
    cleanup();
  }
});
