import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RootfsManager } from '../../src/host/rootfs.js';
import { loadConfig } from '../../src/config.js';
import { tmpDir } from '../helpers/tmp.js';

/**
 * Builds the real minimal rootfs with Docker into a temporary Workbox root. The first build pulls
 * packages; the forced rebuild hits Docker's layer cache and must reproduce the digest exactly.
 */
test('build minimal: exported, uid-shifted, setuid preserved, digest stable on rebuild', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({ env: { WORKBOX_ROOT: dir } });
    const mgr = new RootfsManager({ paths: cfg.paths, uid: cfg.uid });
    const m = await mgr.build('minimal');
    const root = mgr.dir('minimal');
    assert.equal(m.name, 'minimal');
    assert.equal(m.schema, 1);
    assert.match(m.digest, /^[a-f0-9]{64}$/);
    assert.ok(m.files > 2000, `files ${m.files}`);
    assert.ok(m.bytes > 50 * 1024 * 1024, `bytes ${m.bytes}`);
    assert.equal(m.uid.base, cfg.uid.base);
    assert.match(m.source.imageId, /^sha256:/);
    assert.ok(m.shifted.setuid >= 3, `setuid files ${m.shifted.setuid}`);
    assert.ok(fs.existsSync(path.join(root, 'manifest.json')));

    for (const rel of [
      'bin/bash',
      'usr/bin/setpriv',
      'usr/bin/curl',
      'usr/bin/git',
      'usr/bin/jq',
      'etc/profile.d/workbox.sh',
      'opt/workbox',
      'run/workbox',
      'var/lib/workbox-preset',
      'workspace',
    ]) {
      assert.ok(fs.existsSync(path.join(root, rel)), rel);
    }
    const passwd = fs.statSync(path.join(root, 'usr/bin/passwd'));
    assert.equal(passwd.uid, cfg.uid.base);
    assert.equal(passwd.mode & 0o4000, 0o4000, 'setuid bit kept on passwd');
    const shadow = fs.statSync(path.join(root, 'etc/shadow'));
    assert.equal(shadow.gid, cfg.uid.base + 42, 'shadow group shifted');
    assert.equal(fs.statSync(root).uid, cfg.uid.base);
    assert.equal(
      fs.readFileSync(path.join(root, 'etc/profile.d/workbox.sh'), 'utf8'),
      'export PATH="/opt/workbox/bin:$PATH"\n',
    );
    assert.equal(
      fs.readFileSync(path.join(root, 'etc/hostname'), 'utf8'),
      '',
      'docker-managed files export empty and are provided at launch',
    );
    assert.equal(fs.existsSync(path.join(root, 'var/lib/apt/lists/debian.org')), false);

    await assert.rejects(mgr.build('minimal'), (e) => e.code === 'E_CONFLICT');
    const again = await mgr.build('minimal', { force: true });
    assert.equal(again.digest, m.digest);
    assert.equal(again.files, m.files);
    assert.deepEqual(
      mgr.list().map((x) => x.name),
      ['minimal'],
    );
    assert.equal(mgr.require('minimal').digest, m.digest);
    assert.equal(fs.existsSync(`${root}.tmp`), false);
    assert.equal(mgr.remove('minimal'), true);
    assert.equal(mgr.get('minimal'), null);
  } finally {
    cleanup();
  }
});

test('export of a missing container reports docker’s error and extracts nothing', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({ env: { WORKBOX_ROOT: dir } });
    const mgr = new RootfsManager({ paths: cfg.paths, uid: cfg.uid });
    const into = path.join(dir, 'into');
    fs.mkdirSync(into);
    await assert.rejects(
      mgr._exportInto(`workbox-missing-${process.pid}`, into),
      (e) =>
        e.code === 'E_UNAVAILABLE' &&
        /^docker export failed: .*No such container/.test(e.message) &&
        e.data.code === 1,
    );
    assert.deepEqual(fs.readdirSync(into), []);
  } finally {
    cleanup();
  }
});
