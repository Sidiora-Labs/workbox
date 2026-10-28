import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { acceptOutboxFile, deliverToInbox, assertOutboxName } from '../../../src/broker/outbox.js';
import { tmpDir } from '../../helpers/tmp.js';

function setup(data = Buffer.from('hello evidence')) {
  const t = tmpDir();
  const outboxDir = path.join(t.dir, 'outbox');
  const artifactsDir = path.join(t.dir, 'cas');
  fs.mkdirSync(outboxDir, { recursive: true });
  const sha256 = createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(path.join(outboxDir, 'f.bin'), data);
  return { t, outboxDir, artifactsDir, sha256, data };
}

test('accepts a digest-verified file, stores it in the CAS and unlinks the source', () => {
  const s = setup();
  const out = acceptOutboxFile({
    ...s,
    outboxName: 'f.bin',
    size: s.data.length,
    sha256: s.sha256,
  });
  assert.equal(out.sha256, s.sha256);
  assert.equal(fs.readFileSync(out.path, 'utf8'), 'hello evidence');
  assert.equal(fs.existsSync(path.join(s.outboxDir, 'f.bin')), false);
  const inboxDir = path.join(s.t.dir, 'inbox');
  const got = deliverToInbox({ artifactsDir: s.artifactsDir, inboxDir, sha256: s.sha256 });
  assert.equal(fs.readFileSync(path.join(inboxDir, got.inboxName), 'utf8'), 'hello evidence');
  s.t.cleanup();
});

test('rejects digest mismatch, symlinks, traversal names and oversize', () => {
  const s = setup();
  assert.throws(
    () =>
      acceptOutboxFile({ ...s, outboxName: 'f.bin', size: s.data.length, sha256: 'a'.repeat(64) }),
    /mismatch/,
  );
  assert.throws(() => assertOutboxName('../escape'));
  assert.throws(() => assertOutboxName('..'));
  const big = setup(Buffer.alloc(100));
  assert.throws(
    () =>
      acceptOutboxFile({
        ...big,
        outboxName: 'f.bin',
        size: 100,
        sha256: big.sha256,
        maxBytes: 10,
      }),
    /exceeds/,
  );
  fs.symlinkSync('/etc/hostname', path.join(s.outboxDir, 'link.bin'));
  assert.throws(() =>
    acceptOutboxFile({ ...s, outboxName: 'link.bin', size: 1, sha256: 'b'.repeat(64) }),
  );
  s.t.cleanup();
  big.t.cleanup();
});
