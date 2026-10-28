import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Manager } from '../../src/sandbox/manager.js';
import { Audit, auditFiles } from '../../src/audit.js';
import { testEngine } from '../helpers/engine.js';

const MiB = 1024 * 1024;
const MANIFEST = '/var/lib/workbox-preset/python.json';
const INSTALL_MS = 900_000;
const FAST_MS = 10_000;

function boxOf(manager, id) {
  const exec = (argv, timeoutMs = 60_000) => manager.exec(id, { argv, timeoutMs });
  return {
    id,
    exec,
    sh: (script) => exec(['sh', '-c', script]),
    /** `wb <args> --json`: exit code, the parsed last stdout line, stderr and wall time. */
    wb: async (args, timeoutMs) => {
      const started = Date.now();
      const r = await exec(['wb', ...args, '--json'], timeoutMs);
      const ms = Date.now() - started;
      return { ...r, ms, json: JSON.parse(r.stdout.trim().split('\n').at(-1)) };
    },
  };
}

const hostRow = (eng, id) => eng.store.listPresets(id).find((p) => p.name === 'python');
const policyOf = (eng, id) => JSON.stringify(eng.store.getSandbox(id).profile.network);

function auditOf(eng, sandboxId, action) {
  const dir = eng.config.paths.audit;
  assert.equal(Audit.verify(dir).ok, true);
  return auditFiles(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((e) => e.sandboxId === sandboxId && e.action === action);
}

/** The in-box manifest bytes, asserted byte-for-byte equal to the host store's copy. */
async function manifestAgrees(box, eng) {
  const cat = await box.exec(['cat', MANIFEST]);
  assert.equal(cat.exitCode, 0, cat.stderr);
  const row = hostRow(eng, box.id);
  assert.ok(row, 'the manifest is mirrored to the host store');
  assert.equal(cat.stdout, `${JSON.stringify(row.manifest, null, 2)}\n`);
  return { manifest: JSON.parse(cat.stdout), row, bytes: cat.stdout };
}

async function noManifest(box, eng) {
  const r = await box.sh(`test ! -e ${MANIFEST}`);
  assert.equal(r.exitCode, 0, 'no in-box manifest was written');
  assert.equal(hostRow(eng, box.id), undefined, 'nothing mirrored to the host store');
}

async function checkListAndUnknown(box) {
  const list = await box.wb(['preset', 'list']);
  assert.equal(list.exitCode, 0, list.stderr);
  assert.deepEqual(
    list.json.presets.map((p) => p.name),
    ['agents', 'go', 'python', 'rust', 'system', 'web'],
  );
  const python = list.json.presets.find((p) => p.name === 'python');
  assert.deepEqual(python.hosts, ['@python', '@github']);
  const unknown = await box.wb(['preset', 'install', 'nope']);
  assert.equal(unknown.exitCode, 3);
  assert.equal(unknown.json.error.code, 'E_NOT_FOUND');
  assert.match(unknown.json.error.message, /unknown preset nope/);
}

async function checkNone(box, eng) {
  const r = await box.wb(['preset', 'install', 'python']);
  assert.equal(r.exitCode, 4, r.stderr);
  assert.equal(r.json.error.code, 'E_DENIED');
  assert.equal(r.json.error.data.reason, 'network-none');
  assert.ok(r.ms < FAST_MS, `fails fast: ${r.ms} ms`);
  await noManifest(box, eng);
}

async function checkAllowlistMissingSet(box, eng) {
  const before = policyOf(eng, box.id);
  assert.deepEqual(JSON.parse(before).allow, ['@python']);
  const expanded = await box.wb(['net', 'test', 'pypi.org', '443']);
  assert.equal(expanded.exitCode, 0, expanded.stderr);
  assert.equal(expanded.json.allowed, true, '@python expands to pypi.org in the proxy policy');
  const outside = await box.wb(['net', 'test', 'github.com', '443']);
  assert.equal(outside.json.allowed, false);
  assert.equal(outside.json.reason, 'not-allowlisted');

  const r = await box.wb(['preset', 'install', 'python']);
  assert.equal(r.exitCode, 4, r.stderr);
  assert.equal(r.json.error.code, 'E_DENIED');
  assert.equal(r.json.error.data.reason, 'host-set-missing');
  assert.deepEqual(r.json.error.data.missing, ['@github']);
  assert.match(r.json.error.message, /@github/);
  assert.ok(r.ms < FAST_MS, `fails fast: ${r.ms} ms`);
  await noManifest(box, eng);
  assert.equal(policyOf(eng, box.id), before, 'the stored policy is unchanged');
  const policy = await box.wb(['net', 'policy']);
  assert.deepEqual(policy.json.allow, ['@python']);
}

async function checkStepFailure(box, eng) {
  const obstacle = await box.sh('mkdir -p /usr/local/bin/python3');
  assert.equal(obstacle.exitCode, 0, obstacle.stderr);
  const r = await box.wb(['preset', 'install', 'python'], INSTALL_MS);
  assert.equal(r.exitCode, 4, r.stderr);
  assert.equal(r.json.error.code, 'E_UNAVAILABLE');
  const { manifest } = await manifestAgrees(box, eng);
  assert.equal(manifest.status, 'failed', 'a failed step records failed, not ok');
  assert.equal(manifest.failed.step, 1);
  assert.deepEqual(manifest.failed.tools, ['python3']);
  assert.notEqual(manifest.failed.exitCode, 0);
  assert.deepEqual(Object.keys(manifest.tools), ['uv']);
  assert.match(manifest.tools.uv.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.json.error.data.failed, manifest.failed);
  const removed = await box.sh('rmdir /usr/local/bin/python3');
  assert.equal(removed.exitCode, 0, removed.stderr);
}

async function checkDigests(box, manifest) {
  for (const [name, t] of Object.entries(manifest.tools)) {
    const sum = await box.exec(['sha256sum', t.path]);
    assert.equal(sum.exitCode, 0, sum.stderr);
    assert.equal(sum.stdout.split(/\s+/)[0], t.sha256, `${name} digest matches the file`);
    const real = await box.exec(['readlink', '-f', `/usr/local/bin/${name}`]);
    assert.equal(real.stdout.trim(), t.path, `${name} path is the resolved file`);
  }
}

async function checkInstall(box, eng) {
  const r = await box.wb(['preset', 'install', 'python'], INSTALL_MS);
  assert.equal(r.exitCode, 0, r.stderr.slice(-4000));
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.unchanged, false);
  const { manifest, row, bytes } = await manifestAgrees(box, eng);
  assert.deepEqual(r.json.manifest, manifest);
  assert.equal(manifest.name, 'python');
  assert.equal(manifest.status, 'ok');
  assert.equal(manifest.failed, undefined);
  assert.deepEqual(manifest.hosts, ['@python', '@github']);
  assert.deepEqual(manifest.resolved, {});
  assert.match(manifest.recipe, /^[0-9a-f]{64}$/);
  assert.match(manifest.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(manifest.tools), ['uv', 'python3']);
  assert.match(manifest.tools.uv.version, /^uv 0\.13\.6\b/);
  assert.match(manifest.tools.python3.version, /^Python 3\.12\.\d+$/);
  await checkDigests(box, manifest);

  const uv = await box.exec(['uv', '--version']);
  assert.equal(uv.exitCode, 0, uv.stderr);
  assert.equal(uv.stdout.trim(), manifest.tools.uv.version);
  const py = await box.exec([
    'python3',
    '-c',
    'import sys, json; print(json.dumps(sys.version_info[:2]))',
  ]);
  assert.equal(py.exitCode, 0, py.stderr);
  assert.equal(py.stdout.trim(), '[3, 12]');
  const venv = await box.sh('uv venv -q -p /usr/local/bin/python3 /tmp/v && /tmp/v/bin/python -V');
  assert.equal(venv.exitCode, 0, venv.stderr);
  assert.equal(venv.stdout.trim(), manifest.tools.python3.version);
  return { bytes, row };
}

async function checkReinstall(box, eng, first) {
  const r = await box.wb(['preset', 'install', 'python'], INSTALL_MS);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.unchanged, true, 're-install is a no-op');
  const { bytes, row } = await manifestAgrees(box, eng);
  assert.equal(bytes, first.bytes, 'identical manifest bytes after re-install');
  assert.deepEqual(row, first.row, 'the host row is untouched');
  assert.deepEqual(
    auditOf(eng, box.id, 'preset.manifest').map((e) => e.data.status),
    ['failed', 'ok'],
  );
}

test('presets: python in a real sandbox with egress, mirrored to the host; network gates', async (t) => {
  const eng = await testEngine({ network: 'none' });
  const manager = new Manager({
    config: eng.config,
    store: eng.store,
    audit: eng.audit,
    cgroups: eng.cgroups,
    rootfs: eng.rootfs,
    runtime: eng.runtime,
    logger: eng.logger,
  });
  const ids = [];
  const create = async (name, network, memoryMiB = 256) => {
    const sb = await manager.create({
      name,
      profile: { network, limits: { memoryBytes: memoryMiB * MiB, pids: 512 } },
    });
    ids.push(sb.id);
    return boxOf(manager, sb.id);
  };
  try {
    const none = await create('presetnone', { mode: 'none' });
    await t.test('req 4 ac_7: wb preset list; unknown preset is a coded error', () =>
      checkListAndUnknown(none),
    );
    await t.test('network none: preset install fails fast with the network code', () =>
      checkNone(none, eng),
    );
    const allow = await create('presetallow', { mode: 'allowlist', allow: ['@python'] });
    await t.test('allowlist without @github: fast failure naming the set, policy unchanged', () =>
      checkAllowlistMissingSet(allow, eng),
    );
    const egress = await create('presetegress', { mode: 'egress' }, 2048);
    const policy = policyOf(eng, egress.id);
    await t.test('a failed step records failed, mirrored to the host', () =>
      checkStepFailure(egress, eng),
    );
    let first;
    await t.test('req 4 ac_7: python installs; manifest in-box equals the host store', async () => {
      first = await checkInstall(egress, eng);
    });
    await t.test('re-install is a no-op with an identical manifest', () =>
      checkReinstall(egress, eng, first),
    );
    await t.test('an in-box install never changes the stored policy', async () => {
      assert.equal(policyOf(eng, egress.id), policy);
      assert.equal((await egress.wb(['net', 'policy'])).json.mode, 'egress');
    });
  } finally {
    for (const id of ids) await manager.destroy(id, { timeoutMs: 10_000 }).catch(() => undefined);
    manager.close();
    await eng.cleanup();
  }
});
