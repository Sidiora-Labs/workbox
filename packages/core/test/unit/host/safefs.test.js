import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  removeUnder,
  checkUnder,
  SafeFsReason,
  withLockFile,
  lockPathFor,
  makeStaging,
  commitStaging,
  fsyncDir,
} from '../../../src/host/safefs.js';
import { tmpDir } from '../../helpers/tmp.js';

function mkfile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'x');
}

const refused = (reason) => (e) => e.code === 'E_DENIED' && e.data.reason === reason;

function twoDirs(fn) {
  const a = tmpDir('workbox-safefs-root-');
  const b = tmpDir('workbox-safefs-other-');
  try {
    fn(a.dir, b.dir);
  } finally {
    a.cleanup();
    b.cleanup();
  }
}

test('TestRemoveUnderInside: a tree inside the root is removed', () =>
  twoDirs((root) => {
    mkfile(path.join(root, 'a', 'b', 'c.txt'));
    assert.equal(removeUnder(root, path.join(root, 'a')), true);
    assert.equal(fs.existsSync(path.join(root, 'a')), false);
    assert.ok(fs.existsSync(root), 'the root itself stays');
  }));

test('TestRemoveUnderRefusesOutside: paths outside the root are refused and kept', () =>
  twoDirs((root, other) => {
    const victim = path.join(other, 'keep.txt');
    mkfile(victim);
    for (const p of [
      other,
      victim,
      path.join(root, '..', path.basename(other)),
      path.join(root, 'x', '..', '..', path.basename(other), 'keep.txt'),
    ]) {
      assert.throws(() => removeUnder(root, p), refused(SafeFsReason.OUTSIDE_ROOT), p);
    }
    assert.equal(fs.readFileSync(victim, 'utf8'), 'x', 'victim kept');
  }));

test('TestRemoveUnderRefusesRoot: the root itself and "/" as a root are refused', () =>
  twoDirs((root) => {
    mkfile(path.join(root, 'inner.txt'));
    assert.throws(() => removeUnder(root, root), refused(SafeFsReason.IS_ROOT));
    assert.throws(
      () => removeUnder(root, path.join(root, 'sub', '..')),
      refused(SafeFsReason.IS_ROOT),
    );
    assert.equal(fs.readFileSync(path.join(root, 'inner.txt'), 'utf8'), 'x');
    assert.throws(
      () => removeUnder('/', '/tmp/whatever-not-real'),
      refused(SafeFsReason.ROOT_TOO_BROAD),
    );
    const linkToSlash = path.join(root, 'slash');
    fs.symlinkSync('/', linkToSlash);
    assert.throws(
      () => removeUnder(linkToSlash, path.join(linkToSlash, 'tmp')),
      refused(SafeFsReason.ROOT_TOO_BROAD),
    );
  }));

test('TestRemoveUnderSymlinkEscape: a symlink out of the root is never followed', () =>
  twoDirs((root, other) => {
    const victim = path.join(other, 'keep.txt');
    mkfile(victim);
    const link = path.join(root, 'escape');
    fs.symlinkSync(other, link);
    assert.throws(
      () => removeUnder(root, path.join(link, 'keep.txt')),
      refused(SafeFsReason.OUTSIDE_ROOT),
    );
    assert.equal(removeUnder(root, link), true, 'the link itself is removed');
    assert.equal(fs.existsSync(link), false);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'x', 'victim kept');

    const nested = path.join(root, 'tree');
    fs.mkdirSync(nested);
    fs.symlinkSync(other, path.join(nested, 'out'));
    fs.symlinkSync(victim, path.join(nested, 'file-out'));
    assert.equal(removeUnder(root, nested), true);
    assert.equal(fs.existsSync(nested), false);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'x', 'links inside a removed tree not followed');
  }));

test('TestRemoveUnderMissing: a missing path is not an error', () =>
  twoDirs((root) => {
    assert.equal(removeUnder(root, path.join(root, 'nope')), false);
    assert.equal(removeUnder(path.join(root, 'not-yet'), path.join(root, 'not-yet', 'x')), false);
  }));

test('a symlinked root resolves before the check; a dangling link out of the root is unlinked', () =>
  twoDirs((root, other) => {
    const real = path.join(root, 'real');
    mkfile(path.join(real, 'sub', 'f'));
    const alias = path.join(other, 'alias');
    fs.symlinkSync(real, alias);
    assert.equal(removeUnder(alias, path.join(real, 'sub')), true);
    assert.equal(fs.existsSync(path.join(real, 'sub')), false);
    assert.throws(() => removeUnder(alias, real), refused(SafeFsReason.IS_ROOT));
    const dangling = path.join(root, 'dangling');
    fs.symlinkSync(path.join(other, 'missing'), dangling);
    assert.equal(removeUnder(root, dangling), true);
    assert.equal(fs.existsSync(alias), true, 'the outside alias is untouched');
    const outsideLink = path.join(other, 'link');
    fs.symlinkSync(real, outsideLink);
    assert.throws(() => removeUnder(root, outsideLink), refused(SafeFsReason.OUTSIDE_ROOT));
    assert.ok(fs.lstatSync(outsideLink).isSymbolicLink(), 'a link outside the root is kept');
  }));

test('checkUnder returns the resolved path for paths that do not exist yet', () =>
  twoDirs((root, other) => {
    fs.symlinkSync(other, path.join(root, 'out'));
    const realRoot = fs.realpathSync(root);
    assert.equal(checkUnder(root, path.join(root, 'new', 'file')), path.join(realRoot, 'new/file'));
    assert.throws(
      () => checkUnder(root, path.join(root, 'out', 'new', 'file')),
      refused(SafeFsReason.OUTSIDE_ROOT),
    );
    assert.throws(() => checkUnder(root, `${root}-sibling`), refused(SafeFsReason.OUTSIDE_ROOT));
    assert.equal(
      checkUnder(root, path.join(root, '..dotted')),
      path.join(realRoot, '..dotted'),
      'a name starting with .. is still inside',
    );
  }));

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url));
const SAFEFS_MODULE = new URL('../../../src/host/safefs.js', import.meta.url).href;
/** Host-side packages; packages/runner and packages/wb run inside the box and are exempt. */
const SCANNED_PACKAGES = ['core', 'cli', 'server', 'sdk', 'mcp'];
const CHOKE_POINT = 'packages/core/src/host/safefs.js';
const DELETE_CALL = /(?<![\w$])(rmSync|rmdirSync|rmdir|rm)\s*\(/g;
/**
 * A cgroup directory can only be removed with rmdir(2) once it is empty; a recursive rm would try
 * to unlink its control files. These calls are allowed, at most this many of them.
 */
const ALLOWED = new Map([['packages/core/src/host/cgroup.js', { call: 'rmdirSync', count: 2 }]]);

/**
 * Every rm/rmSync/rmdir/rmdirSync call under `<repo>/packages/{core,cli,server,sdk,mcp}/src`
 * outside safefs.js, as `file:line: call(`.
 * @param {string} repo
 */
function deleteCallsOutsideSafefs(repo) {
  const hits = [];
  const walk = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.[cm]?js$/.test(entry.name)) hits.push(...scanSource(repo, p));
    }
  };
  for (const pkg of SCANNED_PACKAGES) {
    const src = path.join(repo, 'packages', pkg, 'src');
    if (fs.existsSync(src)) walk(src);
  }
  return hits;
}

function scanSource(repo, file) {
  const rel = path.relative(repo, file).split(path.sep).join('/');
  if (rel === CHOKE_POINT) return [];
  const hits = [];
  fs.readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      for (const m of text.matchAll(DELETE_CALL)) hits.push({ rel, line: i + 1, call: m[1] });
    });
  const allowed = ALLOWED.get(rel);
  const ok = (h) => allowed && h.call === allowed.call;
  const kept = hits.filter(ok).length <= (allowed?.count ?? 0) ? hits.filter((h) => !ok(h)) : hits;
  return kept.map((h) => `${h.rel}:${h.line}: ${h.call}(`);
}

test('no host-side source deletes outside safefs.js; the scan catches a planted violation', () => {
  assert.deepEqual(
    deleteCallsOutsideSafefs(REPO),
    [],
    'route these deletes through removeUnder in packages/core/src/host/safefs.js',
  );
  const { dir, cleanup } = tmpDir('workbox-safefs-scan-');
  try {
    const fixture = {
      'packages/core/src/host/safefs.js': 'fs.rmSync(checkUnder(root, p));\n',
      'packages/core/src/host/cgroup.js': 'fs.rmdirSync(a);\nfs.rmdirSync(b);\n',
      'packages/core/src/planted.js': [
        "import fs from 'node:fs';",
        'const ok = confirm(perm(1)) && removeUnder(root, p) && form (2);',
        '  fs.rmSync(dir, { recursive: true, force: true });',
      ].join('\n'),
      'packages/server/src/deep/gc.mjs': 'await fsp.rm(dir, { force: true }); rmdirSync(p);\n',
      'packages/cli/src/clean.js':
        "const { rm } = await import('node:fs/promises');\nawait rm (p);\n",
      'packages/runner/src/inbox.js': 'fs.rmSync(p, { recursive: true });\n',
      'packages/wb/src/inbox.js': 'fs.rmSync(p, { recursive: true });\n',
    };
    for (const [rel, text] of Object.entries(fixture)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    assert.deepEqual(deleteCallsOutsideSafefs(dir), [
      'packages/core/src/planted.js:3: rmSync(',
      'packages/cli/src/clean.js:2: rm(',
      'packages/server/src/deep/gc.mjs:1: rm(',
      'packages/server/src/deep/gc.mjs:1: rmdirSync(',
    ]);
    fs.appendFileSync(path.join(dir, 'packages/core/src/host/cgroup.js'), 'fs.rmdirSync(c);\n');
    assert.deepEqual(
      deleteCallsOutsideSafefs(dir).filter((h) => h.includes('cgroup')),
      [
        'packages/core/src/host/cgroup.js:1: rmdirSync(',
        'packages/core/src/host/cgroup.js:2: rmdirSync(',
        'packages/core/src/host/cgroup.js:3: rmdirSync(',
      ],
      'a cgroup rmdir past the allowance fails',
    );
  } finally {
    cleanup();
  }
});

/** A separate node process that takes `lock`, prints "held" and keeps it until its stdin ends. */
function lockHolder(lock) {
  const script = `import { withLockFile } from ${JSON.stringify(SAFEFS_MODULE)};
await withLockFile(process.argv[1], async () => {
  process.stdout.write('held\\n');
  await new Promise((resolve) => process.stdin.once('end', resolve).resume());
});`;
  return spawn(process.execPath, ['--input-type=module', '-e', script, lock], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

test('withLockFile serialises real processes, times out with E_BUSY and breaks a dead holder', async () => {
  const { dir, cleanup } = tmpDir('workbox-safefs-lock-');
  const children = [];
  try {
    const lock = lockPathFor(dir, 'v1');
    assert.equal(lock, path.join(dir, '.v1.lock'));
    const first = lockHolder(lock);
    children.push(first);
    await once(first.stdout, 'data');
    assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${first.pid}:`));
    await assert.rejects(
      withLockFile(lock, () => 'never', { timeoutMs: 150 }),
      (e) => e.code === 'E_BUSY' && e.data.lock === lock,
    );
    const order = [];
    const waiter = withLockFile(lock, () => {
      order.push('waiter ran');
      return fs.readFileSync(lock, 'utf8');
    });
    await sleep(150);
    order.push('holder released');
    first.stdin.end();
    const token = await waiter;
    assert.deepEqual(order, ['holder released', 'waiter ran']);
    assert.match(token, new RegExp(`^${process.pid}:`));
    assert.equal(fs.existsSync(lock), false, 'the waiter released the lock');

    const killed = lockHolder(lock);
    children.push(killed);
    await once(killed.stdout, 'data');
    killed.kill('SIGKILL');
    await once(killed, 'exit');
    assert.match(fs.readFileSync(lock, 'utf8'), new RegExp(`^${killed.pid}:`), 'left behind');
    assert.equal(
      await withLockFile(lock, () => 'broken and taken', { timeoutMs: 2000 }),
      'broken and taken',
    );
    const inner = withLockFile(lock, async () => {
      await sleep(100);
      return 'outer';
    });
    await sleep(20);
    assert.equal(
      await withLockFile(lock, () => 'second', { timeoutMs: 2000 }),
      'second',
      'a lock this process still holds is waited for, not broken',
    );
    assert.equal(await inner, 'outer');
    assert.deepEqual(fs.readdirSync(dir), [], 'no lockfile or break guard is left');
  } finally {
    for (const child of children) child.kill('SIGKILL');
    cleanup();
  }
});

test('makeStaging is private per installer and clears only its own name; commitStaging swaps durably', () =>
  twoDirs((root, other) => {
    for (const leftover of ['.v1.staging-Ab12Cd', 'v1.tmp'])
      mkfile(path.join(root, leftover, 'half-written'));
    const kept = ['.v10.staging-Ab12Cd', '.v1.staging-x.staging-Ab12Cd', 'v1-other'];
    for (const name of kept) mkfile(path.join(root, name, 'f'));
    const staging = makeStaging(root, 'v1');
    assert.match(path.basename(staging), /^\.v1\.staging-[A-Za-z0-9]{6}$/);
    assert.equal(path.dirname(staging), root, 'staged beside the target');
    assert.equal(fs.statSync(staging).mode & 0o777, 0o755);
    assert.deepEqual(
      fs.readdirSync(root).sort(),
      [...kept, path.basename(staging)].sort(),
      'leftovers of v1 are gone, other names are untouched',
    );
    const target = path.join(root, 'v1');
    mkfile(path.join(target, 'old'));
    fs.writeFileSync(path.join(staging, 'new'), 'n');
    commitStaging(root, staging, target);
    assert.deepEqual(fs.readdirSync(target), ['new']);
    assert.equal(fs.existsSync(staging), false);
    fsyncDir(root);
    const outside = makeStaging(other, 'v1');
    assert.throws(
      () => commitStaging(root, outside, path.join(root, 'v2')),
      refused(SafeFsReason.OUTSIDE_ROOT),
    );
    assert.throws(
      () => commitStaging(root, makeStaging(root, 'v2'), path.join(other, 'v2')),
      refused(SafeFsReason.OUTSIDE_ROOT),
    );
    assert.ok(fs.existsSync(outside), 'a refused commit moves nothing');
  }));
