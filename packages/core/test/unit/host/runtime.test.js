import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  RuntimeManager,
  expectedSha,
  digestPackage,
  shippableFiles,
  makeWorldReadable,
  extractTarXz,
  RUNTIME_PACKAGES,
  REPO_ROOT,
  DEFAULT_NODE_VERSION,
} from '../../../src/host/runtime.js';
import { tmpDir } from '../../helpers/tmp.js';

const CACHE = '/var/cache/workbox';
const TARBALL = path.join(CACHE, `node-v${DEFAULT_NODE_VERSION}-linux-x64.tar.xz`);
const SHASUMS = path.join(CACHE, `SHASUMS256-v${DEFAULT_NODE_VERSION}.txt`);

test('expectedSha, shippableFiles, digestPackage and makeWorldReadable', () => {
  const sums = `${'a'.repeat(64)}  node-v1.0.0-linux-x64.tar.xz\n${'b'.repeat(64)}  node-v1.0.0-linux-arm64.tar.xz\nnot-a-sha node-v1.0.0-win.zip\n`;
  assert.equal(expectedSha(sums, 'node-v1.0.0-linux-x64.tar.xz'), 'a'.repeat(64));
  assert.throws(
    () => expectedSha(sums, 'node-v1.0.0-win.zip'),
    (e) => e.code === 'E_NOT_FOUND',
  );
  const { dir, cleanup } = tmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x","version":"1.2.3"}');
    fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/index.js'), 'export {}');
    fs.writeFileSync(path.join(dir, 'src/deep/a.js'), '1');
    fs.mkdirSync(path.join(dir, 'bin'));
    fs.writeFileSync(path.join(dir, 'bin/tool'), '#!/bin/sh\n', { mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test/ignored.test.js'), 'x');
    fs.writeFileSync(path.join(dir, 'README.md'), 'ignored');
    assert.deepEqual(shippableFiles(dir), [
      'bin/tool',
      'package.json',
      'src/deep/a.js',
      'src/index.js',
    ]);
    const d1 = digestPackage(dir);
    assert.equal(d1.files, 4);
    fs.writeFileSync(path.join(dir, 'test/ignored.test.js'), 'changed');
    assert.equal(digestPackage(dir).digest, d1.digest);
    fs.writeFileSync(path.join(dir, 'src/deep/a.js'), '2');
    assert.notEqual(digestPackage(dir).digest, d1.digest);
    fs.chmodSync(path.join(dir, 'src/index.js'), 0o600);
    fs.chmodSync(path.join(dir, 'src'), 0o700);
    fs.symlinkSync('src/index.js', path.join(dir, 'link'));
    makeWorldReadable(dir);
    assert.equal(fs.statSync(path.join(dir, 'src')).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(dir, 'src/index.js')).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(dir, 'bin/tool')).mode & 0o777, 0o755);
    assert.ok(fs.lstatSync(path.join(dir, 'link')).isSymbolicLink());
  } finally {
    cleanup();
  }
});

test('manager validation, lookups on an empty root, bad tarballs and checksum mismatch', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const mgr = new RuntimeManager({
      paths: { runtime: path.join(dir, 'runtime') },
      cacheDir: CACHE,
    });
    assert.equal(mgr.repoRoot, REPO_ROOT);
    assert.deepEqual(RUNTIME_PACKAGES, ['protocol', 'runner', 'wb']);
    assert.throws(
      () => mgr.dir('bad/version'),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    assert.equal(mgr.get('v1'), null);
    assert.equal(mgr.current(), null);
    assert.deepEqual(mgr.list(), []);
    assert.throws(
      () => mgr.require(),
      (e) => e.code === 'E_NOT_FOUND' && e.data.remedy === 'workbox runtime install',
    );
    assert.throws(
      () => mgr.require('v1'),
      (e) => e.code === 'E_NOT_FOUND',
    );
    assert.throws(
      () => mgr.setCurrent('v1'),
      (e) => e.code === 'E_NOT_FOUND',
    );
    assert.equal(mgr.remove('v1'), false);
    await assert.rejects(
      mgr.install({ nodeTarball: path.join(dir, 'missing.tar.xz') }),
      (e) => e.code === 'E_NOT_FOUND',
    );
    const wrongSums = path.join(dir, 'sums.txt');
    fs.writeFileSync(
      wrongSums,
      `${'0'.repeat(64)}  node-v${DEFAULT_NODE_VERSION}-linux-x64.tar.xz\n`,
    );
    await assert.rejects(
      mgr.install({ nodeTarball: TARBALL, shasums: wrongSums }),
      (e) => e.code === 'E_CONFLICT' && e.data.expected === '0'.repeat(64),
    );
    assert.equal(fs.existsSync(path.join(dir, 'runtime')), false);
    const bad = path.join(dir, 'bad.tar.xz');
    fs.writeFileSync(bad, 'not a tarball');
    fs.mkdirSync(path.join(dir, 'out'));
    await assert.rejects(
      extractTarXz(bad, path.join(dir, 'out')),
      (e) => e.code === 'E_UNAVAILABLE',
    );
  } finally {
    cleanup();
  }
});

test('runtime packages with external dependencies are refused and downloads are checked', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const repo = path.join(dir, 'repo');
    for (const name of RUNTIME_PACKAGES) {
      fs.mkdirSync(path.join(repo, 'packages', name, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'packages', name, 'src/index.js'), 'export {}');
      fs.writeFileSync(
        path.join(repo, 'packages', name, 'package.json'),
        JSON.stringify({
          name: `@workbox/${name}`,
          version: '0.0.1',
          dependencies: name === 'wb' ? { leftpad: '1.0.0' } : {},
        }),
      );
    }
    const mgr = new RuntimeManager({
      paths: { runtime: path.join(dir, 'runtime') },
      cacheDir: path.join(dir, 'cache'),
      repoRoot: repo,
      fetch: async (url) => new Response(null, { status: 404, statusText: `missing ${url}` }),
    });
    await assert.rejects(
      mgr.install({ nodeVersion: '0.0.0' }),
      (e) => e.code === 'E_UNAVAILABLE' && e.data.status === 404,
    );
    assert.deepEqual(
      fs.readdirSync(path.join(dir, 'cache')).filter((n) => n.endsWith('.part')),
      [],
      'no download staging file is left',
    );
    assert.deepEqual(mgr.isFresh(), {
      fresh: false,
      current: null,
      stale: ['protocol', 'runner', 'wb'],
    });
    const served = new RuntimeManager({
      paths: { runtime: path.join(dir, 'runtime') },
      cacheDir: path.join(dir, 'cache'),
      repoRoot: repo,
      fetch: async (url) =>
        new Response(url.endsWith('.txt') ? fs.readFileSync(SHASUMS) : fs.readFileSync(TARBALL)),
    });
    await assert.rejects(
      served.install(),
      (e) => e.code === 'E_UNSUPPORTED' && e.data.deps.includes('leftpad'),
    );
    assert.ok(
      fs.existsSync(path.join(dir, `cache/node-v${DEFAULT_NODE_VERSION}-linux-x64.tar.xz`)),
      'tarball cached',
    );
    assert.ok(fs.existsSync(path.join(dir, `cache/SHASUMS256-v${DEFAULT_NODE_VERSION}.txt`)));
    fs.rmSync(path.join(repo, 'packages/wb'), { recursive: true });
    await assert.rejects(served.install(), (e) => e.code === 'E_NOT_FOUND' && e.data.name === 'wb');
  } finally {
    cleanup();
  }
});

test('remove and setCurrent delete through removeUnder: escaping links are unlinked, never followed', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep'), 'host data');
    const root = path.join(dir, 'runtime');
    fs.mkdirSync(path.join(root, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'v1', 'manifest.json'), JSON.stringify({ version: 'v1' }));
    const mgr = new RuntimeManager({ paths: { runtime: root }, cacheDir: CACHE });
    const staleTmp = `${mgr.currentPath}.${process.pid}.tmp`;
    fs.symlinkSync(outside, staleTmp);
    mgr.setCurrent('v1');
    assert.equal(mgr.current().version, 'v1');
    assert.equal(fs.existsSync(staleTmp), false);
    fs.symlinkSync(outside, path.join(root, 'v2'));
    assert.equal(mgr.remove('v2'), true);
    assert.equal(fs.existsSync(path.join(root, 'v2')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'host data');
    assert.throws(
      () => mgr.remove('v1'),
      (e) => e.code === 'E_STATE',
    );
  } finally {
    cleanup();
  }
});
