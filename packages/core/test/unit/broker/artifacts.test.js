import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../../../src/store.js';
import { artifactPut, artifactGet, artifactList } from '../../../src/broker/artifacts.js';
import { tmpDir } from '../../helpers/tmp.js';

test('put/get/list round-trip through the CAS', () => {
  const t = tmpDir();
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const outboxDir = path.join(t.dir, 'outbox');
  fs.mkdirSync(outboxDir, { recursive: true });
  const data = Buffer.from('artifact bytes');
  const sha256 = createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(path.join(outboxDir, 'a.bin'), data);
  const ctx = {
    store,
    sandboxId: sb.id,
    outboxDir,
    inboxDir: path.join(t.dir, 'inbox'),
    artifactsDir: path.join(t.dir, 'cas'),
  };
  const put = artifactPut(ctx, { outboxName: 'a.bin', sha256, size: data.length, name: 'a.bin' });
  assert.equal(put.sha256, sha256);
  assert.equal(artifactList(ctx, {}).items.length, 1);
  const got = artifactGet(ctx, { sha256 });
  assert.equal(fs.readFileSync(path.join(ctx.inboxDir, got.inboxName), 'utf8'), 'artifact bytes');

  const other = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const otherInbox = path.join(t.dir, 'inbox-other');
  assert.throws(
    () => artifactGet({ ...ctx, sandboxId: other.id, inboxDir: otherInbox }, { sha256 }),
    {
      code: 'E_NOT_FOUND',
    },
  );
  assert.equal(fs.existsSync(path.join(otherInbox, sha256)), false);
  store.close();
  t.cleanup();
});
