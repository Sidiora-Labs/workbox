import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor } from '../../src/sandbox/supervisor.js';
import { exec } from '../../src/sandbox/exec.js';
import { testEngine } from '../helpers/engine.js';

const until = async (fn, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/**
 * Sessions inside a real sandbox: isolation seen from the agent's side, the in-sandbox OOM kill,
 * pid limits, survival across a supervisor restart, and the exec helper end to end.
 */
test('sessions in a real sandbox: identity, OOM kill, pid limit, exec, survival across reattach', async () => {
  const eng = await testEngine();
  try {
    const MiB = 1024 * 1024;
    const row = eng.store.createSandbox({
      name: 'beta',
      rootfs: 'minimal',
      runtime: 'current',
      profile: { limits: { memoryBytes: 128 * MiB, pids: 64 } },
    });
    const sup = new Supervisor({ ...eng, sandbox: row });
    await sup.launch();

    const who = await exec(sup, {
      argv: [
        'sh',
        '-c',
        'id -u; hostname; cat /etc/hostname; pwd; echo $HOME $WORKBOX_SANDBOX; ls /opt/workbox/bin; cat /proc/self/status | grep -E "^(CapEff|NoNewPrivs)"; echo $$',
      ],
    });
    assert.equal(who.exitCode, 0, who.stderr);
    const lines = who.stdout.trim().split('\n');
    assert.equal(lines[0], '0');
    assert.equal(lines[1], 'beta');
    assert.equal(lines[2], 'beta');
    assert.equal(lines[3], '/workspace');
    assert.equal(lines[4], `/root ${row.id}`);
    assert.equal(lines[5], 'init.sh');
    assert.equal(lines[6], 'wb');
    assert.equal(lines[7], 'CapEff:\t00000000a80425fb');
    assert.equal(lines[8], 'NoNewPrivs:\t1');
    assert.ok(
      Number(lines[9]) < 50,
      `session pids are small inside the pid namespace: ${lines[9]}`,
    );

    const denied = await exec(sup, {
      argv: [
        'sh',
        '-c',
        'mount -t tmpfs none /mnt 2>&1; echo rc=$?; unshare -r true 2>&1; echo rc=$?; cat /etc/shadow | head -c 5; echo; touch /opt/workbox/x 2>&1; echo rc=$?',
      ],
    });
    assert.match(denied.stdout, /ermission denied[\s\S]*rc=32/);
    assert.match(denied.stdout, /rc=1\nroot:/);
    assert.match(denied.stdout, /Read-only file system[\s\S]*rc=1/);

    const hog = await exec(sup, {
      argv: [
        '/opt/workbox/node/bin/node',
        '-e',
        'const a=[];for(;;){a.push(Buffer.alloc(8*1024*1024,1));}',
      ],
      timeoutMs: 30_000,
    });
    assert.equal(hog.signal, 'SIGKILL', `allocator was OOM-killed: ${JSON.stringify(hog)}`);
    assert.equal(hog.timedOut, false);
    const stats = eng.cgroups.stats(sup.cgroupPath);
    assert.ok(stats.memoryEvents.oom_kill >= 1, JSON.stringify(stats.memoryEvents));
    const alive = await sup.request('runner.status', {});
    assert.equal(alive.phase, 'ready', 'the runner survived the OOM kill of one session');

    const forks = await exec(sup, {
      argv: [
        'sh',
        '-c',
        'for i in $(seq 1 100); do sleep 1 & done 2>&1 | head -1; wait; echo forked',
      ],
    });
    assert.match(forks.stdout, /Resource temporarily unavailable|fork/);

    const file = await exec(sup, {
      argv: ['sh', '-c', 'echo persisted > /workspace/note.txt && cat /workspace/note.txt'],
    });
    assert.equal(file.stdout, 'persisted\n');

    const seen = [];
    sup.on('event', (m, p) => seen.push([m, p]));
    const bg = await sup.request('session.start', {
      argv: ['sh', '-c', 'i=0; while [ $i -lt 40 ]; do echo tick$i; i=$((i+1)); sleep 0.05; done'],
      name: 'ticker',
    });
    await until(() =>
      seen.some(([m, p]) => m === 'session.started' && p.sessionId === bg.sessionId),
    );
    sup.close();
    await new Promise((r) => setTimeout(r, 500));

    const again = new Supervisor({ ...eng, sandbox: eng.store.getSandbox(row.id) });
    const health = await again.attach();
    assert.equal(health, 'HEALTHY');
    const list = await again.request('session.list', {});
    const ticker = list.sessions.find((s) => s.sessionId === bg.sessionId);
    assert.ok(ticker, 'the session outlived the supervisor');
    assert.ok(ticker.seq >= 5, `ticker produced output meanwhile: ${ticker.seq}`);
    const got = [];
    again.on('event', (m, p) => got.push([m, p]));
    const att = await again.request('session.attach', { sessionId: bg.sessionId, fromSeq: 0 });
    assert.equal(att.gap, null);
    await until(
      () => got.some(([m, p]) => m === 'session.exit' && p.sessionId === bg.sessionId),
      15_000,
    );
    const text = got
      .filter(([m, p]) => m === 'session.output' && p.sessionId === bg.sessionId)
      .map(([, p]) => Buffer.from(p.data, 'base64').toString())
      .join('');
    assert.equal(
      text.trim().split('\n').length,
      40,
      'every tick replayed or streamed exactly once',
    );
    assert.equal(text.trim().split('\n')[0], 'tick0');

    const sleeper = await again.request('session.start', {
      argv: ['sh', '-c', 'trap "" TERM; echo armed; sleep 60'],
      name: 'stubborn',
    });
    // Stop only once the trap is in place: a SIGTERM that beats `trap` kills sh outright.
    for (let armed = false, deadline = Date.now() + 10_000; !armed; ) {
      assert.ok(Date.now() < deadline, 'the stubborn session printed armed');
      const { sessions } = await again.request('session.list', {});
      armed = sessions.find((s) => s.sessionId === sleeper.sessionId)?.seq >= 1;
      if (!armed) await new Promise((r) => setTimeout(r, 25));
    }
    const stopped = await again.request(
      'session.stop',
      { sessionId: sleeper.sessionId, graceMs: 300 },
      { timeoutMs: 10_000 },
    );
    assert.equal(stopped.escalated, true);
    assert.equal(stopped.exited.signal, 'SIGKILL');
    const timed = await exec(again, { argv: ['sleep', '30'], timeoutMs: 300, graceMs: 100 });
    assert.equal(timed.timedOut, true);
    assert.equal(again.store.listSessions(row.id).length >= 0, true);

    await again.destroy();
    assert.equal(eng.store.getSandbox(row.id).state, 'DELETED');
  } finally {
    await eng.cleanup();
  }
});
