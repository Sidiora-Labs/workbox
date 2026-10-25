import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
    const forced = await mgr.install({ version: 'alt', force: true });
    assert.equal(forced.version, 'alt');
    assert.equal(fs.existsSync(`${root}.tmp`), false);
  } finally {
    cleanup();
  }
});
