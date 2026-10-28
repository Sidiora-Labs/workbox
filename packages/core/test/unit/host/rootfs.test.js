import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  RootfsManager,
  shiftOwnership,
  digestTree,
  sha256File,
  ROOTFS_MANIFEST,
  BUILTIN_ROOTFS_DIR,
} from '../../../src/host/rootfs.js';
import { withLockFile, lockPathFor } from '../../../src/host/safefs.js';
import { tmpDir } from '../../helpers/tmp.js';

const BASE = 200000;

function tree(dir) {
  fs.mkdirSync(path.join(dir, 'usr/bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'usr/bin/passwd'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'usr/bin/passwd'), 0o4755);
  fs.writeFileSync(path.join(dir, 'usr/bin/plain'), 'x');
  fs.chmodSync(path.join(dir, 'usr/bin/plain'), 0o755);
  fs.mkdirSync(path.join(dir, 'etc'));
  fs.writeFileSync(path.join(dir, 'etc/shadow'), 'root:*\n', { mode: 0o640 });
  fs.symlinkSync('../usr/bin/plain', path.join(dir, 'etc/link'));
  fs.mkdirSync(path.join(dir, 'var/tmp'), { recursive: true });
  fs.chmodSync(path.join(dir, 'var/tmp'), 0o1777);
}

test('shiftOwnership moves every inode into the range, keeps setuid/sgid/sticky bits and is idempotent', () => {
  const { dir, cleanup } = tmpDir();
  try {
    tree(dir);
    const first = shiftOwnership(dir, BASE);
    assert.equal(first.inodes, 10);
    assert.equal(first.setuid, 1);
    const passwd = fs.lstatSync(path.join(dir, 'usr/bin/passwd'));
    assert.equal(passwd.uid, BASE);
    assert.equal(passwd.gid, BASE);
    assert.equal(passwd.mode & 0o7777, 0o4755);
    assert.equal(fs.lstatSync(path.join(dir, 'etc/link')).uid, BASE);
    assert.equal(fs.lstatSync(path.join(dir, 'etc/shadow')).mode & 0o7777, 0o640);
    assert.equal(fs.lstatSync(path.join(dir, 'var/tmp')).mode & 0o7777, 0o1777);
    assert.equal(fs.lstatSync(dir).uid, BASE);
    const second = shiftOwnership(dir, BASE);
    assert.equal(second.setuid, 0);
    assert.equal(fs.lstatSync(path.join(dir, 'usr/bin/passwd')).uid, BASE);
  } finally {
    cleanup();
  }
});

test('digestTree is deterministic, owner- and mode-sensitive, content-sensitive and mtime-insensitive', () => {
  const { dir, cleanup } = tmpDir();
  try {
    tree(dir);
    shiftOwnership(dir, BASE);
    const a = digestTree(dir, BASE);
    assert.equal(a.files, 9);
    assert.equal(a.bytes, fs.statSync(path.join(dir, 'usr/bin/passwd')).size + 1 + 7);
    fs.utimesSync(path.join(dir, 'usr/bin/plain'), 1, 1);
    assert.equal(digestTree(dir, BASE).digest, a.digest);
    fs.writeFileSync(path.join(dir, ROOTFS_MANIFEST), '{}');
    assert.equal(digestTree(dir, BASE).digest, a.digest);
    assert.notEqual(digestTree(dir, BASE, { exclude: ['etc/shadow'] }).digest, a.digest);
    fs.chmodSync(path.join(dir, 'usr/bin/plain'), 0o700);
    const b = digestTree(dir, BASE);
    assert.notEqual(b.digest, a.digest);
    fs.chmodSync(path.join(dir, 'usr/bin/plain'), 0o755);
    assert.equal(digestTree(dir, BASE).digest, a.digest);
    fs.appendFileSync(path.join(dir, 'usr/bin/plain'), 'y');
    assert.notEqual(digestTree(dir, BASE).digest, a.digest);
    fs.writeFileSync(path.join(dir, 'usr/bin/plain'), 'x');
    assert.equal(digestTree(dir, BASE).digest, a.digest);
    fs.lchownSync(path.join(dir, 'etc/shadow'), BASE + 5, BASE);
    assert.notEqual(digestTree(dir, BASE).digest, a.digest);
    fs.lchownSync(path.join(dir, 'etc/shadow'), BASE, BASE);
    fs.unlinkSync(path.join(dir, 'etc/link'));
    fs.symlinkSync('../usr/bin/passwd', path.join(dir, 'etc/link'));
    fs.lchownSync(path.join(dir, 'etc/link'), BASE, BASE);
    assert.notEqual(digestTree(dir, BASE).digest, a.digest);
    assert.equal(digestTree(dir, 0).digest !== a.digest, true);
    const expected = createHash('sha256').update('#!/bin/sh\n').digest('hex');
    assert.equal(sha256File(path.join(dir, 'usr/bin/passwd')), expected);
  } finally {
    cleanup();
  }
});

test('manager validates names, reports missing builds and surfaces docker failures', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const mgr = new RootfsManager({
      paths: { rootfs: path.join(dir, 'rootfs') },
      uid: { base: BASE, count: 65536 },
      docker: 'definitely-not-docker',
    });
    assert.throws(
      () => mgr.dir('../x'),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    assert.equal(mgr.get('minimal'), null);
    assert.deepEqual(mgr.list(), []);
    assert.throws(
      () => mgr.require('minimal'),
      (e) => e.code === 'E_NOT_FOUND' && /workbox rootfs build minimal/.test(e.data.remedy),
    );
    assert.equal(mgr.remove('minimal'), false);
    await assert.rejects(
      mgr.build('nothere'),
      (e) => e.code === 'E_NOT_FOUND' && /Dockerfile/.test(e.message),
    );
    assert.ok(fs.existsSync(path.join(BUILTIN_ROOTFS_DIR, 'minimal/Dockerfile')));
    await assert.rejects(
      mgr.build('minimal'),
      (e) => e.code === 'E_UNAVAILABLE' && /definitely-not-docker/.test(e.message),
    );
    assert.equal(fs.existsSync(path.join(dir, 'rootfs/minimal.tmp')), false);
    fs.mkdirSync(path.join(dir, 'rootfs/minimal'), { recursive: true });
    await assert.rejects(mgr.build('minimal'), (e) => e.code === 'E_CONFLICT');
    fs.mkdirSync(path.join(dir, 'rootfs/stale.tmp'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'rootfs/minimal', ROOTFS_MANIFEST),
      JSON.stringify({ name: 'minimal', digest: 'd' }),
    );
    assert.deepEqual(
      mgr.list().map((m) => m.name),
      ['minimal'],
    );
    assert.equal(mgr.remove('minimal'), true);
    await assert.rejects(mgr._docker(['version']), (e) => e.code === 'E_UNAVAILABLE');
    const real = new RootfsManager({
      paths: { rootfs: path.join(dir, 'rootfs') },
      uid: { base: BASE, count: 65536 },
      docker: 'sh',
    });
    await assert.rejects(
      real._docker(['-c', 'echo boom >&2; exit 7']),
      (e) => e.code === 'E_UNAVAILABLE' && /boom/.test(e.message) && e.data.code === 7,
    );
    assert.equal((await real._docker(['-c', 'echo hi'])).trim(), 'hi');
    await assert.rejects(
      real._docker(['-c', 'sleep 5'], { timeoutMs: 50 }),
      (e) => e.data.signal === 'SIGKILL',
    );
  } finally {
    cleanup();
  }
});

test('list returns every built rootfs sorted by name, skipping unbuilt and staging dirs', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const mgr = new RootfsManager({
      paths: { rootfs: path.join(dir, 'rootfs') },
      uid: { base: BASE, count: 65536 },
    });
    for (const name of ['zeta', 'mid', 'alpha']) {
      fs.mkdirSync(mgr.dir(name), { recursive: true });
      fs.writeFileSync(path.join(mgr.dir(name), ROOTFS_MANIFEST), JSON.stringify({ name }));
    }
    fs.mkdirSync(mgr.dir('unbuilt'));
    fs.mkdirSync(path.join(dir, 'rootfs/beta.tmp'));
    fs.writeFileSync(path.join(dir, 'rootfs/beta.tmp', ROOTFS_MANIFEST), '{"name":"beta"}');
    fs.mkdirSync(path.join(dir, 'rootfs/.gamma.staging-Ab12Cd'));
    fs.writeFileSync(path.join(dir, 'rootfs/.gamma.staging-Ab12Cd', ROOTFS_MANIFEST), '{}');
    assert.deepEqual(
      mgr.list().map((m) => m.name),
      ['alpha', 'mid', 'zeta'],
    );
  } finally {
    cleanup();
  }
});

test('remove goes through removeUnder: a rootfs that is a link out of the root is only unlinked', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, ROOTFS_MANIFEST), JSON.stringify({ name: 'evil' }));
    const root = path.join(dir, 'rootfs');
    fs.mkdirSync(root);
    fs.symlinkSync(outside, path.join(root, 'evil'));
    const mgr = new RootfsManager({ paths: { rootfs: root }, uid: { base: BASE, count: 65536 } });
    assert.equal(mgr.remove('evil'), true);
    assert.equal(fs.existsSync(path.join(root, 'evil')), false);
    assert.ok(fs.existsSync(path.join(outside, ROOTFS_MANIFEST)), 'the link target is untouched');
  } finally {
    cleanup();
  }
});

test('concurrent builds serialise on the lock; a waiter returns the build finished meanwhile', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const root = path.join(dir, 'rootfs');
    const mgr = new RootfsManager({
      paths: { rootfs: root },
      uid: { base: BASE, count: 65536 },
      docker: 'definitely-not-docker',
    });
    const failed = await Promise.allSettled([mgr.build('minimal'), mgr.build('minimal')]);
    for (const r of failed) assert.equal(r.reason?.code, 'E_UNAVAILABLE');
    assert.deepEqual(fs.readdirSync(root), [], 'no staging directory or lockfile is left');

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const holder = withLockFile(lockPathFor(root, 'minimal'), () => gate);
    const waiter = mgr.build('minimal');
    await sleep(100);
    const finished = {
      schema: 1,
      name: 'minimal',
      digest: 'd'.repeat(64),
      createdAt: Date.now(),
      source: { dockerfileSha256: sha256File(path.join(BUILTIN_ROOTFS_DIR, 'minimal/Dockerfile')) },
    };
    fs.mkdirSync(path.join(root, 'minimal'));
    fs.writeFileSync(path.join(root, 'minimal', ROOTFS_MANIFEST), JSON.stringify(finished));
    release();
    await holder;
    assert.deepEqual(await waiter, finished, 'returned without running docker again');
    assert.deepEqual(fs.readdirSync(root), ['minimal']);
    await assert.rejects(mgr.build('minimal'), (e) => e.code === 'E_CONFLICT');
  } finally {
    cleanup();
  }
});
