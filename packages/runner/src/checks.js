import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

/** Effective and bounding capability mask of the sandbox profile (see core launch.js). */
export const EXPECTED_CAPS = '00000000a80425fb';

/**
 * @param {string} [file]
 * @returns {{inner: number, outer: number, count: number}[]}
 */
export function readIdMap(file = '/proc/self/uid_map') {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [inner, outer, count] = l.trim().split(/\s+/).map(Number);
      return { inner, outer, count };
    });
}

/**
 * Capability, privilege and identity fields of /proc/<pid>/status.
 * @param {string} [file]
 */
export function readStatus(file = '/proc/self/status') {
  const out = {
    capEff: null,
    capPrm: null,
    capBnd: null,
    capAmb: null,
    noNewPrivs: null,
    seccomp: null,
    uid: null,
    gid: null,
  };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const [key, rest] = line.split(':');
    if (!rest) continue;
    const val = rest.trim();
    switch (key) {
      case 'CapEff':
        out.capEff = val;
        break;
      case 'CapPrm':
        out.capPrm = val;
        break;
      case 'CapBnd':
        out.capBnd = val;
        break;
      case 'CapAmb':
        out.capAmb = val;
        break;
      case 'NoNewPrivs':
        out.noNewPrivs = val === '1';
        break;
      case 'Seccomp':
        out.seccomp = Number(val);
        break;
      case 'Uid':
        out.uid = Number(val.split(/\s+/)[0]);
        break;
      case 'Gid':
        out.gid = Number(val.split(/\s+/)[0]);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Mount table from mountinfo: mount point, filesystem type, mount options and source.
 * @param {string} [file]
 */
export function readMounts(file = '/proc/self/mountinfo') {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [left, right] = line.split(' - ');
      const l = left.split(' ');
      const r = right.split(' ');
      return {
        mountPoint: unescapeMount(l[4]),
        options: l[5].split(','),
        fsType: r[0],
        source: r[1],
      };
    });
}

function unescapeMount(s) {
  return s.replace(/\\([0-7]{3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)));
}

/**
 * Try to mount a tmpfs; inside the sandbox this must fail with permission denied.
 * @param {string} [dir] mount point; created if absent
 * @returns {Promise<{denied: boolean, exitCode: number|null, message: string}>}
 */
export async function probeMount(dir = path.join(os.tmpdir(), `.wb-mount-probe-${process.pid}`)) {
  fs.mkdirSync(dir, { recursive: true });
  const child = spawn('mount', ['-t', 'tmpfs', 'none', dir], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const [code] = await once(child, 'close');
  const message = err.trim();
  if (code === 0) {
    const um = spawn('umount', [dir], { stdio: 'ignore' });
    await once(um, 'close');
  }
  fs.rmdirSync(dir, { recursive: false });
  return {
    denied:
      code !== 0 && /permission denied|operation not permitted|must be superuser/i.test(message),
    exitCode: code,
    message,
  };
}

function collectProblems(status, byPoint, mountProbe, expected) {
  const problems = [];
  if (status.capEff !== expected) problems.push(`CapEff ${status.capEff} != ${expected}`);
  if (status.capBnd !== expected) problems.push(`CapBnd ${status.capBnd} != ${expected}`);
  if (!status.noNewPrivs) problems.push('NoNewPrivs is not set');
  if (status.uid !== 0) problems.push(`uid ${status.uid} != 0`);
  if (!mountProbe.denied)
    problems.push(
      `mount(2) was not denied: ${mountProbe.message || `exit ${mountProbe.exitCode}`}`,
    );
  if (!byPoint['/'] || byPoint['/'].fsType !== 'overlay')
    problems.push(`/ is ${byPoint['/']?.fsType ?? 'missing'}, expected overlay`);
  if (!byPoint['/opt/workbox'] || !byPoint['/opt/workbox'].options.includes('ro'))
    problems.push('/opt/workbox is not a read-only mount');
  if (!byPoint['/run/workbox']) problems.push('/run/workbox is not mounted');
  return problems;
}

/**
 * Everything the host verifies before declaring the sandbox READY.
 * @param {{expectedCaps?: string}} [opts]
 */
export async function selfChecks(opts = {}) {
  const expected = opts.expectedCaps ?? EXPECTED_CAPS;
  const status = readStatus();
  const uidMap = readIdMap('/proc/self/uid_map');
  const gidMap = readIdMap('/proc/self/gid_map');
  const mounts = readMounts();
  const byPoint = Object.fromEntries(mounts.map((m) => [m.mountPoint, m]));
  const mountProbe = await probeMount();
  const problems = collectProblems(status, byPoint, mountProbe, expected);
  return {
    ok: problems.length === 0,
    problems,
    pid: process.pid,
    uid: status.uid,
    gid: status.gid,
    hostname: os.hostname(),
    caps: { eff: status.capEff, prm: status.capPrm, bnd: status.capBnd, amb: status.capAmb },
    noNewPrivs: status.noNewPrivs,
    seccomp: status.seccomp,
    uidMap,
    gidMap,
    mountDenied: mountProbe.denied,
    mounts: {
      root: byPoint['/']?.fsType ?? null,
      runtime: byPoint['/opt/workbox']?.options ?? null,
      run: byPoint['/run/workbox']?.fsType ?? null,
      count: mounts.length,
    },
  };
}
