import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { removeUnder, checkUnder, SafeFsReason } from '../../../src/host/safefs.js';
import { tmpDir } from '../../helpers/tmp.js';

/** Vectors ported from tryboxi internal/safefs/safefs_test.go (MIT). */

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
