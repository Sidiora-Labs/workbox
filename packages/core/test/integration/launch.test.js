import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Supervisor } from '../../src/sandbox/supervisor.js';
import {
  hostMountsFor,
  sandboxDirs,
  CAPABILITY_MASK,
  LAUNCH_LOG_MAX_BYTES,
} from '../../src/host/launch.js';
import { digestTree } from '../../src/host/rootfs.js';
import { hashNonce } from '../../src/host/launch.js';
import { testEngine } from '../helpers/engine.js';

/**
 * A real sandbox: launch chain, bwrap, init.sh, runner, handshake, self-checks, destroy.
 */
test('launch -> READY with the exact isolation profile, then destroy leaves nothing behind', async () => {
  const eng = await testEngine();
  const rootfsDir = eng.rootfs.dir('minimal');
  const before = digestTree(rootfsDir, eng.config.uid.base);
  try {
    const row = eng.store.createSandbox({
      name: 'alpha',
      rootfs: 'minimal',
      runtime: 'current',
      profile: { limits: { memoryBytes: 256 * 1024 * 1024, pids: 128 }, network: { mode: 'none' } },
    });
    const sup = new Supervisor({ ...eng, sandbox: row });
    const states = [];
    sup.on('state', (s) => states.push(s.state));
    const t0 = Date.now();
    const ready = await sup.launch();
    const bootMs = Date.now() - t0;
    assert.equal(ready.state, 'READY');
    assert.equal(ready.health, 'HEALTHY');
    assert.deepEqual(states, ['PROVISIONING', 'BOOTSTRAPPING', 'READY']);
    assert.ok(bootMs < 15_000, `boot took ${bootMs} ms`);

    const c = sup.checks;
    assert.equal(c.ok, true, JSON.stringify(c.problems));
    assert.equal(c.pid, 2);
    assert.equal(c.uid, 0);
    assert.equal(c.hostname, 'alpha');
    assert.equal(c.caps.eff, CAPABILITY_MASK);
    assert.equal(c.caps.bnd, CAPABILITY_MASK);
    assert.equal(c.noNewPrivs, true);
    assert.equal(c.mountDenied, true);
    assert.deepEqual(c.uidMap, [
      { inner: 0, outer: eng.config.uid.base, count: eng.config.uid.count },
    ]);
    assert.deepEqual(c.gidMap, [
      { inner: 0, outer: eng.config.uid.base, count: eng.config.uid.count },
    ]);
    assert.equal(c.mounts.root, 'overlay');
    assert.ok(c.mounts.runtime.includes('ro'));
    assert.equal(sup.hello.sandboxId, row.id);

    const dirs = sandboxDirs(eng.config.paths.sandboxes, row.id);
    assert.equal(
      fs.existsSync(path.join(dirs.run, 'boot.json')),
      false,
      'runner removed the boot file',
    );
    assert.ok(fs.existsSync(path.join(dirs.run, 'runner.sock')));
    const procs = eng.cgroups.procs(sup.cgroupPath);
    assert.ok(procs.length >= 2, `bwrap and the runner: ${procs}`);
    assert.ok(procs.includes(sup.sandbox.pid), 'bwrap pid is in the cgroup');
    assert.equal(fs.readFileSync(`/proc/${sup.sandbox.pid}/comm`, 'utf8').trim(), 'bwrap');
    assert.deepEqual(eng.cgroups.readLimits(sup.cgroupPath), {
      memoryBytes: 256 * 1024 * 1024,
      swapBytes: 0,
      cpuMillis: eng.config.limits.cpuMillis,
      pids: 128,
    });
    assert.deepEqual(hostMountsFor(dirs), [], 'no sandbox mount is visible on the host');

    const boot = eng.store.getBoot(sup.sandbox.bootId);
    assert.ok(boot.nonceConsumedAt > 0);
    assert.equal(boot.runnerVersion, sup.hello.runnerVersion);
    assert.equal(eng.store.consumeNonce(boot.bootId, boot.nonceHash), 'already');
    const status = await sup.request('runner.status', {});
    assert.equal(status.phase, 'ready');
    assert.equal(status.network.mode, 'none');
    assert.equal(sup.observeHealth(), 'HEALTHY');
    const tmp = await sup.exec({
      argv: [
        'sh',
        '-c',
        'stat -c %a /tmp /dev/shm && setpriv --reuid 65534 --regid 65534 --clear-groups touch /tmp/nobody',
      ],
      timeoutMs: 30_000,
    });
    assert.equal(tmp.exitCode, 0, tmp.stderr);
    assert.equal(tmp.stdout, '1777\n1777\n', 'shared tmp dirs are sticky and world-writable');
    const written = fs.readdirSync(dirs.upper);
    assert.ok(written.length > 0, `the runner wrote into the upper layer: ${written}`);
    assert.equal(fs.statSync(path.join(dirs.upper, written[0])).uid >= eng.config.uid.base, true);

    const destroyed = await sup.destroy();
    assert.equal(destroyed.state, 'DELETED');
    assert.equal(destroyed.health, 'ABSENT');
    assert.ok(destroyed.deletedAt > 0);
    assert.equal(fs.existsSync(dirs.root), false);
    assert.equal(fs.existsSync(sup.cgroupPath), false);
    assert.equal(eng.store.getBoot(boot.bootId).endedAt > 0, true);
    assert.deepEqual(hostMountsFor(dirs), []);
    assert.deepEqual(
      eng.store.listTransitions(row.id).map((t) => t.to),
      ['REQUESTED', 'PROVISIONING', 'BOOTSTRAPPING', 'READY', 'DELETING', 'DELETED'],
    );
    assert.equal(await sup.destroy().then((s) => s.state), 'DELETED');
    const after = digestTree(rootfsDir, eng.config.uid.base);
    assert.equal(
      after.digest,
      before.digest,
      'the shared rootfs is byte-identical after the sandbox ran',
    );
  } finally {
    await eng.cleanup();
  }
});

test('a second runner presenting a consumed nonce is quarantined; a broken runtime quarantines with its log', async () => {
  const eng = await testEngine();
  try {
    const row = eng.store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const sup = new Supervisor({ ...eng, sandbox: row });
    await sup.launch();
    const bootId = sup.sandbox.bootId;
    const boot = eng.store.getBoot(bootId);
    assert.equal(eng.store.consumeNonce(bootId, boot.nonceHash), 'already');
    assert.equal(eng.store.consumeNonce(bootId, hashNonce('forged')), 'mismatch');
    sup.close();
    const clone = new Supervisor({ ...eng, sandbox: eng.store.getSandbox(row.id) });
    eng.store.db.prepare(`UPDATE boots SET nonce_consumed_at = NULL WHERE boot_id = ?`).run(bootId);
    const health = await clone.attach();
    assert.equal(health, 'HEALTHY');
    assert.equal(
      eng.store.getBoot(bootId).nonceConsumedAt,
      null,
      'a reattached runner no longer holds the nonce, so nothing is consumed',
    );
    clone.close();
    const sup2 = new Supervisor({ ...eng, sandbox: eng.store.getSandbox(row.id) });
    await sup2.destroy();

    const broken = eng.store.createSandbox({
      rootfs: 'minimal',
      runtime: 'current',
      profile: { limits: { pids: 3 } },
    });
    const sup3 = new Supervisor({ ...eng, sandbox: broken });
    await assert.rejects(sup3.launch(), (e) => ['E_UNAVAILABLE', 'E_TIMEOUT'].includes(e.code));
    const q = eng.store.getSandbox(broken.id);
    assert.equal(q.state, 'QUARANTINED');
    assert.match(q.stateReason, /launch failed/);
    assert.equal(q.health, 'SUSPECT');
    const dirs = sandboxDirs(eng.config.paths.sandboxes, broken.id);
    assert.ok(fs.existsSync(dirs.log), 'launch.log kept for inspection');
    assert.equal(eng.cgroups.procs(sup3.cgroupPath).length, 0, 'quarantine stopped the processes');
    const d = await sup3.destroy();
    assert.equal(d.state, 'DELETED');
    assert.equal(fs.existsSync(dirs.root), false);
  } finally {
    await eng.cleanup();
  }
});

test('destroying a real sandbox removes only its own directories, never what its links point at', async () => {
  const eng = await testEngine();
  const sups = [];
  try {
    const outside = path.join(eng.dir, 'host-data');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'host bytes');
    const launch = async (name) => {
      const row = eng.store.createSandbox({
        name,
        rootfs: 'minimal',
        runtime: 'current',
        profile: {},
      });
      const sup = new Supervisor({ ...eng, sandbox: row });
      sups.push(sup);
      await sup.launch();
      return sup;
    };
    const victim = await launch('victim');
    const sibling = await launch('sibling');
    const siblingDirs = sandboxDirs(eng.config.paths.sandboxes, sibling.id);
    const victimDirs = sandboxDirs(eng.config.paths.sandboxes, victim.id);
    const made = await victim.exec({
      argv: [
        'sh',
        '-c',
        `ln -s ${siblingDirs.root} /workspace/to-sibling && ln -s ${outside} /workspace/to-host && ln -s / /workspace/to-slash && echo agent > /workspace/own.txt`,
      ],
      timeoutMs: 30_000,
    });
    assert.equal(made.exitCode, 0, made.stderr);
    assert.ok(
      fs.lstatSync(path.join(victimDirs.upper, 'workspace', 'to-sibling')).isSymbolicLink(),
      'the agent link landed in the upper layer on the host',
    );
    fs.writeFileSync(path.join(siblingDirs.upper, 'sibling.txt'), 'sibling bytes');
    const siblingBefore = fs.readdirSync(siblingDirs.root).sort();

    assert.equal((await victim.destroy()).state, 'DELETED');
    assert.equal(fs.existsSync(victimDirs.root), false, 'the victim directories are gone');
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'host bytes');
    assert.deepEqual(fs.readdirSync(siblingDirs.root).sort(), siblingBefore);
    assert.equal(
      fs.readFileSync(path.join(siblingDirs.upper, 'sibling.txt'), 'utf8'),
      'sibling bytes',
    );
    assert.ok(fs.existsSync(eng.config.paths.sandboxes), 'the sandboxes directory stays');
    assert.ok(fs.existsSync(path.join(eng.rootfs.dir('minimal'), 'bin')), 'the rootfs stays');
    const status = await sibling.request('runner.status', {});
    assert.equal(status.phase, 'ready', 'the sibling sandbox keeps running');
    assert.equal((await sibling.destroy()).state, 'DELETED');
    assert.equal(fs.existsSync(siblingDirs.root), false);
  } finally {
    for (const sup of sups) await sup.destroy().catch(() => undefined);
    await eng.cleanup();
  }
});

test('the health loop rotates the launch.log of a live sandbox once it grows past the cap', async () => {
  const eng = await testEngine();
  let sup = null;
  try {
    const row = eng.store.createSandbox({
      rootfs: 'minimal',
      runtime: 'current',
      profile: { network: { mode: 'none' } },
    });
    sup = new Supervisor({ ...eng, sandbox: row });
    await sup.launch();
    const dirs = sandboxDirs(eng.config.paths.sandboxes, row.id);
    const marker = 'newest line before rotation\n';
    fs.appendFileSync(dirs.log, Buffer.alloc(LAUNCH_LOG_MAX_BYTES, '.'));
    fs.appendFileSync(dirs.log, marker);
    assert.ok(fs.statSync(dirs.log).size > LAUNCH_LOG_MAX_BYTES);
    sup.startHealthPoll(50);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(`${dirs.log}.1`) && Date.now() < deadline) await sleep(25);
    const rotated = fs.readFileSync(`${dirs.log}.1`);
    assert.equal(rotated.length, LAUNCH_LOG_MAX_BYTES, 'launch.log.1 holds exactly the cap');
    assert.ok(rotated.toString().endsWith(marker), 'the newest bytes are kept');
    assert.ok(fs.statSync(dirs.log).size < LAUNCH_LOG_MAX_BYTES, 'launch.log truncated in place');
    assert.equal(sup.observeHealth(), 'HEALTHY');
    const status = await sup.request('runner.status', {});
    assert.equal(status.phase, 'ready', 'the sandbox keeps running across the rotation');
    assert.equal((await sup.destroy()).state, 'DELETED');
    assert.equal(fs.existsSync(dirs.root), false);
  } finally {
    if (sup) await sup.destroy().catch(() => undefined);
    await eng.cleanup();
  }
});
