import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Store } from '../../../src/store.js';
import {
  checkpointCreate,
  checkpointList,
  checkpointRestore,
  assertSafeTarNames,
  sha256OfFile,
} from '../../../src/broker/checkpoints.js';
import { tmpDir } from '../../helpers/tmp.js';

test('create/list/restore round-trip; unsafe tar names rejected', async () => {
  const t = tmpDir();
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const upperDir = path.join(t.dir, 'upper');
  fs.mkdirSync(path.join(upperDir, 'work'), { recursive: true });
  fs.writeFileSync(path.join(upperDir, 'work', 'f.txt'), 'checkpoint me');
  const ctx = { store, sandboxId: sb.id, upperDir, checkpointsDir: path.join(t.dir, 'cps') };
  const cp = await checkpointCreate(ctx, { name: 'first' });
  assert.equal(checkpointList(ctx).checkpoints.length, 1);
  assert.deepEqual(
    store.listEvents(sb.id).map((e) => [e.type, e.source, e.payload]),
    [['checkpoint.created', 'host', { checkpointId: cp.id, name: 'first' }]],
  );
  const target = path.join(t.dir, 'upper2');
  await checkpointRestore(ctx, cp.id, target);
  assert.equal(fs.readFileSync(path.join(target, 'work', 'f.txt'), 'utf8'), 'checkpoint me');
  assert.throws(() => assertSafeTarNames(['../escape']), /unsafe/);
  assert.throws(() => assertSafeTarNames(['/abs/path']), /unsafe/);
  store.close();
  t.cleanup();
});

test('a failed checkpoint create removes its partial archive and nothing outside the checkpoints dir', async () => {
  const t = tmpDir();
  const store = Store.open(':memory:');
  try {
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const upperDir = path.join(t.dir, 'upper');
    fs.mkdirSync(upperDir, { recursive: true });
    fs.writeFileSync(path.join(upperDir, 'kept.txt'), 'upper data');
    const ctx = { store, sandboxId: sb.id, upperDir, checkpointsDir: path.join(t.dir, 'cps') };
    await assert.rejects(
      checkpointCreate(ctx, { paths: ['/does-not-exist'] }),
      (e) => e.code === 'E_UNAVAILABLE' && /tar failed/.test(e.message),
    );
    assert.deepEqual(fs.readdirSync(ctx.checkpointsDir), [], 'partial archive removed');
    assert.equal(fs.readFileSync(path.join(upperDir, 'kept.txt'), 'utf8'), 'upper data');
    assert.equal(checkpointList(ctx).checkpoints.length, 0);
    assert.deepEqual(store.listEvents(sb.id), [], 'a refused checkpoint logs nothing');
  } finally {
    store.close();
    t.cleanup();
  }
});

test('checkpoint paths beginning with a dash are literal filenames despite inherited tar options', async () => {
  const t = tmpDir();
  const store = Store.open(':memory:');
  const saved = process.env.TAR_OPTIONS;
  process.env.TAR_OPTIONS = '--version';
  try {
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const upperDir = path.join(t.dir, 'upper');
    fs.mkdirSync(upperDir);
    fs.writeFileSync(path.join(upperDir, '--version'), 'literal file');
    const ctx = { store, sandboxId: sb.id, upperDir, checkpointsDir: path.join(t.dir, 'cps') };
    const cp = await checkpointCreate(ctx, { paths: ['--version'] });
    const target = path.join(t.dir, 'restored');
    await checkpointRestore(ctx, cp.id, target);
    assert.equal(fs.readFileSync(path.join(target, '--version'), 'utf8'), 'literal file');
  } finally {
    if (saved === undefined) delete process.env.TAR_OPTIONS;
    else process.env.TAR_OPTIONS = saved;
    store.close();
    t.cleanup();
  }
});

test('checkpoint paths cannot traverse symlinks, but leaf symlinks are preserved', async () => {
  const t = tmpDir();
  const store = Store.open(':memory:');
  try {
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const upperDir = path.join(t.dir, 'upper');
    const outside = path.join(t.dir, 'outside');
    fs.mkdirSync(upperDir);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'private.txt'), 'host data');
    fs.symlinkSync(outside, path.join(upperDir, 'link'));
    const ctx = { store, sandboxId: sb.id, upperDir, checkpointsDir: path.join(t.dir, 'cps') };
    for (const member of ['link/private.txt', './link//private.txt', 'link/', 'link/.']) {
      await assert.rejects(
        checkpointCreate(ctx, { paths: [member] }),
        (e) => e.code === 'E_DENIED' && /symlink/.test(e.message),
      );
      assert.deepEqual(fs.readdirSync(ctx.checkpointsDir), []);
      assert.equal(checkpointList(ctx).checkpoints.length, 0);
    }
    const upperAlias = path.join(t.dir, 'linked-upper');
    fs.symlinkSync(upperDir, upperAlias);
    await assert.rejects(
      checkpointCreate({ ...ctx, upperDir: upperAlias }, {}),
      (e) => e.code === 'E_DENIED' && /symlink/.test(e.message),
    );
    const cp = await checkpointCreate(ctx, { paths: ['link'] });
    const target = path.join(t.dir, 'restored');
    await checkpointRestore(ctx, cp.id, target);
    assert.equal(fs.lstatSync(path.join(target, 'link')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(target, 'link')), outside);
    assert.deepEqual(fs.readdirSync(target), ['link']);
  } finally {
    store.close();
    t.cleanup();
  }
});

test('restore refuses an archive whose listing exceeds the validation limit', async () => {
  const t = tmpDir();
  const store = Store.open(':memory:');
  try {
    const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
    const name = 'a'.repeat(240);
    fs.writeFileSync(path.join(t.dir, name), 'data');
    const tarFile = path.join(t.dir, 'large.tar');
    const result = spawnSync('tar', ['-cf', tarFile, '-C', t.dir, '--files-from=-'], {
      input: `${name}\n`.repeat(5000),
    });
    assert.equal(result.status, 0, result.stderr?.toString());
    const cp = store.addCheckpoint({
      sandboxId: sb.id,
      sha256: await sha256OfFile(tarFile),
      size: fs.statSync(tarFile).size,
      envelope: { tar: 'large.tar' },
    });
    const target = path.join(t.dir, 'restored');
    await assert.rejects(
      checkpointRestore({ store, checkpointsDir: t.dir }, cp.id, target),
      (e) => e.code === 'E_LIMIT' && /output/.test(e.message),
    );
    assert.equal(fs.existsSync(target), false, 'refused before extraction');
  } finally {
    store.close();
    t.cleanup();
  }
});
