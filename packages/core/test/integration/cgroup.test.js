import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { CgroupManager } from '../../src/host/cgroup.js';

const PARENT = `workbox-itest-${process.pid}`;
const MiB = 1024 * 1024;

/** Spawn a shell that moves itself into the cgroup before exec'ing the command. */
function spawnIn(cgroupPath, command) {
  return spawn('sh', ['-c', `echo $$ > ${cgroupPath}/cgroup.procs && exec ${command}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('real processes are confined: placement, memory OOM kill, pid limit, kill and removal', async () => {
  const cg = new CgroupManager({ parent: PARENT });
  cg.ensureParent();
  try {
    const limits = { memoryBytes: 128 * MiB, swapBytes: 0, cpuMillis: 2000, pids: 64 };
    const p = cg.create('sb', limits);

    const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
    cg.addProcess(p, sleeper.pid);
    assert.deepEqual(cg.procs(p), [sleeper.pid]);
    assert.equal(fs.readFileSync(`/proc/${sleeper.pid}/cgroup`, 'utf8').trim(), `0::/${PARENT}/sb`);

    const hog = spawnIn(
      p,
      `${process.execPath} -e "const a=[];for(;;){a.push(Buffer.alloc(8*1024*1024,1));}"`,
    );
    const [code, signal] = await once(hog, 'exit');
    assert.equal(code, null);
    assert.equal(signal, 'SIGKILL');
    const stats = cg.stats(p);
    assert.ok(stats.memoryEvents.oom_kill >= 1, JSON.stringify(stats.memoryEvents));
    assert.ok(stats.memoryPeak === null || stats.memoryPeak <= 128 * MiB + 4 * MiB);
    assert.deepEqual(cg.procs(p), [sleeper.pid]);

    cg.applyLimits(p, { ...limits, pids: 4 });
    const forker = spawnIn(p, 'sh -c "for i in 1 2 3 4 5 6 7 8 9 10; do sleep 2 & done; wait"');
    let err = '';
    forker.stderr.on('data', (d) => (err += d));
    await once(forker, 'exit');
    assert.match(err, /Resource temporarily unavailable|can't fork|Cannot fork/i);
    const pidsEvents = fs.readFileSync(`${p}/pids.events`, 'utf8');
    assert.match(pidsEvents, /max [1-9]/);

    assert.ok(cg.procs(p).includes(sleeper.pid));
    const sleeperExit = once(sleeper, 'exit');
    const removed = await cg.remove(p, { timeoutMs: 5000 });
    assert.equal(removed.removed, true);
    const [sc, ss] = await sleeperExit;
    assert.equal(sc, null);
    assert.equal(ss, 'SIGKILL');
    assert.equal(fs.existsSync(p), false);
  } finally {
    for (const name of cg.list()) await cg.remove(cg.childPath(name)).catch(() => {});
    fs.rmdirSync(cg.parentPath);
  }
});
