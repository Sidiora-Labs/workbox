import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFs, decodeBase64 } from '../../src/fs.js';

test('fs read/write/list/stat/mkdir/remove round-trip under a root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fs-'));
  const api = createFs({ root: dir });
  api.mkdir({ path: `${dir}/sub` });
  const w = api.write({
    path: `${dir}/sub/f.txt`,
    data: Buffer.from('hello world').toString('base64'),
  });
  assert.equal(w.bytes, 11);
  const r = api.read({ path: `${dir}/sub/f.txt`, offset: 6, length: 5 });
  assert.equal(Buffer.from(r.data, 'base64').toString(), 'world');
  assert.equal(r.eof, true);
  assert.deepEqual(
    api.list({ path: `${dir}/sub` }).entries.map((e) => e.name),
    ['f.txt'],
  );
  assert.equal(api.stat({ path: `${dir}/sub/f.txt` }).size, 11);
  api.write({ path: `${dir}/sub/f.txt`, data: Buffer.from('!').toString('base64'), append: true });
  assert.equal(api.stat({ path: `${dir}/sub/f.txt` }).size, 12);
  api.remove({ path: `${dir}/sub`, recursive: true });
  assert.throws(() => api.read({ path: '/etc/hostname' }), /escapes|not found/);
  assert.throws(() => api.read({ path: 'relative' }), /absolute/);
  assert.throws(() => decodeBase64('!!!not-base64!!!'), /base64/);
  fs.rmSync(dir, { recursive: true, force: true });
});
