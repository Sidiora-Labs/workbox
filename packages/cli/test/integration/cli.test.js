import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Audit, CgroupManager } from '@workbox/core';
import { ensureAssets, ASSETS_ROOT } from '../../../core/test/helpers/engine.js';
import { tmpDir } from '../../../core/test/helpers/tmp.js';
import { openLocalEngine } from '../../src/local.js';

const MAIN = fileURLToPath(new URL('../../src/main.js', import.meta.url));

const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * A fresh Workbox root for the CLI's local engine. The rootfs and runtime directories link to the
 * shared test assets so no test rebuilds them; store, audit, sandboxes and the cgroup parent are
 * private to the root and removed by `cleanup`, live sandboxes included.
 * @param {string} tag
 */
async function cliRoot(tag) {
  await ensureAssets();
  const t = tmpDir(`workbox-cli-${tag}-`);
  fs.chmodSync(t.dir, 0o711);
  fs.symlinkSync(path.join(ASSETS_ROOT, 'rootfs'), path.join(t.dir, 'rootfs'));
  fs.symlinkSync(path.join(ASSETS_ROOT, 'runtime'), path.join(t.dir, 'runtime'));
  const parent = `workbox-cli-${process.pid}-${tag}`;
  const env = { ...process.env, WORKBOX_ROOT: t.dir, WORKBOX_CGROUP_PARENT: parent };
  env.WORKBOX_NETWORK_MODE = 'none';
  delete env.WORKBOX_CONFIG;
  const cgroups = new CgroupManager({ root: '/sys/fs/cgroup', parent });
  const cleanup = async () => {
    if (fs.existsSync(cgroups.parentPath)) {
      for (const name of cgroups.list())
        await cgroups.remove(cgroups.childPath(name), { timeoutMs: 10_000 }).catch(() => undefined);
      fs.rmdirSync(cgroups.parentPath);
    }
    t.cleanup();
  };
  return { dir: t.dir, env, cgroups, cleanup };
}

/**
 * Spawn the real `workbox` binary. Resolves when it exits; `child` is exposed for killing it.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} args
 */
function spawnCli(env, args) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code, signal, stdout, stderr, json });
    });
  });
  return { child, done };
}

const cli = (env, ...args) => spawnCli(env, args).done;

function cmdlines(cgroups, cgroupPath) {
  return cgroups.procs(cgroupPath).map((pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
    } catch {
      return '';
    }
  });
}

test('operator CLI: assets, create, kill the manager, rediscover with sessions, drain, destroy', async () => {
  const root = await cliRoot('restart');
  const { env, cgroups } = root;
  try {
    const doctor = await cli(env, 'doctor', '--json');
    assert.equal(doctor.code, 0, doctor.stderr);
    assert.equal(doctor.json.ok, true, JSON.stringify(doctor.json.checks));
    assert.ok(doctor.json.checks.some((c) => c.id === 'cgroup' && c.status === 'pass'));

    const rootfs = await cli(env, 'rootfs', 'list');
    assert.equal(rootfs.code, 0, rootfs.stderr);
    assert.deepEqual(
      rootfs.json.rootfs.map((r) => r.name),
      ['minimal'],
    );
    const rebuild = await cli(env, 'rootfs', 'build', 'minimal');
    assert.equal(rebuild.code, 1);
    assert.match(rebuild.stderr, /rootfs minimal already exists \(E_CONFLICT\)/);
    const runtimes = await cli(env, 'runtime', 'list');
    assert.equal(runtimes.code, 0, runtimes.stderr);
    assert.ok(runtimes.json.runtimes.length >= 1);

    const fresh = tmpDir('workbox-cli-runtime-');
    try {
      const install = await cli({ ...env, WORKBOX_ROOT: fresh.dir }, 'runtime', 'install');
      assert.equal(install.code, 0, install.stderr);
      assert.match(install.json.version, /^22\.\d+\.\d+-[0-9a-f]{12}$/);
      const listed = await cli({ ...env, WORKBOX_ROOT: fresh.dir }, 'runtime', 'list');
      assert.deepEqual(
        listed.json.runtimes.map((r) => r.version),
        [install.json.version],
      );
    } finally {
      fresh.cleanup();
    }

    const created = await cli(
      env,
      'sandbox',
      'create',
      '--name',
      'keeper',
      '--idempotency-key',
      'k-keeper',
    );
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.state, 'READY');
    assert.equal(created.json.health, 'HEALTHY');
    const id = created.json.id;
    const again = await cli(
      env,
      'sandbox',
      'create',
      '--name',
      'keeper',
      '--idempotency-key',
      'k-keeper',
    );
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.json.id, id, 'the same key and profile return the same sandbox');
    const clash = await cli(
      env,
      'sandbox',
      'create',
      '--name',
      'keeper',
      '--idempotency-key',
      'k-keeper',
      '--network',
      'egress',
    );
    assert.notEqual(clash.code, 0);
    assert.match(clash.stderr, /different sandbox profile \(E_CONFLICT\)/);
    const listed = await cli(env, 'sandbox', 'ls');
    assert.deepEqual(
      listed.json.items.map((s) => s.id),
      [id],
    );

    const shell = await cli(env, 'sandbox', 'shell', id);
    assert.equal(shell.code, 0, shell.stderr);
    const shellSession = shell.json.sessionId;
    assert.ok(shellSession);

    const cgroupPath = created.json.cgroup;
    const holder = spawnCli(env, ['sandbox', 'exec', id, '--', 'sh', '-c', 'sleep 300']);
    await until(() => cmdlines(cgroups, cgroupPath).includes('sleep 300'));
    holder.child.kill('SIGKILL');
    const killed = await holder.done;
    assert.equal(killed.signal, 'SIGKILL');
    assert.ok(cgroups.procs(cgroupPath).length > 0, 'the sandbox outlived its manager');

    const inspect = await cli(env, 'sandbox', 'inspect', id);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal(inspect.json.desired, 'READY');
    assert.equal(inspect.json.health, 'HEALTHY');
    assert.equal(inspect.json.sessionsFrom, 'runner');
    const byId = new Map(inspect.json.sessions.map((s) => [s.sessionId, s]));
    assert.ok(byId.has(shellSession), 'the shell session survived the restart');
    const sleeper = inspect.json.sessions.find((s) => s.argv.join(' ') === 'sh -c sleep 300');
    assert.ok(sleeper, 'the killed manager’s exec session survived the restart');
    assert.equal(sleeper.exited, null);

    const after = await cli(env, 'sandbox', 'exec', id, '--', 'sh', '-c', 'echo after-restart');
    assert.equal(after.code, 0, after.stderr);
    assert.equal(after.json.stdout, 'after-restart\n');

    const drained = await cli(env, 'sandbox', 'drain', id);
    assert.equal(drained.code, 0, drained.stderr);
    assert.equal(drained.json.state, 'DRAINING');
    const illegal = await cli(env, 'sandbox', 'drain', id);
    assert.notEqual(illegal.code, 0);
    assert.match(illegal.stderr, /cannot move sandbox from DRAINING to DRAINING \(E_STATE\)/);

    const events = await cli(env, 'sandbox', 'events', id);
    assert.equal(events.code, 0, events.stderr);
    assert.deepEqual(
      events.json.transitions.map((t) => t.to),
      ['REQUESTED', 'PROVISIONING', 'BOOTSTRAPPING', 'READY', 'DRAINING'],
    );
    for (const t of events.json.transitions) {
      assert.ok(t.at > 0, 'every transition carries a timestamp');
      assert.ok(t.reason, 'every transition carries a reason');
    }

    const removed = await cli(env, 'sandbox', 'rm', id);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(removed.json.state, 'DELETED');
    assert.equal(removed.json.health, 'ABSENT');
    assert.equal(fs.existsSync(cgroupPath), false, 'the cgroup directory is gone');
    assert.equal(fs.existsSync(path.join(root.dir, 'sandboxes', id)), false);
    const gone = await cli(env, 'sandbox', 'inspect', id);
    assert.equal(gone.json.desired, 'DELETED');
    const missing = await cli(env, 'sandbox', 'inspect', 'nope');
    assert.equal(missing.code, 3);

    const audit = await cli(env, 'audit', 'verify');
    assert.equal(audit.code, 0, audit.stderr);
    assert.equal(audit.json.ok, true, 'the audit chain verifies across every manager process');
  } finally {
    await root.cleanup();
  }
});

test('fleet: two live sandboxes isolated, a killed one observed ABSENT, nonce replay quarantined, destroy failure stays DELETING', async () => {
  const root = await cliRoot('fleet');
  let eng = await openLocalEngine({ env: root.env, reconcile: true });
  const restart = async () => {
    eng.close();
    eng = await openLocalEngine({ env: root.env });
    return eng.manager.reconcile();
  };
  try {
    const fanned = [];
    eng.manager.on('event', (e) => fanned.push(e));
    const a = await eng.manager.create({ name: 'alpha' });
    const b = await eng.manager.create({ name: 'beta' });
    assert.notEqual(a.cgroup, b.cgroup);
    const dirA = path.join(eng.config.paths.sandboxes, a.id);
    const dirB = path.join(eng.config.paths.sandboxes, b.id);
    const wrote = await eng.manager.exec(a.id, {
      argv: ['sh', '-c', 'echo alpha > /workspace/owner && cat /workspace/owner'],
    });
    assert.equal(wrote.stdout, 'alpha\n');
    assert.ok(fs.existsSync(path.join(dirA, 'upper', 'workspace', 'owner')));
    assert.equal(fs.existsSync(path.join(dirB, 'upper', 'workspace', 'owner')), false);
    const peek = await eng.manager.exec(b.id, { argv: ['cat', '/workspace/owner'] });
    assert.notEqual(peek.exitCode, 0, 'beta cannot see alpha’s upper layer');
    for (const sb of [a, b])
      assert.ok(
        fanned.some((e) => e.sandboxId === sb.id && e.method === 'session.started'),
        `session events of ${sb.name} fan out from the manager`,
      );

    eng.cgroups.kill(a.cgroup);
    await eng.cgroups.waitEmpty(a.cgroup, { timeoutMs: 10_000 });
    const still = await eng.manager.exec(b.id, { argv: ['echo', 'beta-alive'] });
    assert.equal(still.stdout, 'beta-alive\n');
    assert.equal(eng.manager.supervisor(b.id).observeHealth(), 'HEALTHY');
    assert.equal(eng.manager.get(b.id).state, 'READY');

    const rec = await restart();
    assert.deepEqual(rec.absent, [a.id]);
    assert.deepEqual(rec.attached, [b.id]);
    const absent = eng.manager.get(a.id);
    assert.equal(absent.health, 'ABSENT');
    assert.equal(absent.state, 'READY', 'desired state is untouched by observation');
    assert.equal(eng.cgroups.procs(a.cgroup).length, 0, 'an ABSENT sandbox is never relaunched');
    assert.equal(eng.manager.transitions(a.id).filter((t) => t.to === 'PROVISIONING').length, 1);

    const stolen = new Promise((resolve) => {
      eng.manager.once('sandbox', (row) =>
        setImmediate(() =>
          resolve(
            fs.readFileSync(path.join(eng.config.paths.sandboxes, row.id, 'run', 'boot.json')),
          ),
        ),
      );
    });
    const c = await eng.manager.create({ name: 'gamma' });
    const bootFile = await stolen;
    assert.equal(JSON.parse(bootFile).bootId, c.bootId);
    const runDir = path.join(eng.config.paths.sandboxes, c.id, 'run');
    const replay = path.join(runDir, 'replay.json');
    fs.writeFileSync(replay, bootFile, { mode: 0o600 });
    fs.chownSync(replay, eng.config.uid.base, eng.config.uid.base);
    const socket = path.join(runDir, 'runner.sock');
    const original = fs.statSync(socket).ino;
    await eng.manager.request(c.id, 'session.start', {
      argv: ['/opt/workbox/bin/init.sh', '--boot', '/run/workbox/replay.json'],
      name: 'impostor',
    });
    await until(() => fs.existsSync(socket) && fs.statSync(socket).ino !== original);
    const rec2 = await restart();
    assert.deepEqual(rec2.quarantined, [c.id]);
    const q = eng.manager.get(c.id);
    assert.equal(q.state, 'QUARANTINED');
    assert.match(q.stateReason, /boot nonce already/);
    assert.equal(eng.cgroups.procs(c.cgroup).length, 0, 'quarantine stopped the sandbox');
    assert.equal(eng.manager.get(b.id).state, 'READY');

    const pin = path.join(eng.config.paths.sandboxes, c.id, 'pin');
    fs.mkdirSync(pin);
    execFileSync('mount', ['-t', 'tmpfs', 'workbox-pin', pin]);
    try {
      await assert.rejects(eng.manager.destroy(c.id));
      const stuck = eng.manager.get(c.id);
      assert.equal(stuck.state, 'DELETING');
      assert.match(stuck.stateReason, /^destroy incomplete: /);
    } finally {
      execFileSync('umount', [pin]);
    }

    for (const sb of [a, b, c]) {
      const done = await eng.manager.destroy(sb.id);
      assert.equal(done.state, 'DELETED');
      assert.equal(fs.existsSync(sb.cgroup), false);
      assert.equal(fs.existsSync(path.join(eng.config.paths.sandboxes, sb.id)), false);
    }
    assert.deepEqual(
      eng.manager.transitions(c.id).map((t) => t.to),
      ['REQUESTED', 'PROVISIONING', 'BOOTSTRAPPING', 'READY', 'QUARANTINED', 'DELETING', 'DELETED'],
    );
    assert.equal(Audit.verify(eng.config.paths.audit).ok, true);
  } finally {
    eng.close();
    await root.cleanup();
  }
});
