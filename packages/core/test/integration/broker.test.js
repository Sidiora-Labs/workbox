import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION } from '@workbox/protocol';
import { Manager } from '../../src/sandbox/manager.js';
import { Supervisor } from '../../src/sandbox/supervisor.js';
import { SecretProvider } from '../../src/secrets.js';
import { sandboxDirs, hashNonce } from '../../src/host/launch.js';
import {
  stdoutChannel,
  webhookChannel,
  issueLease,
  checkpointCreate,
} from '../../src/broker/index.js';
import { testEngine } from '../helpers/engine.js';
import { Runner } from '../../../runner/src/runner.js';
import { createLog } from '../../../runner/src/log.js';

const MiB = 1024 * 1024;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const sleep = (ms) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

/** A local peer on the runner socket, for calls `wb` never makes. */
const PROBE = `
import { WbClient } from '/opt/workbox/lib/wb/src/client.js';
const client = new WbClient();
const results = [];
for (const step of JSON.parse(process.argv[1])) {
  try {
    results.push({ ok: await client.request(step.method, step.params) });
  } catch (e) {
    results.push({ code: e.code, message: e.message });
  }
}
client.close();
process.stdout.write(JSON.stringify(results));
`;

async function until(fn, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function auditEntries(eng) {
  return fs
    .readdirSync(eng.config.paths.audit)
    .flatMap((f) =>
      fs.readFileSync(path.join(eng.config.paths.audit, f), 'utf8').split('\n').filter(Boolean),
    )
    .map((l) => JSON.parse(l));
}

function filesUnder(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function wbJson(res) {
  assert.equal(res.exitCode, 0, `${res.stdout}\n${res.stderr}`);
  return lastJson(res.stdout);
}

async function checkAsks({ a, b, eng, manager, hooks, stdoutLines }) {
  const q = wbJson(await a.wb(['ask', 'raise', '--json', '--kind', 'question', 'Which branch?']));
  assert.equal(q.kind, 'question');
  assert.equal(q.status, 'open');
  const hook = await until(() => hooks.find((h) => h.ask.askId === q.askId), 'webhook delivery');
  assert.equal(hook.type, 'ask');
  assert.equal(hook.ask.title, 'Which branch?');
  const line = await until(
    () => stdoutLines().find((l) => JSON.parse(l).ask.askId === q.askId),
    'stdout delivery',
  );
  assert.equal(JSON.parse(line).ask.kind, 'question');
  const notified = await until(() => {
    const n = auditEntries(eng).filter(
      (e) => e.action === 'ask.notify' && e.data.askId === q.askId,
    );
    return n.length === 2 ? n : null;
  }, 'ask.notify audit');
  assert.deepEqual(notified.map((e) => [e.data.channel, e.data.ok]).sort(), [
    ['stdout', true],
    ['webhook', true],
  ]);

  const waiting = a.wb(['ask', 'wait', q.askId, '--timeout-ms', '30000', '--json']);
  await sleep(300);
  assert.equal(wbJson(await a.wb(['ask', 'status', q.askId, '--json'])).status, 'open');
  const answered = manager.answerAsk(q.askId, { answer: 'main', by: 'tester' });
  assert.equal(answered.status, 'answered');
  const woke = wbJson(await waiting);
  assert.equal(woke.status, 'answered');
  assert.equal(woke.answer, 'main');

  const noOptions = await a.wb(['ask', 'raise', '--kind', 'decision', 'Pick one']);
  assert.equal(noOptions.exitCode, 2, noOptions.stderr);
  const decision = wbJson(
    await a.wb([
      'ask',
      'raise',
      '--json',
      '--kind',
      'decision',
      '--option',
      'ship',
      '--option',
      'hold',
      'Ship it?',
    ]),
  );
  assert.throws(() => manager.answerAsk(decision.askId, { answer: 'maybe' }), {
    code: 'E_INVALID_PARAMS',
  });
  assert.equal(manager.answerAsk(decision.askId, { answer: 'hold' }).answer, 'hold');
  const perm = wbJson(await a.wb(['ask', 'raise', '--json', '--kind', 'permission', 'Push?']));
  assert.throws(() => manager.answerAsk(perm.askId, { answer: 'yes' }), {
    code: 'E_INVALID_PARAMS',
  });
  assert.equal(manager.answerAsk(perm.askId, { answer: true }).answer, true);
  const secretAsk = wbJson(
    await a.wb(['ask', 'raise', '--json', '--kind', 'secret', '--ref', 'DEPLOY_TOKEN', 'Token?']),
  );
  assert.throws(() => manager.answerAsk(secretAsk.askId, { answer: 'not a ref!' }), {
    code: 'E_INVALID_PARAMS',
  });
  assert.equal(
    manager.answerAsk(secretAsk.askId, { answer: 'DEPLOY_TOKEN' }).answer,
    'DEPLOY_TOKEN',
  );

  const slow = wbJson(await a.wb(['ask', 'raise', '--json', 'Nobody answers']));
  const timedOut = await a.wb(['ask', 'wait', slow.askId, '--timeout-ms', '400', '--json']);
  assert.equal(timedOut.exitCode, 5, timedOut.stdout);
  assert.equal(lastJson(timedOut.stdout).error.code, 'E_TIMEOUT');

  const expiring = wbJson(await a.wb(['ask', 'raise', '--json', '--timeout-ms', '200', 'Brief']));
  await sleep(400);
  assert.equal(wbJson(await a.wb(['ask', 'status', expiring.askId, '--json'])).status, 'expired');
  assert.equal(
    wbJson(await a.wb(['ask', 'wait', expiring.askId, '--timeout-ms', '5000', '--json'])).status,
    'expired',
  );
  assert.throws(() => manager.answerAsk(expiring.askId, { answer: 'late' }), {
    code: 'E_STATE',
  });

  const listed = wbJson(await a.wb(['ask', 'list', '--json'])).asks;
  assert.deepEqual([...new Set(listed.map((x) => x.kind))].sort(), [
    'decision',
    'permission',
    'question',
    'secret',
  ]);
  assert.deepEqual(
    wbJson(await a.wb(['ask', 'list', 'expired', '--json'])).asks.map((x) => x.askId),
    [expiring.askId],
  );

  const viaWb = await a.wb(['ask', 'answer', slow.askId, 'yes']);
  assert.equal(viaWb.exitCode, 2, 'wb has no answer subcommand');
  const probe = await a.exec([
    '/opt/workbox/node/bin/node',
    '--input-type=module',
    '-e',
    PROBE,
    JSON.stringify([
      { method: 'broker.ask.answer', params: { askId: slow.askId, answer: 'yes' } },
      { method: 'ask.answer', params: { askId: slow.askId, answer: 'yes' } },
    ]),
  ]);
  assert.equal(probe.exitCode, 0, probe.stderr);
  for (const r of JSON.parse(probe.stdout)) assert.equal(r.code, 'E_UNKNOWN_METHOD');
  assert.equal(eng.store.getAsk(slow.askId).answer, null, 'no answer arrived from the sandbox');
  const foreign = await b.wb(['ask', 'status', q.askId, '--json']);
  assert.equal(foreign.exitCode, 3, 'another sandbox cannot read the ask');

  const raised = auditEntries(eng).filter((e) => e.action === 'ask.raise' && e.sandboxId === a.id);
  assert.ok(raised.length >= 6, `ask.raise audited: ${raised.length}`);
  assert.ok(auditEntries(eng).some((e) => e.action === 'ask.answer' && e.data.askId === q.askId));
}

async function checkSecrets(a, eng, manager, secret) {
  const listed = wbJson(await a.wb(['secret', 'list', '--json']));
  assert.deepEqual(listed, { refs: ['DEPLOY_TOKEN'] }, 'references only, policy-filtered');

  const seen = await a.wb([
    'secret',
    'exec',
    'DEPLOY_TOKEN',
    '--json',
    '--',
    'sh',
    '-c',
    'printf %s "$DEPLOY_TOKEN" | sha256sum; echo "leak:$DEPLOY_TOKEN"',
  ]);
  assert.equal(seen.exitCode, 0, seen.stderr);
  assert.ok(seen.stdout.startsWith(`${sha256(secret)}  -\n`), seen.stdout);
  assert.ok(seen.stdout.includes('leak:[REDACTED:DEPLOY_TOKEN]\n'), seen.stdout);
  assert.ok(!seen.stdout.includes(secret));
  const sessionId = lastJson(seen.stdout).sessionId;

  const renamed = await a.wb([
    'secret',
    'exec',
    'DEPLOY_TOKEN=CI_TOKEN',
    '--json',
    '--',
    'sh',
    '-c',
    'printf %s "$CI_TOKEN" | sha256sum; [ -n "$DEPLOY_TOKEN" ] && echo plain:set || echo plain:unset',
  ]);
  assert.equal(renamed.exitCode, 0, renamed.stderr);
  assert.ok(renamed.stdout.startsWith(`${sha256(secret)}  -\nplain:unset\n`), renamed.stdout);

  const outside = await a.wb(['run', '--', 'sh', '-c', 'echo "x$DEPLOY_TOKEN"x']);
  assert.equal(outside.exitCode, 0, outside.stderr);
  assert.equal(outside.stdout, 'xx\n', 'the value exists only in the secret exec child');

  const refused = await a.wb(['secret', 'exec', 'OTHER_TOKEN', '--json', '--', 'true']);
  assert.equal(refused.exitCode, 4, refused.stdout);
  assert.equal(lastJson(refused.stdout).error.code, 'E_DENIED');
  assert.match(lastJson(refused.stdout).error.message, /outside this sandbox's policy/);

  const killed = await a.wb(['secret', 'exec', 'DEPLOY_TOKEN', '--', 'sh', '-c', 'kill -KILL $$']);
  assert.equal(killed.exitCode, 137, 'a signal death exits 128 + SIGKILL, never 0');
  const termed = await a.wb(['secret', 'exec', 'DEPLOY_TOKEN', '--', 'sh', '-c', 'kill -TERM $$']);
  assert.equal(termed.exitCode, 143);

  const probe = await a.exec([
    '/opt/workbox/node/bin/node',
    '--input-type=module',
    '-e',
    PROBE,
    JSON.stringify([{ method: 'broker.secret.resolve', params: { refs: ['DEPLOY_TOKEN'] } }]),
  ]);
  assert.equal(probe.exitCode, 0, probe.stderr);
  assert.equal(JSON.parse(probe.stdout)[0].code, 'E_DENIED');
  assert.ok(!probe.stdout.includes(secret));

  const chunks = [];
  const onEvent = (ev) => {
    if (ev.method === 'session.output' && ev.params?.sessionId === sessionId)
      chunks.push(Buffer.from(ev.params.data, 'base64'));
  };
  manager.on('event', onEvent);
  try {
    await manager.request(a.id, 'session.attach', { sessionId, fromSeq: 0 });
    await until(() => Buffer.concat(chunks).includes('leak:'), 'the spool replay');
  } finally {
    manager.off('event', onEvent);
  }
  const replay = Buffer.concat(chunks).toString();
  assert.ok(replay.includes('leak:[REDACTED:DEPLOY_TOKEN]'), 'spool replay is redacted');
  assert.ok(!replay.includes(secret), 'spool replay never carries the value');

  const resolved = auditEntries(eng).filter((e) => e.action === 'secret.resolve');
  assert.ok(resolved.length >= 3);
  for (const e of resolved) assert.deepEqual(e.data.refs, ['DEPLOY_TOKEN']);
  eng.audit.append({ actor: 'tester', action: 'probe.redaction', data: { note: `v=${secret}` } });
  const probeEntry = auditEntries(eng).find((e) => e.action === 'probe.redaction');
  assert.equal(probeEntry.data.note, 'v=[REDACTED:DEPLOY_TOKEN]', 'the audit redacts the value');
}

function assertSecretAbsent(a, eng, secret) {
  const needle = Buffer.from(secret);
  const files = [
    ...filesUnder(path.dirname(eng.config.paths.db)).filter((f) =>
      path.basename(f).startsWith(path.basename(eng.config.paths.db)),
    ),
    ...filesUnder(eng.config.paths.audit),
    ...filesUnder(sandboxDirs(eng.config.paths.sandboxes, a.id).root),
    ...filesUnder(eng.config.paths.artifacts),
    ...filesUnder(eng.config.paths.checkpoints),
  ];
  assert.ok(files.length > 5, `scanned ${files.length} files`);
  for (const f of files)
    assert.equal(fs.readFileSync(f).indexOf(needle), -1, `value found in ${f}`);
  for (const e of eng.store.listEvidence(a.id, { limit: 1000 }).items)
    assert.ok(!JSON.stringify(e).includes(secret), 'evidence is clean');
}

async function checkEventsAndLeases(a, eng) {
  const first = wbJson(await a.wb(['event', 'emit', 'build.started', '{"step":1}', '--json']));
  assert.ok(Number.isInteger(first.seq) && first.seq > 0);
  const second = wbJson(
    await a.wb([
      'event',
      'emit',
      'build.done',
      '{"ok":true}',
      '--causation',
      String(first.seq),
      '--json',
    ]),
  );
  assert.ok(second.seq > first.seq, 'sequence increases');
  const events = eng.store.listEvents(a.id, { limit: 1000 });
  const done = events.find((e) => e.seq === second.seq);
  assert.equal(done.type, 'build.done');
  assert.deepEqual(done.payload, { ok: true });
  assert.equal(done.causation, String(first.seq));
  assert.equal(done.source, 'wb');
  const bad = await a.wb(['event', 'emit', 'Not A Type']);
  assert.equal(bad.exitCode, 2);
  assert.ok(
    auditEntries(eng).some((e) => e.action === 'event.emit' && e.data.seq === second.seq),
    'event.emit audited',
  );

  const status = wbJson(await a.wb(['lease', 'status', '--json'])).lease;
  assert.equal(status.sandboxId, a.id);
  assert.equal(status.expired, false);
  assert.equal(status.offlineDeadline, status.expiresAt);
  assert.ok(status.remainingMs > 0);
  await sleep(20);
  const renewed = wbJson(await a.wb(['lease', 'renew', '--ttl-ms', '600000', '--json'])).lease;
  assert.equal(renewed.generation, status.generation);
  assert.ok(renewed.renewedAt >= status.issuedAt);
  assert.ok(renewed.expiresAt > status.expiresAt, 'renew extends the deadline');
  assert.ok(auditEntries(eng).some((e) => e.action === 'lease.renew' && e.sandboxId === a.id));

  issueLease({ store: eng.store, sandboxId: a.id }, { ttlMs: 50 });
  await sleep(120);
  const lapsed = wbJson(await a.wb(['lease', 'status', '--json'])).lease;
  assert.equal(lapsed.expired, true);
  assert.equal(lapsed.remainingMs, 0);
  const late = await a.wb(['lease', 'renew', '--json']);
  assert.equal(late.exitCode, 1, late.stdout);
  assert.equal(lastJson(late.stdout).error.code, 'E_STATE');
  assert.equal(eng.store.getSandbox(a.id).state, 'READY', 'expiry is reported, never a kill');
  issueLease({ store: eng.store, sandboxId: a.id }, { ttlMs: 600_000 });
  assert.equal(wbJson(await a.wb(['lease', 'status', '--json'])).lease.expired, false);
}

async function checkCheckpoints(a, eng, manager, ids) {
  const write = await a.exec([
    'sh',
    '-c',
    'mkdir -p /workspace/cp && echo checkpointed > /workspace/cp/note.txt',
  ]);
  assert.equal(write.exitCode, 0, write.stderr);
  const writer = wbJson(
    await a.wb([
      'session',
      'start',
      '--json',
      '--',
      'sh',
      '-c',
      'i=0; while :; do i=$((i+1)); echo $i > /workspace/cp/counter; done',
    ]),
  );
  await sleep(200);
  const cp = wbJson(await a.wb(['checkpoint', 'create', '--name', 'first', '--json']));
  assert.equal(cp.name, 'first');
  const sup = manager.supervisor(a.id);
  assert.equal(
    fs.readFileSync(path.join(sup.cgroupPath, 'cgroup.freeze'), 'utf8').trim(),
    '0',
    'the sandbox is thawed after the checkpoint',
  );
  const row = eng.store.getCheckpoint(cp.id);
  const tar = path.join(eng.config.paths.checkpoints, row.envelope.tar);
  assert.equal(sha256(fs.readFileSync(tar)), cp.sha256, 'envelope digest matches the archive');
  assert.equal(fs.statSync(tar).size, cp.size);
  assert.equal(row.envelope.name, 'first');
  const counterFile = path.join(
    sandboxDirs(eng.config.paths.sandboxes, a.id).upper,
    'workspace/cp/counter',
  );
  const counter = () => Number(fs.readFileSync(counterFile, 'utf8').trim() || 0);
  const before = counter();
  await until(() => counter() > before, 'the writer resumes after the freeze');
  const listed = wbJson(await a.wb(['checkpoint', 'list', '--json'])).checkpoints;
  assert.deepEqual(
    listed.map((c) => [c.id, c.sha256]),
    [[cp.id, cp.sha256]],
  );
  assert.ok(auditEntries(eng).some((e) => e.action === 'checkpoint.create' && e.data.id === cp.id));

  const unfreezable = path.join(eng.dir, 'not-a-cgroup');
  fs.mkdirSync(unfreezable, { recursive: true });
  const before2 = fs.readdirSync(eng.config.paths.checkpoints).length;
  await assert.rejects(
    checkpointCreate({ ...manager.brokerContextFor(sup), cgroupPath: unfreezable }, {}),
    { code: 'E_UNAVAILABLE' },
  );
  assert.equal(
    fs.readdirSync(eng.config.paths.checkpoints).length,
    before2,
    'a refused checkpoint leaves no archive',
  );
  assert.equal(eng.store.listCheckpoints(a.id).length, 1);
  const stop = await a.wb(['session', 'stop', writer.sessionId, '--json']);
  assert.equal(stop.exitCode, 0, stop.stderr);

  const fresh = await manager.create({ name: 'broker-restored', fromCheckpoint: cp.id });
  ids.push(fresh.id);
  const seen = await manager.exec(fresh.id, {
    argv: ['cat', '/workspace/cp/note.txt'],
    timeoutMs: 60_000,
  });
  assert.equal(seen.exitCode, 0, seen.stderr);
  assert.equal(seen.stdout, 'checkpointed\n', 'the new sandbox sees the restored files');
  assert.ok(
    auditEntries(eng).some(
      (e) => e.action === 'checkpoint.restore' && e.data.checkpointId === cp.id,
    ),
  );
}

async function checkArtifacts(a, b, eng) {
  const make = await a.exec(['sh', '-c', 'echo payload-a > /workspace/a.txt']);
  assert.equal(make.exitCode, 0, make.stderr);
  const put = wbJson(await a.wb(['artifact', 'put', '/workspace/a.txt', '--json']));
  assert.equal(put.sha256, sha256('payload-a\n'));
  assert.equal(put.size, 10);
  const items = wbJson(await a.wb(['artifact', 'list', '--json'])).items;
  assert.equal(items.find((i) => i.sha256 === put.sha256)?.name, 'a.txt');
  const got = wbJson(
    await a.wb(['artifact', 'get', put.sha256, '/workspace/a-copy.txt', '--json']),
  );
  assert.equal(got.path, '/workspace/a-copy.txt');
  assert.equal((await a.exec(['cat', '/workspace/a-copy.txt'])).stdout, 'payload-a\n');
  assert.ok(
    auditEntries(eng).some((e) => e.action === 'artifact.put' && e.data.sha256 === put.sha256),
  );
  assert.ok(auditEntries(eng).some((e) => e.action === 'artifact.get' && e.sandboxId === a.id));

  const stolen = await b.wb(['artifact', 'get', put.sha256, '/workspace/stolen.txt', '--json']);
  assert.equal(stolen.exitCode, 3, stolen.stdout);
  assert.equal(lastJson(stolen.stdout).error.code, 'E_NOT_FOUND');
  assert.equal((await b.exec(['test', '-e', '/workspace/stolen.txt'])).exitCode, 1);
  const bInbox = path.join(sandboxDirs(eng.config.paths.sandboxes, b.id).run, 'inbox');
  assert.ok(!fs.existsSync(path.join(bInbox, put.sha256)), 'nothing delivered to the other inbox');
  const bItems = wbJson(await b.wb(['artifact', 'list', '--json'])).items;
  assert.ok(!bItems.some((i) => i.sha256 === put.sha256));
  assert.ok(
    auditEntries(eng).some(
      (e) =>
        e.action === 'artifact.get.denied' && e.sandboxId === b.id && e.data.sha256 === put.sha256,
    ),
  );
}

async function checkNonce(eng) {
  const row = eng.store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const deps = {
    config: eng.config,
    store: eng.store,
    audit: eng.audit,
    cgroups: eng.cgroups,
    rootfs: eng.rootfs,
    runtime: eng.runtime,
    logger: eng.logger,
  };
  const sup = new Supervisor({ ...deps, sandbox: row });
  let forged = null;
  try {
    await sup.launch();
    const bootId = sup.sandbox.bootId;
    const boot = eng.store.getBoot(bootId);
    assert.ok(boot.nonceConsumedAt > 0, 'the first host connection consumed the nonce');
    const dirs = sandboxDirs(eng.config.paths.sandboxes, row.id);
    assert.ok(!fs.readdirSync(dirs.run).some((f) => /boot/.test(f)), 'boot file removed');
    for (const pid of eng.cgroups.procs(sup.cgroupPath)) {
      for (const f of ['cmdline', 'environ']) {
        const text = fs.readFileSync(`/proc/${pid}/${f}`).toString('latin1');
        for (const hex of text.match(/[a-f0-9]{64}/g) ?? [])
          assert.notEqual(hashNonce(hex), boot.nonceHash, `nonce not in ${pid} ${f}`);
      }
    }
    sup.close();

    const replayed = randomBytes(32).toString('hex');
    eng.store.db
      .prepare(`UPDATE boots SET nonce_hash = ? WHERE boot_id = ?`)
      .run(hashNonce(replayed), bootId);
    const socketPath = path.join(dirs.run, 'runner.sock');
    fs.rmSync(socketPath, { force: true });
    forged = new Runner({
      socketPath,
      boot: { bootId, nonce: replayed, sandboxId: row.id, protocol: PROTOCOL_VERSION },
      log: createLog({ level: 'error' }),
    });
    await forged.start();
    const clone = new Supervisor({ ...deps, sandbox: eng.store.getSandbox(row.id) });
    await assert.rejects(clone.attach(), { code: 'E_QUARANTINED' });
    const q = eng.store.getSandbox(row.id);
    assert.equal(q.state, 'QUARANTINED');
    assert.match(q.stateReason, /already/);
    assert.equal(eng.cgroups.procs(sup.cgroupPath).length, 0, 'quarantine stopped the sandbox');
  } finally {
    await forged?.stop().catch(() => undefined);
    await new Supervisor({ ...deps, sandbox: eng.store.getSandbox(row.id) })
      .destroy()
      .catch(() => undefined);
  }
}

/**
 * The broker surface from inside real sandboxes built by the real Manager: asks with stdout and
 * webhook channels answered only through the host API, brokered secrets that reach the child env
 * alone, events, leases, quiesced checkpoints restored into a new sandbox, per-sandbox artifacts,
 * and a replayed boot nonce that quarantines its sandbox.
 */
test(
  'broker inside real sandboxes: asks, secrets, events, leases, checkpoints, artifacts',
  {
    timeout: 600_000,
  },
  async (t) => {
    const eng = await testEngine();
    const secret = `wbx-${randomBytes(16).toString('hex')}`;
    const secretsFile = path.join(eng.dir, 'secrets.json');
    fs.writeFileSync(
      secretsFile,
      JSON.stringify({
        DEPLOY_TOKEN: secret,
        OTHER_TOKEN: `other-${randomBytes(8).toString('hex')}`,
      }),
      { mode: 0o600 },
    );
    const hooks = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => {
        body += d;
      });
      req.on('end', () => {
        hooks.push(JSON.parse(body));
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const sink = new PassThrough();
    let printed = '';
    sink.on('data', (d) => {
      printed += d;
    });
    const manager = new Manager({
      config: eng.config,
      store: eng.store,
      audit: eng.audit,
      cgroups: eng.cgroups,
      rootfs: eng.rootfs,
      runtime: eng.runtime,
      logger: eng.logger,
      secrets: new SecretProvider({ file: secretsFile, env: {} }),
      askChannels: [
        stdoutChannel(sink),
        webhookChannel({ url: `http://127.0.0.1:${server.address().port}/asks` }),
      ],
    });
    const ids = [];
    const boxFor = (id) => ({
      id,
      exec: (argv) => manager.exec(id, { argv, timeoutMs: 60_000 }),
      wb: (args) => manager.exec(id, { argv: ['wb', ...args], timeoutMs: 60_000 }),
    });
    try {
      const limits = { memoryBytes: 256 * MiB, pids: 128 };
      const [sa, sb] = await Promise.all([
        manager.create({ name: 'broker-a', profile: { limits }, secretRefs: ['DEPLOY_TOKEN'] }),
        manager.create({ name: 'broker-b', profile: { limits } }),
      ]);
      ids.push(sa.id, sb.id);
      const a = boxFor(sa.id);
      const b = boxFor(sb.id);
      const stdoutLines = () => printed.split('\n').filter(Boolean);
      await t.test('ac_4: asks raise|status|list|wait, channels, host-only answers', () =>
        checkAsks({ a, b, eng, manager, hooks, stdoutLines }),
      );
      await t.test('ac_5: secret exec injects into the child only; list shows references', () =>
        checkSecrets(a, eng, manager, secret),
      );
      await t.test('ac_6: event emit with sequence and causation; lease status|renew|expiry', () =>
        checkEventsAndLeases(a, eng),
      );
      await t.test(
        'ac_6: checkpoint create|list quiesces a writer; restore into a new sandbox',
        () => checkCheckpoints(a, eng, manager, ids),
      );
      await t.test('ac_6: artifact put|get|list stay within their sandbox', () =>
        checkArtifacts(a, b, eng),
      );
      await t.test('ac_5: the secret value greps clean across store, audit, spool and fs', () =>
        assertSecretAbsent(a, eng, secret),
      );
      await t.test('2.2: a replayed boot nonce is refused and quarantines the sandbox', () =>
        checkNonce(eng),
      );
    } finally {
      for (const id of ids) await manager.destroy(id).catch(() => undefined);
      manager.close();
      server.close();
      await eng.cleanup();
    }
  },
);
