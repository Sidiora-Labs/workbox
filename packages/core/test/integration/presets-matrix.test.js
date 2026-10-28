import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Manager } from '../../src/sandbox/manager.js';
import { Audit, auditFiles } from '../../src/audit.js';
import { expandHostSets } from '../../src/host/hostsets.js';
import { hostAllowed } from '../../src/host/proxy.js';
import { testEngine } from '../helpers/engine.js';

/**
 * req 4 ac_7 for the presets the python test does not install: each one is installed for real in
 * an egress sandbox, every tool's version command and a smoke script run in the box, and the
 * manifest is compared with the host store copy. The installs download hundreds of MB, so the
 * file runs only with WORKBOX_PRESET_MATRIX=1; a skip is "not run", never a pass.
 */

const MiB = 1024 * 1024;
const INSTALL_MS = 1_200_000;
const SMOKE_MS = 300_000;
const RUN = process.env.WORKBOX_PRESET_MATRIX === '1';
const SKIP = 'preset matrix not run (set WORKBOX_PRESET_MATRIX=1)';
const HEX = /^[0-9a-f]{64}$/;

const C_MAIN = String.raw`printf '%s\n' '#include <stdio.h>' 'int main(void){puts("c-ok");return 0;}' > /tmp/m.c`;
const GO_MAIN = String.raw`printf '%s\n' 'package main' 'import "fmt"' 'func main(){fmt.Println("go-ok")}' > main.go`;

const NODE_TOOLS = {
  node: { argv: ['node', '--version'], version: /^v22\.23\.4$/ },
  npm: { argv: ['npm', '--version'], version: /^\d+\.\d+\.\d+$/ },
};

/**
 * Per preset: host sets, tools in manifest order with the argv that prints each version, the
 * floating pins it resolves, the box memory, and a smoke script whose stdout must match.
 */
const MATRIX = {
  system: {
    hosts: ['@ubuntu'],
    resolved: {},
    memoryMiB: 2048,
    tools: {
      cc: { argv: ['cc', '--version'], version: /^cc \(Debian [^)]+\) \d+\.\d+\.\d+$/ },
      clang: { argv: ['clang', '--version'], version: /clang version \d+\.\d+\.\d+/ },
      cmake: { argv: ['cmake', '--version'], version: /^cmake version \d+\.\d+\.\d+$/ },
      'pkg-config': { argv: ['pkg-config', '--version'], version: /^\d+\.\d+(\.\d+)?$/ },
    },
    smoke: {
      script: `${C_MAIN} && cd /tmp && cc -o m-cc m.c && ./m-cc && clang -o m-clang m.c && ./m-clang && mkdir -p cm && printf '%s\\n' 'cmake_minimum_required(VERSION 3.10)' 'project(m C)' 'add_executable(m /tmp/m.c)' > cm/CMakeLists.txt && cmake -S cm -B cm/b >/dev/null && cmake --build cm/b >/dev/null && ./cm/b/m`,
      expect: /^c-ok\nc-ok\nc-ok$/,
    },
  },
  go: {
    hosts: ['@go'],
    resolved: { go: /^go\d+\.\d+(\.\d+)?$/ },
    memoryMiB: 2048,
    tools: {
      go: { argv: ['go', 'version'], version: /^go version go\d+\.\d+(\.\d+)? linux\/amd64$/ },
    },
    smoke: {
      script: `export HOME=/root GOTOOLCHAIN=local; mkdir -p /tmp/g && cd /tmp/g && ${GO_MAIN} && go mod init example.com/g 2>/dev/null && go run . && gofmt -w main.go && test -z "$(gofmt -l .)" && echo gofmt-ok`,
      expect: /^go-ok\ngofmt-ok$/,
    },
  },
  rust: {
    hosts: ['@rust'],
    resolved: { rust: /^\d+\.\d+\.\d+$/ },
    memoryMiB: 2048,
    tools: {
      rustc: { argv: ['rustc', '--version'], version: /^rustc \d+\.\d+\.\d+ / },
      cargo: { argv: ['cargo', '--version'], version: /^cargo \d+\.\d+\.\d+ / },
    },
    smoke: {
      script:
        'export HOME=/root; cd /tmp && cargo new --vcs none -q r && cd r && cargo check -q && echo rust-ok',
      expect: /^rust-ok$/,
    },
  },
  agents: {
    hosts: ['@node'],
    resolved: {},
    memoryMiB: 2048,
    tools: {
      ...NODE_TOOLS,
      claude: { argv: ['claude', '--version'], version: /\b2\.1\.312\b/ },
      codex: { argv: ['codex', '--version'], version: /\b0\.165\.0\b/ },
    },
    smoke: {
      script:
        'if printenv WORKBOX_HYPERFIDE_URL; then exit 9; fi; test ! -e /usr/local/bin/hyperfide && echo hyperfide-skipped',
      expect: /^hyperfide-skipped$/,
    },
  },
  web: {
    hosts: ['@node', '@browsers', '@ubuntu'],
    resolved: {},
    memoryMiB: 4096,
    tools: {
      ...NODE_TOOLS,
      pnpm: { argv: ['pnpm', '--version'], version: /^12\.15\.0$/ },
      bun: { argv: ['bun', '--version'], version: /^1\.4\.4$/ },
      playwright: { argv: ['playwright', '--version'], version: /^Version 1\.64\.1$/ },
      chromium: {
        argv: ['workbox-chromium', '--version'],
        version: /Chrom\S* .*\d+\.\d+\.\d+\.\d+/,
      },
    },
    smoke: {
      script:
        'export HOME=/root; bun -e \'console.log("bun-" + "ok")\' && workbox-chromium --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --user-data-dir=/tmp/chr --dump-dom "data:text/html,<p>chromium-ok</p>" 2>/dev/null | grep -o chromium-ok',
      expect: /^bun-ok\nchromium-ok$/,
    },
  },
};

const firstLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);

function boxOf(manager, id) {
  const exec = (argv, timeoutMs = 60_000) =>
    manager.exec(id, { argv, timeoutMs, maxOutputBytes: 64 * MiB });
  return {
    id,
    exec,
    sh: (script, timeoutMs) => exec(['sh', '-c', script], timeoutMs),
    /** `wb <args> --json`: exit code, the parsed last stdout line and stderr. */
    wb: async (args, timeoutMs) => {
      const r = await exec(['wb', ...args, '--json'], timeoutMs);
      return { ...r, json: JSON.parse(r.stdout.trim().split('\n').at(-1)) };
    },
  };
}

/** The in-box manifest bytes, asserted byte-for-byte equal to the host store's copy. */
async function manifestAgrees(box, eng, name) {
  const cat = await box.exec(['cat', `/var/lib/workbox-preset/${name}.json`]);
  assert.equal(cat.exitCode, 0, cat.stderr);
  const row = eng.store.listPresets(box.id).find((p) => p.name === name);
  assert.ok(row, 'the manifest is mirrored to the host store');
  assert.equal(cat.stdout, `${JSON.stringify(row.manifest, null, 2)}\n`);
  return { manifest: JSON.parse(cat.stdout), row, bytes: cat.stdout };
}

async function checkInstall(box, eng, name, spec) {
  const r = await box.wb(['preset', 'install', name], INSTALL_MS);
  assert.equal(r.exitCode, 0, `${JSON.stringify(r.json)}\n${r.stderr.slice(-6000)}`);
  assert.equal(r.json.status, 'ok');
  assert.equal(r.json.unchanged, false);
  const first = await manifestAgrees(box, eng, name);
  const { manifest } = first;
  assert.deepEqual(r.json.manifest, manifest);
  assert.equal(manifest.name, name);
  assert.equal(manifest.status, 'ok');
  assert.equal(manifest.failed, undefined);
  assert.deepEqual(manifest.hosts, spec.hosts);
  assert.match(manifest.recipe, HEX);
  assert.match(manifest.digest, HEX);
  assert.deepEqual(Object.keys(manifest.resolved), Object.keys(spec.resolved));
  for (const [key, re] of Object.entries(spec.resolved)) assert.match(manifest.resolved[key], re);
  assert.deepEqual(Object.keys(manifest.tools), Object.keys(spec.tools));
  return first;
}

/** Each tool's version command, run in the box, prints the recorded version; digests match. */
async function checkTools(box, manifest, spec) {
  for (const [name, want] of Object.entries(spec.tools)) {
    const t = manifest.tools[name];
    assert.match(t.version, want.version, `${name} version`);
    assert.match(t.sha256, HEX);
    const r = await box.exec(want.argv);
    assert.equal(r.exitCode, 0, `${name}: ${r.stderr}`);
    assert.equal(firstLine(r.stdout) ?? firstLine(r.stderr), t.version, `${name} runs`);
    const real = await box.sh(`readlink -f "$(command -v ${want.argv[0]})"`);
    assert.equal(real.stdout.trim(), t.path, `${name} path is the resolved file on PATH`);
    const sum = await box.exec(['sha256sum', t.path]);
    assert.equal(sum.exitCode, 0, sum.stderr);
    assert.equal(sum.stdout.split(/\s+/)[0], t.sha256, `${name} digest matches the file`);
  }
}

function auditOf(eng, sandboxId, action) {
  const dir = eng.config.paths.audit;
  assert.equal(Audit.verify(dir).ok, true);
  return auditFiles(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((e) => e.sandboxId === sandboxId && e.action === action);
}

/**
 * Every host the install reached through the proxy is in the preset's own host sets. Checked
 * before the smoke scripts run, so a browser's own background requests are not counted.
 */
function checkHosts(t, eng, id, manifest) {
  const allow = expandHostSets(manifest.hosts);
  const hosts = [...new Set(auditOf(eng, id, 'net.allow').map((e) => e.data.host))].sort();
  t.diagnostic(`hosts reached: ${hosts.join(' ')}`);
  const outside = hosts.filter((h) => !hostAllowed(h, allow));
  assert.deepEqual(outside, [], `hosts outside ${manifest.hosts.join(' ')}`);
}

async function checkReinstall(box, eng, name, first) {
  const r = await box.wb(['preset', 'install', name], INSTALL_MS);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.equal(r.json.unchanged, true, 're-install is a no-op');
  const again = await manifestAgrees(box, eng, name);
  assert.equal(again.bytes, first.bytes, 'identical manifest bytes after re-install');
  assert.deepEqual(again.row, first.row, 'the host row is untouched');
}

async function matrixRun(t, name) {
  const spec = MATRIX[name];
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
  let id;
  try {
    const sb = await manager.create({
      name: `matrix${name}`,
      profile: {
        network: { mode: 'egress' },
        limits: { memoryBytes: spec.memoryMiB * MiB, pids: 1024 },
      },
    });
    id = sb.id;
    const box = boxOf(manager, id);
    const first = await checkInstall(box, eng, name, spec);
    const versions = Object.entries(first.manifest.tools).map(([k, v]) => `${k}=${v.version}`);
    t.diagnostic(
      `${name} resolved ${JSON.stringify(first.manifest.resolved)}; ${versions.join('; ')}`,
    );
    checkHosts(t, eng, id, first.manifest);
    await checkTools(box, first.manifest, spec);
    const smoke = await box.sh(spec.smoke.script, SMOKE_MS);
    assert.equal(smoke.exitCode, 0, `${smoke.stdout}\n${smoke.stderr.slice(-4000)}`);
    assert.match(smoke.stdout.trim(), spec.smoke.expect);
    await checkReinstall(box, eng, name, first);
  } finally {
    if (id) await manager.destroy(id, { timeoutMs: 10_000 }).catch(() => undefined);
    manager.close();
    await eng.cleanup();
  }
}

for (const name of Object.keys(MATRIX))
  test(
    `req 4 ac_7: preset ${name} installs and its tools run in a real sandbox with egress; the manifest is mirrored to the host`,
    { skip: RUN ? false : SKIP, timeout: INSTALL_MS * 2 },
    (t) => matrixRun(t, name),
  );
