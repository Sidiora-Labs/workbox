import fs from 'node:fs';
import path from 'node:path';
import { E } from '../errors.js';

/**
 * Classic-BPF seccomp program for x86_64 (spec req 1.6 / task 2.2): validate the architecture,
 * deny the x32 ABI, return EPERM for the Docker default denylist, allow everything else.
 * Deviation, stated plainly: "ptrace of non-descendants" cannot be expressed in plain seccomp,
 * so `ptrace` is denied outright in v1.
 */

const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ = 0x15;
const BPF_JMP_JGE = 0x35;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff_0000;
const SECCOMP_RET_ERRNO = 0x0005_0000;
const EPERM = 1;
const AUDIT_ARCH_X86_64 = 0xc000_003e;
const X32_BASE = 0x4000_0000;
const OFF_NR = 0;
const OFF_ARCH = 4;

/** Denied syscalls by name, with x86_64 numbers. */
export const DENIED_SYSCALLS = Object.freeze({
  mount: 165,
  umount2: 166,
  pivot_root: 155,
  setns: 308,
  unshare: 272,
  keyctl: 250,
  add_key: 248,
  request_key: 249,
  kexec_load: 246,
  open_by_handle_at: 304,
  ptrace: 101,
  bpf: 321,
  perf_event_open: 298,
  userfaultfd: 323,
});

/** @param {number} code @param {number} jt @param {number} jf @param {number} k */
function insn(code, jt, jf, k) {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(code, 0);
  b.writeUInt8(jt, 2);
  b.writeUInt8(jf, 3);
  b.writeUInt32LE(k >>> 0, 4);
  return b;
}

/**
 * Assemble the filter. Returns the sock_fprog body bwrap expects on `--seccomp <fd>`.
 * @param {{arch?: string, extraDeny?: string[]}} [opts]
 * @returns {Buffer}
 */
export function buildSeccompProgram(opts = {}) {
  const arch = opts.arch ?? 'x86_64';
  if (arch !== 'x86_64')
    throw E.unsupported(`seccomp program is implemented for x86_64 only, not ${arch}`, { arch });
  const denied = [...Object.values(DENIED_SYSCALLS)];
  for (const name of opts.extraDeny ?? []) {
    if (!(name in DENIED_SYSCALLS)) throw E.invalid(`unknown syscall ${name}`, { name });
  }
  const allowIdx = 4 + denied.length;
  const denyIdx = allowIdx + 1;
  const parts = [
    insn(BPF_LD_W_ABS, 0, 0, OFF_ARCH),
    insn(BPF_JMP_JEQ, 0, denyIdx - 2, AUDIT_ARCH_X86_64),
    insn(BPF_LD_W_ABS, 0, 0, OFF_NR),
    insn(BPF_JMP_JGE, denyIdx - 4, 0, X32_BASE),
  ];
  denied.forEach((nr, i) => {
    parts.push(insn(BPF_JMP_JEQ, denyIdx - (4 + i + 1), 0, nr));
  });
  parts.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW));
  parts.push(insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | EPERM));
  return Buffer.concat(parts);
}

/**
 * Write the program under `dir` and open it read-only.
 * @param {string} dir
 * @param {{arch?: string}} [opts]
 * @returns {{fd: number, file: string, program: Buffer}}
 */
export function openSeccompFd(dir, opts = {}) {
  const program = buildSeccompProgram(opts);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'seccomp.bpf');
  fs.writeFileSync(file, program, { mode: 0o600 });
  const fd = fs.openSync(file, 'r');
  return { fd, file, program };
}

/**
 * Decode a program back into instructions, for tests and doctor output.
 * @param {Buffer} program
 */
export function decodeProgram(program) {
  if (!Buffer.isBuffer(program) || program.length % 8 !== 0 || program.length === 0)
    throw E.invalid('seccomp program must be a non-empty multiple of 8 bytes');
  const out = [];
  for (let off = 0; off < program.length; off += 8) {
    out.push({
      code: program.readUInt16LE(off),
      jt: program.readUInt8(off + 2),
      jf: program.readUInt8(off + 3),
      k: program.readUInt32LE(off + 4),
    });
  }
  return out;
}
