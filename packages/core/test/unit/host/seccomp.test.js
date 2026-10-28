import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildSeccompProgram,
  decodeProgram,
  openSeccompFd,
  DENIED_SYSCALLS,
} from '../../../src/host/seccomp.js';
import { tmpDir } from '../../helpers/tmp.js';

test('program checks arch, denies the denylist with EPERM and allows otherwise', () => {
  const prog = buildSeccompProgram();
  const insns = decodeProgram(prog);
  const denied = Object.values(DENIED_SYSCALLS);
  assert.equal(insns.length, 4 + denied.length + 2);
  assert.equal(insns[0].k, 4, 'loads arch');
  assert.equal(insns[1].k, 0xc000003e);
  for (const nr of denied)
    assert.ok(
      insns.some((i) => i.code === 0x15 && i.k === nr),
      `denies ${nr}`,
    );
  assert.equal(insns[insns.length - 2].k, 0x7fff0000, 'allow');
  assert.equal(insns[insns.length - 1].k, 0x00050001, 'errno EPERM');
  // every JEQ deny jumps exactly to the EPERM instruction
  const denyIdx = insns.length - 1;
  insns.forEach((ins, i) => {
    if (ins.code === 0x15 && denied.includes(ins.k)) assert.equal(i + 1 + ins.jt, denyIdx);
  });
});

test('unsupported arch and junk are rejected; fd helper writes the program', () => {
  assert.throws(() => buildSeccompProgram({ arch: 'arm64' }), /x86_64/);
  assert.throws(() => decodeProgram(Buffer.alloc(3)));
  const t = tmpDir();
  const { fd, file, program } = openSeccompFd(t.dir);
  assert.deepEqual(fs.readFileSync(file), program);
  fs.closeSync(fd);
  t.cleanup();
});
