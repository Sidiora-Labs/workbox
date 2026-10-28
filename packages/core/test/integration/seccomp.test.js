import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Manager } from '../../src/sandbox/manager.js';
import { Supervisor } from '../../src/sandbox/supervisor.js';
import { buildSeccompProgram, DENIED_SYSCALLS } from '../../src/host/seccomp.js';
import { testEngine } from '../helpers/engine.js';

const MiB = 1024 * 1024;
const EPERM = 1;
const X32_SYSCALL_BIT = 0x4000_0000;
const NR_GETPID = 39;
const NR_EPOLL_CREATE1 = 291;

/**
 * In-box probe: raw syscalls through perl's `syscall` builtin (perl-base is in every rootfs), one
 * `name=nr` argument each, all six arguments zero. Prints `name ret errno` per call.
 */
const SYSCALL_PROBE = `
for my $spec (@ARGV) {
  my ($name, $nr) = split /=/, $spec;
  $! = 0;
  my $ret = syscall($nr + 0, 0, 0, 0, 0, 0, 0);
  my $errno = $! + 0;
  print "$name $ret $errno\\n";
}
`;

const SOCKET_PROBE = `
use Socket;
socket(my $inet, AF_INET, SOCK_STREAM, 0) or die "inet: $!\\n";
socket(my $udp, AF_INET, SOCK_DGRAM, 0) or die "udp: $!\\n";
socketpair(my $left, my $right, AF_UNIX, SOCK_STREAM, PF_UNSPEC) or die "socketpair: $!\\n";
syswrite($left, "ping") == 4 or die "write: $!\\n";
sysread($right, my $got, 4) == 4 or die "read: $!\\n";
print "$got\\n";
`;

function managerFor(eng, extra = {}) {
  return new Manager({
    config: eng.config,
    store: eng.store,
    audit: eng.audit,
    cgroups: eng.cgroups,
    rootfs: eng.rootfs,
    runtime: eng.runtime,
    logger: eng.logger,
    enableSeccomp: true,
    ...extra,
  });
}

function parseProbe(stdout) {
  const out = {};
  for (const line of stdout.trim().split('\n')) {
    const [name, ret, errno] = line.split(' ');
    out[name] = { ret: Number(ret), errno: Number(errno) };
  }
  return out;
}

async function checkFilterReported(box, sup) {
  assert.equal(sup.checks.seccomp, 2, 'the runner self-check reports filter mode');
  const res = await box.exec(['cat', '/proc/self/status']);
  assert.equal(res.exitCode, 0, res.stderr);
  const field = (key) => res.stdout.match(new RegExp(`^${key}:\\s*(\\S+)$`, 'm'))?.[1];
  assert.equal(field('Seccomp'), '2', res.stdout);
  assert.ok(Number(field('Seccomp_filters')) >= 1, res.stdout);
  assert.equal(field('NoNewPrivs'), '1', res.stdout);
}

async function checkProgramPlacement(box, sup) {
  const file = path.join(sup.dirs.root, 'seccomp.bpf');
  assert.deepEqual(fs.readFileSync(file), buildSeccompProgram(), 'the launched program');
  assert.equal(fs.existsSync(path.join(sup.dirs.run, 'seccomp.bpf')), false);
  const inBox = await box.exec(['test', '-e', '/run/workbox/seccomp.bpf']);
  assert.equal(inBox.exitCode, 1, 'the program file is host-only');
}

async function checkDenied(box) {
  const entries = Object.entries(DENIED_SYSCALLS).map(([name, nr]) => `${name}=${nr}`);
  entries.push(`x32_getpid=${X32_SYSCALL_BIT + NR_GETPID}`, `getpid=${NR_GETPID}`);
  const res = await box.exec(['perl', '-e', SYSCALL_PROBE, ...entries]);
  assert.equal(res.exitCode, 0, res.stderr);
  const got = parseProbe(res.stdout);
  for (const name of Object.keys(DENIED_SYSCALLS))
    assert.deepEqual(got[name], { ret: -1, errno: EPERM }, `${name} answers EPERM`);
  // ptrace is denied outright (req 1.6 deviation): even PTRACE_TRACEME towards the parent fails.
  assert.deepEqual(got.ptrace, { ret: -1, errno: EPERM });
  // This kernel has no x32 ABI (ENOSYS unfiltered); the program's x32 branch answers EPERM first.
  assert.deepEqual(got.x32_getpid, { ret: -1, errno: EPERM }, 'x32 ABI syscall answers EPERM');
  assert.ok(got.getpid.ret > 0 && got.getpid.errno === 0, JSON.stringify(got.getpid));
}

async function checkToolchain(box) {
  const run = async (argv) => {
    const res = await box.exec(argv);
    assert.equal(res.exitCode, 0, `${argv.join(' ')}: ${res.stderr}`);
    return res.stdout;
  };
  assert.equal(await run(['sh', '-c', 'echo "$(echo forked)" | cat']), 'forked\n');
  assert.equal(
    await run([
      'sh',
      '-c',
      'touch /tmp/owned && chown 1000:1000 /tmp/owned && stat -c %u:%g /tmp/owned',
    ]),
    '1000:1000\n',
  );
  assert.equal(
    await run([
      'setpriv',
      '--reuid=65534',
      '--regid=65534',
      '--clear-groups',
      'sh',
      '-c',
      'id -u; id -g',
    ]),
    '65534\n65534\n',
  );
  assert.equal(await run(['perl', '-e', SOCKET_PROBE]), 'ping\n');
  const epoll = parseProbe(
    await run(['perl', '-e', SYSCALL_PROBE, `epoll_create1=${NR_EPOLL_CREATE1}`]),
  );
  assert.ok(epoll.epoll_create1.ret >= 0, JSON.stringify(epoll));
  assert.match(await run(['apt-get', 'check']), /Reading package lists/);
}

/**
 * Req 1.6 ac_6 in a real sandbox built by the real Manager: the launch passes the compiled program
 * to bwrap on an inherited fd, every denylisted syscall answers EPERM, an x32 call answers EPERM,
 * ordinary toolchain operations still work, and the kernel reports the filter.
 */
test(
  'seccomp: denylist answers EPERM in a real sandbox, toolchain unaffected, Seccomp: 2',
  { timeout: 300_000, skip: process.arch !== 'x64' && 'the program is x86_64 only' },
  async (t) => {
    const eng = await testEngine();
    const manager = managerFor(eng);
    let id = null;
    try {
      const sb = await manager.create({
        name: 'secbox',
        profile: { limits: { memoryBytes: 256 * MiB, pids: 128 } },
      });
      id = sb.id;
      assert.equal(sb.state, 'READY');
      assert.ok(
        !process.getActiveResourcesInfo().includes('ProcessWrap'),
        'the launcher child is detached with seccomp on',
      );
      const sup = manager.supervisor(id);
      const box = { exec: (argv) => manager.exec(id, { argv, timeoutMs: 60_000 }) };
      await t.test('ac_6: filter mode 2 in the runner checks and /proc/self/status', () =>
        checkFilterReported(box, sup),
      );
      await t.test('the program reaches bwrap from a host-only file', () =>
        checkProgramPlacement(box, sup),
      );
      await t.test('ac_6: every denylisted syscall and an x32 call answer EPERM', () =>
        checkDenied(box),
      );
      await t.test('ac_6: fork, exec, chown, setuid, socket, epoll and apt-get still work', () =>
        checkToolchain(box),
      );
    } finally {
      if (id) await manager.destroy(id).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    }
  },
);

/**
 * Negative: a launch that passes no filter fd boots unfiltered, the manager still demands mode 2,
 * and the self-checks quarantine the sandbox with its processes stopped.
 */
test(
  'a sandbox booted without the filter fd fails its checks and is quarantined',
  { timeout: 120_000, skip: process.arch !== 'x64' && 'the program is x86_64 only' },
  async () => {
    const eng = await testEngine();
    const made = [];
    const manager = managerFor(eng, {
      supervisorFactory: (deps) => {
        const sup = new Supervisor(deps);
        sup.seccompProgram = null;
        made.push(sup);
        return sup;
      },
    });
    try {
      await assert.rejects(manager.create({ name: 'nofilter' }), (e) => {
        assert.equal(e.code, 'E_QUARANTINED');
        assert.match(e.message, /seccomp mode 0 != 2/);
        return true;
      });
      assert.equal(made.length, 1);
      const sup = made[0];
      assert.equal(eng.store.getSandbox(sup.id).state, 'QUARANTINED');
      assert.equal(fs.existsSync(path.join(sup.dirs.root, 'seccomp.bpf')), false, 'no program');
      const procs = eng.cgroups.exists(sup.cgroupPath) ? eng.cgroups.procs(sup.cgroupPath) : [];
      assert.deepEqual(procs, [], 'quarantine stopped every process');
    } finally {
      for (const sup of made) await manager.destroy(sup.id).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    }
  },
);
