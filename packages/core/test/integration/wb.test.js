import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Manager } from '../../src/sandbox/manager.js';
import { SecretProvider } from '../../src/secrets.js';
import { sandboxDirs } from '../../src/host/launch.js';
import { testEngine } from '../helpers/engine.js';
import { COMMANDS, helpFor } from '../../../wb/src/registry.js';

const MiB = 1024 * 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

/**
 * In-box probe: a local peer speaking to the runner socket with the shipped wb client, for the
 * calls `wb` itself never makes with hostile arguments. Each step may first drop a file or a
 * symlink into the shared outbox under `params.outboxName`.
 */
const PROBE = `
import fs from 'node:fs';
import { WbClient, OUTBOX_DIR } from '/opt/workbox/lib/wb/src/client.js';
const client = new WbClient();
const results = [];
for (const step of JSON.parse(process.argv[1])) {
  const file = OUTBOX_DIR + '/' + (step.params.outboxName ?? '');
  if (step.write !== undefined) fs.writeFileSync(file, step.write);
  if (step.link !== undefined) fs.symlinkSync(step.link, file);
  try {
    results.push({ ok: await client.request(step.method, step.params) });
  } catch (e) {
    results.push({ code: e.code, message: e.message });
  }
}
client.close();
process.stdout.write(JSON.stringify(results));
`;

async function sessionAttached(box, sessionId) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { sessions } = await box.request('session.list');
    if (sessions.find((s) => s.sessionId === sessionId)?.attached > 0) return;
    if (Date.now() > deadline) throw new Error(`no subscriber attached to ${sessionId}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function checkPathAndHelp(box) {
  const where = await box.exec(['sh', '-c', 'command -v wb; echo "$PATH"']);
  assert.equal(where.exitCode, 0, where.stderr);
  const [bin, envPath] = where.stdout.trim().split('\n');
  assert.equal(bin, '/opt/workbox/bin/wb');
  assert.ok(envPath.split(':').includes('/opt/workbox/bin'), envPath);
  const version = await box.wb(['--version']);
  assert.equal(version.exitCode, 0, version.stderr);
  assert.match(version.stdout, /^wb \d+\.\d+\.\d+/);

  for (const cmd of COMMANDS) {
    const help = await box.wb([cmd.name, '--help']);
    assert.equal(help.exitCode, 0, `wb ${cmd.name} --help: ${help.stderr}`);
    assert.equal(help.stdout, `${helpFor(cmd)}\n`);
    const json = await box.wb([cmd.name, '--help', '--json']);
    assert.equal(json.exitCode, 0, `wb ${cmd.name} --help --json: ${json.stderr}`);
    assert.deepEqual(JSON.parse(json.stdout), {
      name: cmd.name,
      summary: cmd.summary,
      usage: cmd.usage,
    });
  }
}

async function checkTools(box) {
  const text = await box.wb(['tools']);
  assert.equal(text.exitCode, 0, text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  assert.equal(lines.length, COMMANDS.length);
  for (const cmd of COMMANDS) {
    const line = lines.find((l) => l.split(/\s+/)[0] === cmd.name);
    assert.ok(line, `wb tools lists ${cmd.name}`);
    assert.ok(cmd.summary.length > 0 && !cmd.summary.includes('\n'));
    assert.ok(line.endsWith(cmd.summary), line);
  }
  const json = await box.wb(['tools', '--json']);
  assert.equal(json.exitCode, 0, json.stderr);
  const listed = JSON.parse(json.stdout).tools;
  assert.deepEqual(
    listed.map((t) => [t.name, t.summary, t.usage]),
    COMMANDS.map((c) => [c.name, c.summary, c.usage]),
  );
  for (const name of ['status', 'tools', 'help', 'session', 'run'])
    assert.ok(
      listed.some((t) => t.name === name),
      name,
    );
}

async function checkStatus(box, eng) {
  const row = eng.store.getSandbox(box.id);
  const res = await box.wb(['status', '--json']);
  assert.equal(res.exitCode, 0, res.stderr);
  const { broker, runner } = JSON.parse(res.stdout);
  assert.equal(broker.sandboxId, box.id);
  assert.ok(row.bootId, 'the store holds a boot id');
  assert.equal(broker.bootId, row.bootId);
  assert.equal(runner.bootId, row.bootId);
  assert.equal(runner.sandboxId, box.id);
  assert.equal(broker.limits.memoryBytes, 256 * MiB);
  assert.equal(broker.limits.pids, 128);
  assert.ok(broker.usage.memoryCurrent > 0, JSON.stringify(broker.usage));
  assert.ok(broker.usage.pidsCurrent > 0, JSON.stringify(broker.usage));
  assert.ok(Number.isFinite(broker.usage.cpuUsageUsec), JSON.stringify(broker.usage));
  assert.equal(broker.network.mode, 'none');
  const human = await box.wb(['status']);
  assert.equal(human.exitCode, 0, human.stderr);
  assert.ok(human.stdout.includes(box.id), human.stdout);
  assert.ok(human.stdout.includes(row.bootId), human.stdout);
}

async function checkRun(box, eng) {
  const script = 'echo out; echo err >&2; sleep 0.3; exit 3';
  const before = Date.now();
  const res = await box.wb(['run', '--json', '--', 'sh', '-c', script]);
  assert.equal(res.exitCode, 3, 'wb run propagates the command exit code');
  assert.ok(res.stdout.startsWith('out\n'), `stdout streamed: ${res.stdout}`);
  assert.equal(res.stderr, 'err\n', 'stderr streamed');
  const out = lastJson(res.stdout);

  const row = eng.store.getEvidence(out.evidence.id);
  assert.ok(row, 'evidence row recorded by the host');
  assert.equal(row.sandboxId, box.id);
  const e = row.envelope;
  assert.deepEqual(e.argv, ['sh', '-c', script]);
  assert.equal(e.cwd, '/workspace');
  assert.equal(e.exitCode, 3);
  assert.equal(e.signal, null);
  assert.ok(e.startedAt >= before && e.endedAt <= Date.now(), JSON.stringify(e));
  assert.equal(e.durationMs, e.endedAt - e.startedAt);
  assert.ok(e.durationMs >= 300, `duration covers the sleep: ${e.durationMs}`);
  assert.ok(Number.isInteger(e.peakRssBytes) && e.peakRssBytes > 0, `rss ${e.peakRssBytes}`);
  assert.equal(e.stdoutSha256, sha256('out\n'));
  assert.equal(e.stderrSha256, sha256('err\n'));
  assert.equal(e.logSha256, out.artifact.sha256);
  assert.equal(row.logSha256, out.artifact.sha256);

  const casFile = path.join(eng.config.paths.artifacts, e.logSha256.slice(0, 2), e.logSha256);
  const log = fs.readFileSync(casFile);
  assert.equal(sha256(log), e.logSha256, 'CAS bytes hash to the recorded digest');
  assert.equal(log.length, out.artifact.size);
  assert.deepEqual(log.toString().trim().split('\n').sort(), ['err', 'out']);
  assert.equal(eng.store.getArtifact(e.logSha256).size, log.length);
  const ref = eng.store.listArtifacts(box.id).items.find((a) => a.sha256 === e.logSha256);
  assert.equal(ref?.name, 'run.log');
  assert.equal(ref?.kind, 'evidence-log');
  assert.deepEqual(fs.readdirSync(box.outboxDir), [], 'the host unlinked the outbox copy');

  const killed = await box.wb(['run', '--', 'sh', '-c', 'echo before; kill -KILL $$']);
  assert.equal(killed.exitCode, 137, 'a signal death exits 128 + SIGKILL, never 0');
  assert.equal(killed.stdout, 'before\n');
  const last = eng.store.listEvidence(box.id).items.at(-1);
  assert.equal(last.envelope.exitCode, null);
  assert.equal(last.envelope.signal, 'SIGKILL');
  const killedLog = path.join(
    eng.config.paths.artifacts,
    last.logSha256.slice(0, 2),
    last.logSha256,
  );
  assert.equal(sha256(fs.readFileSync(killedLog)), sha256('before\n'));
}

async function checkSessions(box) {
  const started = await box.wb([
    'session',
    'start',
    '--json',
    '--name',
    'echoer',
    '--',
    'sh',
    '-c',
    'x=$(head -c 5); echo "got:$x"',
  ]);
  assert.equal(started.exitCode, 0, started.stderr);
  const { sessionId } = JSON.parse(started.stdout);
  assert.ok(sessionId);

  const listed = await box.wb(['session', 'list', '--json']);
  assert.equal(listed.exitCode, 0, listed.stderr);
  const echoer = JSON.parse(listed.stdout).sessions.find((s) => s.sessionId === sessionId);
  assert.equal(echoer.name, 'echoer');
  assert.equal(echoer.exited, null);

  const attach = box.wb(['session', 'attach', sessionId, '--json']);
  await sessionAttached(box, sessionId);
  const input = await box.wb(['session', 'input', sessionId, 'hello', '--json']);
  assert.equal(input.exitCode, 0, input.stderr);
  assert.deepEqual(JSON.parse(input.stdout), { sessionId, bytes: 5, eof: false });
  const attached = await attach;
  assert.equal(attached.exitCode, 0, attached.stderr);
  assert.ok(attached.stdout.startsWith('got:hello\n'), `attach streamed: ${attached.stdout}`);
  const exit = lastJson(attached.stdout).exited;
  assert.equal(exit.code, 0);
  assert.equal(exit.signal, null);

  const sleeper = await box.wb([
    'session',
    'start',
    '--json',
    '--name',
    'sleeper',
    '--',
    'sleep',
    '60',
  ]);
  assert.equal(sleeper.exitCode, 0, sleeper.stderr);
  const sleepId = JSON.parse(sleeper.stdout).sessionId;
  const stopped = await box.wb(['session', 'stop', sleepId, '--json']);
  assert.equal(stopped.exitCode, 0, stopped.stderr);
  const stop = JSON.parse(stopped.stdout);
  assert.equal(stop.sessionId, sleepId);
  assert.equal(stop.exited.signal, 'SIGTERM');
  assert.equal(stop.escalated, false);

  const after = JSON.parse((await box.wb(['session', 'list', '--json'])).stdout).sessions;
  assert.equal(after.find((s) => s.sessionId === sessionId).exited.code, 0);
  assert.equal(after.find((s) => s.sessionId === sleepId).exited.signal, 'SIGTERM');
}

async function checkAttachExited(box) {
  const started = await box.wb([
    'session',
    'start',
    '--json',
    '--',
    'sh',
    '-c',
    'echo kept-out; echo kept-err >&2; exit 7',
  ]);
  assert.equal(started.exitCode, 0, started.stderr);
  const { sessionId } = JSON.parse(started.stdout);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const { sessions } = await box.request('session.list');
    if (sessions.find((s) => s.sessionId === sessionId)?.exited) break;
    if (Date.now() > deadline) throw new Error(`session ${sessionId} did not exit`);
    await new Promise((r) => setTimeout(r, 50));
  }
  const attached = await box.wb(['session', 'attach', sessionId]);
  assert.equal(attached.exitCode, 7, attached.stderr);
  assert.match(attached.stdout, /kept-out\n/);
  assert.match(attached.stdout, /kept-err\n/);
  assert.equal(attached.stderr, `wb: session ${sessionId} exited with code 7\n`);
  assert.doesNotMatch(attached.stderr, /TypeError/);
  const json = await box.wb(['session', 'attach', sessionId, '--json']);
  assert.equal(json.exitCode, 7, json.stderr);
  const result = lastJson(json.stdout);
  assert.equal(result.exited.code, 7);
  assert.equal(result.exitCode, 7);
}

async function checkHandoffAndRelayGuards(box, eng) {
  const genuine = 'genuine bytes\n';
  const secretFile = path.join(eng.dir, 'host-secret.txt');
  fs.writeFileSync(secretFile, 'host-only secret\n', { mode: 0o600 });
  const secretBytes = fs.readFileSync(secretFile);
  const foreign = Buffer.from('host-owned bytes\n');
  fs.writeFileSync(path.join(box.outboxDir, 'foreign.bin'), foreign);
  assert.equal(fs.statSync(path.join(box.outboxDir, 'foreign.bin')).uid, 0);
  const put = (outboxName, data, file = {}, forged = {}) => ({
    method: 'broker.artifact.put',
    params: { outboxName, sha256: sha256(data), size: Buffer.byteLength(data), ...forged },
    ...file,
  });
  const steps = [
    put(
      'forged-digest.bin',
      genuine,
      { write: genuine },
      { sha256: sha256('not what was written') },
    ),
    put('forged-size.bin', genuine, { write: genuine }, { size: Buffer.byteLength(genuine) + 1 }),
    put('escape.bin', secretBytes, { link: secretFile }),
    put('foreign.bin', foreign),
    { method: 'broker.secret.resolve', params: { refs: ['GREETING'] } },
  ];
  const res = await box.exec([
    '/opt/workbox/node/bin/node',
    '--input-type=module',
    '-e',
    PROBE,
    JSON.stringify(steps),
  ]);
  assert.equal(res.exitCode, 0, res.stderr);
  assert.ok(!res.stdout.includes('hello-secret'), 'no secret value reached a local peer');
  const [digest, size, link, owner, secret] = JSON.parse(res.stdout);
  assert.equal(digest.code, 'E_INVALID_PARAMS', JSON.stringify(digest));
  assert.match(digest.message, /digest\/size mismatch/);
  assert.equal(size.code, 'E_INVALID_PARAMS', JSON.stringify(size));
  assert.match(size.message, /digest\/size mismatch/);
  assert.equal(link.code, 'E_NOT_FOUND', JSON.stringify(link));
  assert.match(link.message, /ELOOP/, 'O_NOFOLLOW refused the symlink');
  assert.equal(owner.code, 'E_DENIED', JSON.stringify(owner));
  assert.match(owner.message, /outside the mapped range/);
  assert.equal(secret.code, 'E_DENIED', JSON.stringify(secret));
  for (const data of [genuine, 'not what was written', secretBytes, foreign]) {
    const sha = sha256(data);
    assert.equal(eng.store.getArtifact(sha), null, `no store row for ${sha}`);
    assert.equal(fs.existsSync(path.join(eng.config.paths.artifacts, sha.slice(0, 2), sha)), false);
  }
  for (const name of ['forged-digest.bin', 'forged-size.bin', 'foreign.bin'])
    assert.equal(fs.existsSync(path.join(box.outboxDir, name)), false, `${name} unlinked`);
  assert.equal(fs.readFileSync(secretFile, 'utf8'), 'host-only secret\n');
}

/**
 * wb inside a real sandbox built by the real Manager: PATH, --help/--json on every registry entry,
 * wb tools, wb status, wb run evidence with the log digest-verified into the CAS, wb session
 * start|list|attach|input|stop, and the outbox and relay guards against a hostile local peer.
 */
test(
  'wb inside a real sandbox: status, tools, help, run evidence, sessions, outbox guards',
  {
    timeout: 300_000,
  },
  async (t) => {
    const eng = await testEngine();
    const manager = new Manager({
      config: eng.config,
      store: eng.store,
      audit: eng.audit,
      cgroups: eng.cgroups,
      rootfs: eng.rootfs,
      runtime: eng.runtime,
      logger: eng.logger,
      secrets: new SecretProvider({ env: { WORKBOX_SECRET_GREETING: 'hello-secret' } }),
    });
    let id = null;
    try {
      const sb = await manager.create({
        name: 'wbbox',
        profile: { limits: { memoryBytes: 256 * MiB, pids: 128 } },
        secretRefs: ['GREETING'],
      });
      id = sb.id;
      const box = {
        id,
        outboxDir: path.join(sandboxDirs(eng.config.paths.sandboxes, id).run, 'outbox'),
        exec: (argv) => manager.exec(id, { argv, timeoutMs: 60_000 }),
        wb: (args) => manager.exec(id, { argv: ['wb', ...args], timeoutMs: 60_000 }),
        request: (method, params = {}) => manager.request(id, method, params),
      };
      await t.test('ac_1: wb on PATH, --help and --json on every subcommand', () =>
        checkPathAndHelp(box),
      );
      await t.test('ac_1: wb tools lists every subcommand with a one-line summary', () =>
        checkTools(box),
      );
      await t.test('ac_1: wb status reports ids, limits, usage and network mode', () =>
        checkStatus(box, eng),
      );
      await t.test('ac_2: wb run streams, records evidence, stores a digest-verified log', () =>
        checkRun(box, eng),
      );
      await t.test('ac_3: wb session start|list|attach|input|stop', () => checkSessions(box));
      await t.test(
        'ac_3: wb session attach on an exited session replays and exits with its status',
        () => checkAttachExited(box),
      );
      await t.test('ac_2: outbox and relay guards reject a hostile local peer', () =>
        checkHandoffAndRelayGuards(box, eng),
      );
    } finally {
      if (id) await manager.destroy(id).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    }
  },
);
