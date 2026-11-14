import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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

const code = (c) => (e) => e.code === c;

test('remove unlinks file, directory and dangling symlinks without following them', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fs-links-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = createFs({ root: dir });
  const target = path.join(dir, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'kept'), 'keep me');
  for (const [name, to, recursive] of [
    ['file-link', path.join(target, 'kept'), false],
    ['dir-link', target, true],
    ['dangling', path.join(dir, 'absent'), false],
    ['outside-link', '/etc/hostname', false],
  ]) {
    const link = path.join(dir, name);
    fs.symlinkSync(to, link);
    api.remove({ path: link, recursive });
    assert.equal(fs.existsSync(link), false);
    assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
    assert.equal(fs.readFileSync(path.join(target, 'kept'), 'utf8'), 'keep me');
  }
  assert.throws(() => api.remove({ path: dir, recursive: true }), code('E_DENIED'));
  assert.throws(() => api.remove({ path: path.join(dir, 'absent') }), code('E_NOT_FOUND'));
  fs.symlinkSync('/etc', path.join(dir, 'escape'));
  assert.throws(() => api.remove({ path: path.join(dir, 'escape', 'hostname') }), code('E_DENIED'));
});

test('rename publishes only regular staged files and confines both parents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fs-rename-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const api = createFs({ root: dir });
  const source = path.join(dir, 'staged');
  const target = path.join(dir, 'target');
  fs.writeFileSync(source, 'new');
  fs.writeFileSync(target, 'old');
  api.rename({ source, target });
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.equal(fs.existsSync(source), false);
  fs.symlinkSync(target, source);
  assert.throws(() => api.rename({ source, target }), code('E_INVALID_PARAMS'));
  assert.throws(() => api.rename({ source: target, target: '/etc/hostname' }), code('E_DENIED'));
  assert.throws(() => api.rename({ source: 'relative', target }), code('E_INVALID_PARAMS'));
});

test('fs entry types, defaults, confinement and error codes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fs-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fs-out-'));
  try {
    const api = createFs({ root: dir });
    fs.writeFileSync(`${dir}/b.txt`, 'abc');
    fs.mkdirSync(`${dir}/a-dir`);
    fs.symlinkSync(`${dir}/b.txt`, `${dir}/c-link`);
    execFileSync('mkfifo', [`${dir}/d-fifo`]);
    fs.symlinkSync(outside, `${dir}/escape`);
    assert.deepEqual(api.list({ path: dir }).entries, [
      { name: 'a-dir', type: 'dir' },
      { name: 'b.txt', type: 'file' },
      { name: 'c-link', type: 'symlink' },
      { name: 'd-fifo', type: 'other' },
      { name: 'escape', type: 'symlink' },
    ]);

    const whole = api.read({ path: `${dir}/b.txt` });
    assert.deepEqual(whole, { path: `${dir}/b.txt`, size: 3, offset: 0, data: 'YWJj', eof: true });
    assert.deepEqual(api.read({ path: `${dir}/b.txt`, offset: 10 }), {
      path: `${dir}/b.txt`,
      size: 3,
      offset: 10,
      data: '',
      eof: true,
    });
    assert.equal(api.read({ path: `${dir}/b.txt`, length: 1 }).eof, false);
    assert.throws(() => api.read({ path: `${dir}/a-dir` }), code('E_INVALID_PARAMS'));
    assert.throws(() => api.read({ path: `${dir}/missing` }), code('E_NOT_FOUND'));
    assert.throws(() => api.stat({ path: `${dir}/escape` }), code('E_DENIED'));
    assert.throws(
      () => api.write({ path: `${dir}/escape/planted`, data: 'eA==' }),
      code('E_DENIED'),
    );
    assert.equal(fs.existsSync(`${outside}/planted`), false);
    assert.throws(() => api.stat({ path: `${dir}/x\0y` }), code('E_INVALID_PARAMS'));

    const deep = api.write({ path: `${dir}/n/e/s/t.txt`, data: 'eHl6', mkdirs: true, mode: 0o600 });
    assert.deepEqual(deep, { path: `${dir}/n/e/s/t.txt`, bytes: 3, size: 3 });
    assert.equal(api.stat({ path: `${dir}/n/e/s/t.txt` }).mode, 0o600);
    assert.throws(
      () => api.write({ path: `${dir}/nowhere/t.txt`, data: 'eHl6' }),
      code('E_NOT_FOUND'),
    );
    api.mkdir({ path: `${dir}/private`, mode: 0o700 });
    const st = api.stat({ path: `${dir}/private` });
    assert.equal(st.mode, 0o700);
    assert.equal(st.isDir, true);
    assert.equal(st.isFile, false);

    assert.deepEqual(api.remove({ path: `${dir}/private` }), {
      path: `${dir}/private`,
      removed: true,
    });
    assert.throws(() => api.remove({ path: `${dir}/n` }), code('ENOTEMPTY'));
    api.remove({ path: `${dir}/b.txt` });
    assert.equal(fs.existsSync(`${dir}/b.txt`), false);

    const anywhere = createFs();
    assert.equal(anywhere.stat({ path: `${outside}` }).isDir, true, 'the default root is /');

    assert.throws(() => decodeBase64(42), /not valid base64/);
    assert.throws(() => decodeBase64('QUJDR'), /not valid base64/);
    assert.throws(() => decodeBase64('QR=='), /not canonical base64/);
    assert.equal(decodeBase64('QQ==').toString(), 'A');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
