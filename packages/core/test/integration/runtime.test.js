import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { RuntimeManager, DEFAULT_NODE_VERSION } from '../../src/host/runtime.js';
import { loadConfig } from '../../src/config.js';
import { tmpDir } from '../helpers/tmp.js';

/**
 * Installs the real runtime from the host cache: the official Node tarball plus the repo's
 * protocol, runner and wb packages, then exercises it exactly as a sandbox would.
 */
test('install from the cached tarball, run node and resolve @workbox/protocol from the runtime', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({ env: { WORKBOX_ROOT: dir } });
    const mgr = new RuntimeManager({ paths: cfg.paths, cacheDir: '/var/cache/workbox' });
    const m = await mgr.install();
    const root = mgr.dir(m.version);
    assert.equal(m.node.version, DEFAULT_NODE_VERSION);
    assert.match(m.node.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(m.packages).sort(), ['protocol', 'runner', 'wb']);
    assert.ok(m.packages.protocol.files >= 8);
    assert.match(m.digest, /^[a-f0-9]{64}$/);
    assert.ok(m.version.startsWith(`${DEFAULT_NODE_VERSION}-`));

    const node = path.join(root, 'node/bin/node');
    assert.equal(execFileSync(node, ['--version']).toString().trim(), `v${DEFAULT_NODE_VERSION}`);
    assert.ok(fs.existsSync(path.join(root, 'lib/protocol/src/index.js')));
    assert.ok(fs.existsSync(path.join(root, 'lib/protocol/package.json')));
    assert.equal(
      fs.readlinkSync(path.join(root, 'lib/runner/node_modules/@workbox/protocol')),
      '../../../protocol',
    );
    assert.equal(
      fs.readlinkSync(path.join(root, 'lib/wb/node_modules/@workbox/protocol')),
      '../../../protocol',
    );
    const probe = `import('@workbox/protocol').then((m) => console.log(typeof m.Peer, m.PROTOCOL_VERSION))`;
    assert.equal(
      execFileSync(node, ['--input-type=module', '-e', probe], {
        cwd: path.join(root, 'lib/runner'),
      })
        .toString()
        .trim(),
      'function 1',
    );
    assert.equal(
      execFileSync(node, ['--input-type=module', '-e', probe], { cwd: path.join(root, 'lib/wb') })
        .toString()
        .trim(),
      'function 1',
    );
    for (const bin of ['bin/wb', 'bin/init.sh']) {
      const st = fs.statSync(path.join(root, bin));
      assert.equal(st.mode & 0o777, 0o755, bin);
      assert.match(fs.readFileSync(path.join(root, bin), 'utf8'), /^#!\/bin\/sh\n/);
    }
    assert.match(
      fs.readFileSync(path.join(root, 'bin/init.sh'), 'utf8'),
      /setpriv --no-new-privs --bounding-set=/,
    );
    assert.equal(fs.statSync(path.join(root, 'lib/runner/package.json')).mode & 0o777, 0o644);
    assert.equal(
      fs.existsSync(path.join(root, 'lib/protocol/test')),
      false,
      'tests are not shipped',
    );

    assert.equal(fs.readlinkSync(mgr.currentPath), m.version);
    assert.deepEqual(mgr.isFresh(), { fresh: true, current: m, stale: [] });
    assert.equal((await mgr.ensureFresh()).version, m.version, 'fresh runtime is kept');
    assert.equal(mgr.current().version, m.version);
    assert.equal(mgr.require().version, m.version);
    assert.deepEqual(
      mgr.list().map((x) => x.version),
      [m.version],
    );
    await assert.rejects(mgr.install(), (e) => e.code === 'E_CONFLICT');

    const second = await mgr.install({ version: 'alt', setCurrent: false });
    assert.equal(second.version, 'alt');
    assert.equal(mgr.current().version, m.version);
    assert.equal(second.digest, m.digest, 'same inputs give the same tree digest');
    mgr.setCurrent('alt');
    assert.equal(mgr.current().version, 'alt');
    assert.throws(
      () => mgr.remove('alt'),
      (e) => e.code === 'E_STATE',
    );
    assert.equal(mgr.remove(m.version), true);
    assert.deepEqual(
      mgr.list().map((x) => x.version),
      ['alt'],
    );
    const copy = path.join(dir, 'repo-copy');
    for (const name of ['protocol', 'runner', 'wb'])
      fs.cpSync(path.join(mgr.repoRoot, 'packages', name), path.join(copy, 'packages', name), {
        recursive: true,
        filter: (p) => !p.includes('node_modules'),
      });
    const edited = new RuntimeManager({
      paths: cfg.paths,
      cacheDir: '/var/cache/workbox',
      repoRoot: copy,
    });
    fs.appendFileSync(path.join(copy, 'packages/wb/src/index.js'), '\n// edited\n');
    const state = edited.isFresh();
    assert.deepEqual(state.stale, ['wb']);
    const fresh = await edited.ensureFresh();
    assert.notEqual(fresh.version, 'alt');
    assert.equal(edited.current().version, fresh.version);
    assert.ok(edited.isFresh().fresh);
    edited.setCurrent('alt');
    const forced = await mgr.install({ version: 'alt', force: true });
    assert.equal(forced.version, 'alt');
    assert.deepEqual(
      fs.readdirSync(cfg.paths.runtime).filter((n) => n.startsWith('.') || n.endsWith('.tmp')),
      [],
      'no staging directory or lockfile is left',
    );
  } finally {
    cleanup();
  }
});

const RUNTIME_MODULE = new URL('../../src/host/runtime.js', import.meta.url).href;
const LOG_MODULE = new URL('../../src/log.js', import.meta.url).href;

/** A separate node process running ensureFresh on `runtimeDir` with an info logger on stderr. */
function ensureFreshProcess(runtimeDir) {
  const script = `import { RuntimeManager } from ${JSON.stringify(RUNTIME_MODULE)};
import { createLogger } from ${JSON.stringify(LOG_MODULE)};
const mgr = new RuntimeManager({
  paths: { runtime: process.argv[1] },
  cacheDir: '/var/cache/workbox',
  logger: createLogger({ level: 'info' }),
});
const m = await mgr.ensureFresh();
process.stdout.write(JSON.stringify({ version: m.version, createdAt: m.createdAt }));`;
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script, runtimeDir],
      { timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

test('two processes racing ensureFresh on a stale root install once and leave no staging behind', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const runtimeDir = path.join(dir, 'runtime');
    const [a, b] = await Promise.all([
      ensureFreshProcess(runtimeDir),
      ensureFreshProcess(runtimeDir),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const records = `${a.stderr}${b.stderr}`
      .split('\n')
      .filter((l) => l.startsWith('{'))
      .map((l) => JSON.parse(l));
    const count = (msg) => records.filter((r) => r.msg === msg).length;
    assert.equal(count('runtime stale, reinstalling'), 2, 'both processes found the root stale');
    assert.equal(count('extracting node'), 1, 'only one process staged an install');
    assert.equal(count('runtime installed'), 1);
    assert.equal(count('runtime installed by a concurrent installer'), 1, 'the other waited');
    const [ra, rb] = [JSON.parse(a.stdout), JSON.parse(b.stdout)];
    assert.deepEqual(ra, rb, 'both return the same finished install');
    const mgr = new RuntimeManager({
      paths: { runtime: runtimeDir },
      cacheDir: '/var/cache/workbox',
    });
    assert.equal(mgr.current().createdAt, ra.createdAt);
    assert.ok(mgr.isFresh().fresh);
    assert.deepEqual(
      fs.readdirSync(runtimeDir).sort(),
      ['current', ra.version].sort(),
      'no staging directory or lockfile is left',
    );
  } finally {
    cleanup();
  }
});
