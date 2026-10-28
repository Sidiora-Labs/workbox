import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../../../src/store.js';
import {
  checkpointCreate,
  checkpointList,
  checkpointRestore,
  assertSafeTarNames,
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
  const target = path.join(t.dir, 'upper2');
  await checkpointRestore(ctx, cp.id, target);
  assert.equal(fs.readFileSync(path.join(target, 'work', 'f.txt'), 'utf8'), 'checkpoint me');
  assert.throws(() => assertSafeTarNames(['../escape']), /unsafe/);
  assert.throws(() => assertSafeTarNames(['/abs/path']), /unsafe/);
  store.close();
  t.cleanup();
});
