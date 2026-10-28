import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { WorkboxClient } from '../../packages/sdk/src/index.js';
import { bootServer, TOKENS } from '../../packages/server/test/helpers/real-server.js';

/**
 * End-to-end through the public surfaces: SDK -> HTTP server -> Manager -> real sandboxes.
 *
 * The lifecycle test runs `wb run` in a sandbox (evidence row plus digest-verified CAS log),
 * raises an ask from inside the box that an answer-scoped key answers over REST while `wb ask
 * wait` blocks on it, checkpoints the sandbox and restores it into a second one, and destroys both.
 *
 * The density test (req 7 ac_5) creates 20 sandboxes concurrently and records create-to-ready
 * p50/p95 and, per sandbox, the runner's VmRSS and its cgroup's memory.current into
 * docs/measurements.md. Values are recorded, never asserted against thresholds. Both tests live in
 * this one file so they run one after the other and the measurement is not skewed by the other.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const measurementsFile = path.join(repoRoot, 'docs', 'measurements.md');
const RUNNER_MAIN = '/opt/workbox/lib/runner/src/main.js';
const DENSITY = 20;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const text = (b64) => Buffer.from(b64, 'base64').toString();

function clients(base) {
  const as = (scope) => new WorkboxClient({ baseUrl: base, token: TOKENS[scope] });
  return { admin: as('admin'), harness: as('exec'), human: as('answer'), reader: as('read') };
}

async function checkRun(box, view, casDir) {
  const script = 'echo e2e-out; echo e2e-err >&2; exit 4';
  const res = await box.exec({
    argv: ['wb', 'run', '--json', '--', 'sh', '-c', script],
    timeoutMs: 60_000,
  });
  assert.equal(res.exitCode, 4, `wb run propagates the exit code: ${res.stderr}`);
  assert.ok(res.stdout.startsWith('e2e-out\n'), res.stdout);
  assert.equal(res.stderr, 'e2e-err\n');
  const out = lastJson(res.stdout);

  const evidence = await view.listEvidence({ limit: 10 });
  const row = evidence.items.find((e) => e.id === out.evidence.id);
  assert.ok(row, `evidence ${out.evidence.id} listed: ${JSON.stringify(evidence.items)}`);
  assert.equal(row.sandboxId, box.id);
  assert.deepEqual(row.envelope.argv, ['sh', '-c', script]);
  assert.equal(row.envelope.exitCode, 4);
  assert.equal(row.envelope.stdoutSha256, sha256('e2e-out\n'));
  assert.equal(row.envelope.stderrSha256, sha256('e2e-err\n'));
  assert.equal(row.logSha256, out.artifact.sha256);

  const artifacts = await view.listArtifacts({ limit: 10 });
  const ref = artifacts.items.find((a) => a.sha256 === row.logSha256);
  assert.equal(ref?.kind, 'evidence-log', JSON.stringify(artifacts.items));
  assert.equal(ref.size, out.artifact.size);
  const log = fs.readFileSync(path.join(casDir, row.logSha256.slice(0, 2), row.logSha256));
  assert.equal(sha256(log), row.logSha256, 'CAS bytes hash to the recorded digest');
  assert.deepEqual(log.toString().trim().split('\n').sort(), ['e2e-err', 'e2e-out']);
}

async function checkAsk(box, human, reader) {
  const raised = await box.exec({
    argv: [
      'wb',
      'ask',
      'raise',
      '--json',
      '--kind',
      'decision',
      '--option',
      'ship',
      '--option',
      'hold',
      'Ship the e2e build?',
    ],
  });
  assert.equal(raised.exitCode, 0, raised.stderr);
  const { askId } = lastJson(raised.stdout);

  let settled = false;
  const waiting = box
    .exec({ argv: ['wb', 'ask', 'wait', askId, '--json', '--timeout-ms', '60000'] })
    .finally(() => {
      settled = true;
    });
  const open = await reader.listAsks({ status: 'open', sandboxId: box.id, limit: 10 });
  assert.deepEqual(
    open.asks.map((a) => a.askId),
    [askId],
  );
  await delay(500);
  assert.equal(settled, false, 'wb ask wait blocks while the ask is open');
  const answered = await human.answerAsk(askId, 'ship');
  assert.equal(answered.status, 'answered');

  const waited = await waiting;
  assert.equal(waited.exitCode, 0, waited.stderr);
  const seen = lastJson(waited.stdout);
  assert.equal(seen.askId, askId);
  assert.equal(seen.status, 'answered');
  assert.equal(seen.answer, 'ship');
}

async function checkCheckpoint(admin, harness, box) {
  const file = '/workspace/e2e/note.txt';
  await box.writeFile(file, 'checkpointed by e2e\n', { mkdirs: true });
  const cp = await admin.sandbox(box.id).createCheckpoint({ name: 'e2e-cp' });
  assert.ok(cp.id && cp.sha256, JSON.stringify(cp));
  const { checkpoints } = await admin.sandbox(box.id).listCheckpoints();
  assert.deepEqual(
    checkpoints.map((c) => c.id),
    [cp.id],
  );
  await box.writeFile(file, 'changed after the checkpoint\n');
  assert.equal(text((await box.readFile(file)).data), 'changed after the checkpoint\n');

  const restored = await admin.createSandbox({ name: 'e2e-restored', fromCheckpoint: cp.id });
  assert.equal(restored.row.state, 'READY');
  const seen = await harness.sandbox(restored.id).exec({ argv: ['cat', file] });
  assert.equal(seen.exitCode, 0, seen.stderr);
  assert.equal(seen.stdout, 'checkpointed by e2e\n', 'the restored sandbox sees the checkpoint');
  return restored;
}

test(
  'sdk lifecycle against a real engine: wb run, ask, checkpoint restore, destroy',
  { timeout: 300_000 },
  async () => {
    const srv = await bootServer();
    const { admin, harness, human, reader } = clients(srv.base);
    try {
      const sb = await admin.createSandbox({ name: 'e2e' });
      assert.equal(sb.row.state, 'READY');
      const box = harness.sandbox(sb.id);
      await checkRun(box, reader.sandbox(sb.id), srv.eng.config.paths.artifacts);
      await checkAsk(box, human, reader);
      const restored = await checkCheckpoint(admin, harness, box);

      for (const s of [restored, sb]) {
        assert.equal((await s.destroy()).state, 'DELETED');
        assert.equal((await reader.sandbox(s.id).inspect()).desired, 'DELETED');
      }
      assert.deepEqual((await reader.listSandboxes()).items, []);
    } finally {
      await srv.stop();
    }
  },
);

/** Nearest-rank percentile of an ascending array. */
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) };
}

async function timedCreate(client, name) {
  const t0 = performance.now();
  const sb = await client.createSandbox({ name });
  return { sb, ms: performance.now() - t0 };
}

/** Create `n` sandboxes at once; every create settles before any failure is thrown. */
async function createConcurrently(client, n) {
  const results = await Promise.allSettled(
    Array.from({ length: n }, (_v, i) => timedCreate(client, `density-${i}`)),
  );
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((r) => r.value);
}

function argvOf(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return [];
  }
}

function vmRssKiB(pid) {
  const m = /^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
  assert.ok(m, `VmRSS of pid ${pid}`);
  return Number(m[1]);
}

/** The runner's RSS and the cgroup's charged memory, read from the host. */
async function sampleMemory(view) {
  const { cgroup } = await view.inspect();
  const procs = fs
    .readFileSync(path.join(cgroup, 'cgroup.procs'), 'utf8')
    .split('\n')
    .filter(Boolean);
  const runners = procs.filter((pid) => argvOf(pid).includes(RUNNER_MAIN));
  assert.equal(runners.length, 1, `one runner in ${cgroup} (procs ${procs.join(' ')})`);
  return {
    runnerRssMiB: vmRssKiB(runners[0]) / 1024,
    cgroupMiB: Number(fs.readFileSync(path.join(cgroup, 'memory.current'), 'utf8')) / 2 ** 20,
  };
}

function revision() {
  try {
    const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
    const dirty = git(['status', '--porcelain', '--', '.', ':!docs/measurements.md']) !== '';
    return `${git(['rev-parse', 'HEAD'])}${dirty ? ' plus uncommitted working-tree changes' : ''}`;
  } catch {
    return 'unknown (git unavailable)';
  }
}

function hostRows(networkMode, load) {
  const cpus = os.cpus();
  return [
    ['Date', new Date().toISOString()],
    ['Revision', revision()],
    ['Kernel', `${os.type()} ${os.release()} ${os.arch()}`],
    ['CPUs', `${os.availableParallelism()} (${cpus[0]?.model?.trim() ?? 'unknown model'})`],
    ['Memory', `${(os.totalmem() / 2 ** 30).toFixed(1)} GiB`],
    ['Load average before the creates (1/5/15 min)', load.map((l) => l.toFixed(2)).join(' / ')],
    ['Node', process.version],
    ['Network mode', `${networkMode} (Manager network setup off)`],
  ];
}

function renderMeasurements(m) {
  const fmt = (x) => x.toFixed(1);
  const rows = (pairs) => pairs.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
  return `# Measurements

Recorded by test/e2e/lifecycle.test.js (density test): ${DENSITY} sandboxes created concurrently through the SDK against a real server, Manager and engine. These are recorded values, not thresholds; thresholds are an owner decision (spec req 7 ac_5).

## Host

| Field | Value |
|---|---|
${rows(m.host)}

## Results

Create-to-ready is the SDK \`createSandbox\` round trip until the server answers with the READY row. Runner RSS is VmRSS from /proc/<pid>/status of the runner process in each sandbox's cgroup; cgroup memory is that cgroup's memory.current. Both are sampled once with all ${DENSITY} sandboxes READY and idle. Percentiles are nearest-rank over the ${DENSITY} sandboxes.

| Metric | p50 | p95 | max |
|---|---|---|---|
| create-to-ready (ms) | ${Math.round(m.ready.p50)} | ${Math.round(m.ready.p95)} | ${Math.round(m.ready.max)} |
| runner RSS per sandbox (MiB) | ${fmt(m.rss.p50)} | ${fmt(m.rss.p95)} | ${fmt(m.rss.max)} |
| cgroup memory.current per sandbox (MiB) | ${fmt(m.cgroup.p50)} | ${fmt(m.cgroup.p95)} | ${fmt(m.cgroup.max)} |

Server process RSS (test process hosting server and Manager) at measurement: ${fmt(m.serverRssMiB)} MiB.
`;
}

test(
  `density: ${DENSITY} concurrent sdk creates, create-to-ready and per-sandbox RSS recorded`,
  { timeout: 600_000 },
  async () => {
    const srv = await bootServer();
    const { admin, reader } = clients(srv.base);
    try {
      const load = os.loadavg();
      const created = await createConcurrently(admin, DENSITY);
      assert.ok(created.every(({ sb }) => sb.row.state === 'READY'));
      const live = await reader.listSandboxes({ limit: 100 });
      assert.equal(live.items.length, DENSITY);
      assert.ok(live.items.every((s) => s.state === 'READY'));

      const samples = await Promise.all(
        created.map(({ sb }) => sampleMemory(reader.sandbox(sb.id))),
      );
      const serverRssMiB = process.memoryUsage().rss / 2 ** 20;
      await Promise.all(created.map(({ sb }) => sb.destroy()));
      assert.deepEqual((await reader.listSandboxes()).items, []);

      const body = renderMeasurements({
        host: hostRows(srv.eng.config.network.mode, load),
        ready: summary(created.map((c) => c.ms)),
        rss: summary(samples.map((s) => s.runnerRssMiB)),
        cgroup: summary(samples.map((s) => s.cgroupMiB)),
        serverRssMiB,
      });
      fs.mkdirSync(path.dirname(measurementsFile), { recursive: true });
      fs.writeFileSync(measurementsFile, body);
      assert.equal(fs.readFileSync(measurementsFile, 'utf8'), body);
    } finally {
      await srv.stop();
    }
  },
);
