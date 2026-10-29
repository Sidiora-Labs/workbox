import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Manager } from '../../src/sandbox/manager.js';
import { SecretProvider } from '../../src/secrets.js';
import { testEngine } from '../helpers/engine.js';

const MiB = 1024 * 1024;
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

async function until(fn, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function wbJson(res) {
  assert.equal(res.exitCode, 0, `${res.stdout}\n${res.stderr}`);
  return lastJson(res.stdout);
}

/**
 * The event log on a real engine: a sandbox's lifecycle, a session run to exit, exec, asks, wb
 * events, artifacts and checkpoints are rows of one sequenced log, each announced as 'logged';
 * and a session that exits while no host is attached is caught up when a new Manager reattaches.
 */
test(
  'the event log records a real sandbox and catches up after a restart',
  { timeout: 300_000 },
  async (t) => {
    const eng = await testEngine();
    const secret = `wbx-${randomBytes(16).toString('hex')}`;
    const deps = {
      config: eng.config,
      store: eng.store,
      audit: eng.audit,
      cgroups: eng.cgroups,
      rootfs: eng.rootfs,
      runtime: eng.runtime,
      logger: eng.logger,
      secrets: new SecretProvider({ env: { WORKBOX_SECRET_DEPLOY_TOKEN: secret } }),
      enableNetwork: false,
    };
    const manager = new Manager(deps);
    let again = null;
    const logged = [];
    manager.on('logged', (row) => logged.push(row));
    let id = null;
    const events = () => eng.store.listEvents(id, { limit: 1000 });
    const ofType = (type, sessionId) =>
      events().filter(
        (e) => e.type === type && (sessionId === undefined || e.payload.sessionId === sessionId),
      );
    const wb = (args) => manager.exec(id, { argv: ['wb', ...args], timeoutMs: 60_000 });
    try {
      const sb = await manager.create({
        name: 'events-a',
        labels: { team: 'ci' },
        profile: { limits: { memoryBytes: 256 * MiB, pids: 128 } },
      });
      id = sb.id;

      await t.test('create logs the sandbox, its transitions and its health', () => {
        assert.deepEqual(
          events().map((e) => [e.type, e.source, e.payload]),
          [
            [
              'sandbox.created',
              'host',
              { name: 'events-a', rootfs: 'minimal', labels: { team: 'ci' } },
            ],
            ['sandbox.state', 'host', { from: 'REQUESTED', to: 'PROVISIONING', reason: 'launch' }],
            [
              'sandbox.state',
              'host',
              { from: 'PROVISIONING', to: 'BOOTSTRAPPING', reason: 'runner hello' },
            ],
            [
              'sandbox.state',
              'host',
              { from: 'BOOTSTRAPPING', to: 'READY', reason: 'runner ready' },
            ],
            ['sandbox.health', 'host', { from: 'UNKNOWN', to: 'HEALTHY', reason: null }],
          ],
        );
      });

      await t.test(
        'a session is logged once at start and once at exit, with no secret',
        async () => {
          const argv = ['sh', '-c', `: ${secret}; sleep 0.2; exit 3`];
          const started = await manager.request(id, 'session.start', { argv, name: 'build' });
          await until(() => ofType('session.exited', started.sessionId).length, 'session.exited');
          assert.deepEqual(
            ofType('session.started', started.sessionId).map((e) => e.payload),
            [
              {
                sessionId: started.sessionId,
                name: 'build',
                argv: ['sh', '-c', ': [REDACTED:DEPLOY_TOKEN]; sleep 0.2; exit 3'],
                pid: started.pid,
              },
            ],
          );
          await manager.request(id, 'session.attach', { sessionId: started.sessionId, fromSeq: 0 });
          await sleep(300);
          assert.deepEqual(
            ofType('session.exited', started.sessionId).map((e) => e.payload),
            [{ sessionId: started.sessionId, name: 'build', code: 3, signal: null }],
            'the exit replayed on attach is not logged again',
          );
        },
      );

      await t.test('exec logs exec.finished with argv0 only, after its session exit', async () => {
        const ran = await manager.exec(id, {
          argv: ['sh', '-c', `echo ${secret} >/dev/null; exit 2`],
          timeoutMs: 60_000,
        });
        assert.equal(ran.exitCode, 2, ran.stderr);
        const finished = ofType('exec.finished');
        assert.deepEqual(finished.at(-1).payload, {
          argv0: 'sh',
          exitCode: 2,
          signal: null,
          timedOut: false,
          durationMs: ran.durationMs,
        });
        const exited = ofType('session.exited', ran.sessionId);
        assert.equal(exited.length, 1);
        assert.ok(exited[0].seq < finished.at(-1).seq);
        const timed = await manager.exec(id, {
          argv: ['sleep', '30'],
          timeoutMs: 300,
          graceMs: 200,
        });
        assert.equal(timed.timedOut, true);
        const last = ofType('exec.finished').at(-1).payload;
        assert.deepEqual(
          [last.argv0, last.timedOut, last.exitCode, last.signal],
          ['sleep', true, timed.exitCode, timed.signal],
        );
        assert.ok(!JSON.stringify(events()).includes(secret), 'no event carries the secret');
      });

      await t.test('asks, wb events, artifacts and checkpoints are logged', async () => {
        const q = wbJson(
          await wb(['ask', 'raise', '--json', '--kind', 'question', 'Which branch?']),
        );
        const raised = { ...q };
        delete raised.answer;
        assert.deepEqual(
          ofType('ask.raised').map((e) => e.payload),
          [raised],
        );
        manager.answerAsk(q.askId, { answer: 'main', by: 'tester' });
        assert.deepEqual(
          ofType('ask.answered').map((e) => e.payload),
          [{ askId: q.askId, by: 'tester' }],
        );

        const emitted = wbJson(await wb(['event', 'emit', 'build.done', '{"ok":true}', '--json']));
        const row = eng.store.getEvent(emitted.seq);
        assert.deepEqual(
          [row.sandboxId, row.type, row.source, row.payload],
          [id, 'build.done', 'wb', { ok: true }],
        );
        const forged = await wb(['event', 'emit', 'session.exited', '{}', '--json']);
        assert.equal(forged.exitCode, 2, forged.stdout);
        assert.equal(lastJson(forged.stdout).error.code, 'E_INVALID_PARAMS');
        assert.ok(!events().some((e) => e.source === 'wb' && e.type.startsWith('session.')));

        const put = wbJson(
          await manager.exec(id, {
            argv: [
              'sh',
              '-c',
              'echo body > /workspace/out.txt && wb artifact put /workspace/out.txt --json',
            ],
            timeoutMs: 60_000,
          }),
        );
        assert.equal(put.sha256, createHash('sha256').update('body\n').digest('hex'));
        assert.deepEqual(
          ofType('artifact.added').map((e) => e.payload),
          [{ sha256: put.sha256, size: 5, name: 'out.txt' }],
        );
        const cp = wbJson(await wb(['checkpoint', 'create', '--name', 'cp1', '--json']));
        assert.deepEqual(
          ofType('checkpoint.created').map((e) => e.payload),
          [{ checkpointId: cp.id, name: 'cp1' }],
        );
      });

      await t.test('every append was announced as logged, and the fleet view filters', () => {
        assert.deepEqual(
          logged.filter((r) => r.sandboxId === id),
          events(),
        );
        const fleet = eng.store.listFleetEvents({
          sandboxId: id,
          types: ['session.*', 'exec.finished'],
          limit: 1000,
        });
        assert.ok(fleet.length >= 6);
        assert.ok(fleet.every((e) => e.type.startsWith('session.') || e.type === 'exec.finished'));
        assert.deepEqual(
          fleet.map((e) => e.seq),
          events()
            .filter((e) => e.type.startsWith('session.') || e.type === 'exec.finished')
            .map((e) => e.seq),
        );
      });

      await t.test(
        'a session that exits while no host is attached is logged on reattach',
        async () => {
          const late = await manager.request(id, 'session.start', {
            argv: ['sh', '-c', 'sleep 0.5; exit 7'],
            name: 'late',
          });
          await until(() => ofType('session.started', late.sessionId).length, 'session.started');
          manager.close();
          await sleep(2000);
          assert.equal(ofType('session.exited', late.sessionId).length, 0);

          again = new Manager(deps);
          const relogged = [];
          again.on('logged', (r) => relogged.push(r));
          const out = await again.reconcile();
          assert.deepEqual(out.attached, [id]);
          assert.deepEqual(
            ofType('session.exited', late.sessionId).map((e) => e.payload),
            [{ sessionId: late.sessionId, name: 'late', code: 7, signal: null }],
          );
          const stored = eng.store.listSessions(id).find((s) => s.sessionId === late.sessionId);
          assert.equal(stored.exitCode, 7);
          assert.deepEqual(
            relogged.map((r) => [r.type, r.payload.sessionId]),
            [['session.exited', late.sessionId]],
            'only the missed exit is logged; exits the store has are not',
          );
          await again.sessions(id);
          assert.equal(relogged.length, 1);

          await again.destroy(id);
          assert.deepEqual(
            relogged.slice(1).map((r) => [r.type, r.payload]),
            [
              ['sandbox.state', { from: 'READY', to: 'DELETING', reason: 'destroy requested' }],
              ['sandbox.health', { from: 'HEALTHY', to: 'ABSENT', reason: null }],
              [
                'sandbox.state',
                {
                  from: 'DELETING',
                  to: 'DELETED',
                  reason: 'cgroup removed and directories deleted',
                },
              ],
            ],
          );
          id = null;
        },
      );
    } finally {
      if (id) await (again ?? manager).destroy(id).catch(() => undefined);
      manager.close();
      again?.close();
      await eng.cleanup();
    }
  },
);
