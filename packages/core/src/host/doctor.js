import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CgroupManager, REQUIRED_CONTROLLERS } from './cgroup.js';

export const Status = Object.freeze({ PASS: 'pass', FAIL: 'fail', WARN: 'warn' });

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {string} title
 * @property {'pass'|'fail'|'warn'} status
 * @property {string} detail
 * @property {string} [remedy]
 */

/**
 * Run a command, never throwing. Missing binaries yield code null and an error string.
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeoutMs?: number, input?: string}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, error?: string}>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 5000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT')
          return resolve({ code: null, stdout: '', stderr: '', error: `${cmd} not found` });
        if (err && typeof err.code !== 'number')
          return resolve({
            code: null,
            stdout: String(stdout),
            stderr: String(stderr),
            error: err.message,
          });
        resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** First dotted version in a text, e.g. "bubblewrap 0.9.0" -> "0.9.0". @param {string} text */
export function parseVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text ?? '');
  return m ? `${m[1]}.${m[2]}.${m[3] ?? '0'}` : null;
}

/** @param {string} a @param {string} b @returns {-1|0|1} */
export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Parse /etc/subuid or /etc/subgid lines for one user (by name or numeric id).
 * @param {string} text
 * @param {string[]} identities names or ids that denote the user
 * @returns {{start: number, count: number}[]}
 */
export function parseSubid(text, identities) {
  const out = [];
  for (const line of text.split('\n')) {
    const [who, start, count] = line.trim().split(':');
    if (identities.includes(who) && /^\d+$/.test(start ?? '') && /^\d+$/.test(count ?? ''))
      out.push({ start: Number(start), count: Number(count) });
  }
  return out;
}

/** @param {{start: number, count: number}[]} ranges */
export function coversRange(ranges, base, count) {
  return ranges.some((r) => r.start <= base && r.start + r.count >= base + count);
}

/** @param {string} name @param {string} [pathVar] */
export function findInPath(name, pathVar = process.env.PATH ?? '') {
  for (const dir of pathVar.split(':').filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // keep looking
    }
  }
  return null;
}

const check = (id, title, status, detail, remedy) => ({
  id,
  title,
  status,
  detail,
  ...(remedy ? { remedy } : {}),
});

/**
 * Probe every host prerequisite. Fails are blocking; warns are degraded or optional features.
 * @param {import('../config.js').Config} config
 * @param {{uid?: number, release?: string, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{ok: boolean, checks: Check[]}>}
 */
export async function runDoctor(config, opts = {}) {
  const ctx = {
    uid: opts.uid ?? process.getuid(),
    release: opts.release ?? os.release(),
    env: opts.env ?? process.env,
  };
  const checks = [
    privilegesCheck(ctx.uid),
    kernelCheck(ctx.release),
    await bwrapCheck(),
    await unshareCheck(),
    ...toolChecks(ctx.env),
    subidCheck('subuid', '/etc/subuid', config.uid, ctx.uid),
    subidCheck('subgid', '/etc/subgid', config.uid, ctx.uid),
    usernsCheck(),
    await overlayProbe(config.uid),
    cgroupCheck(config),
    ...(await networkToolChecks(config.network.mode)),
    await dockerCheck(),
    ...assetChecks(config),
    diskCheck(config.paths.root),
  ];
  return { ok: checks.every((c) => c.status !== Status.FAIL), checks };
}

function privilegesCheck(uid) {
  if (uid === 0) return check('privileges', 'Running as root', Status.PASS, `uid ${uid}`);
  return check(
    'privileges',
    'Running as root',
    Status.FAIL,
    `uid ${uid}`,
    'Run the Workbox daemon as root; it needs CAP_SYS_ADMIN for cgroups and namespaces.',
  );
}

function kernelCheck(release) {
  const title = 'Kernel 5.14 or newer';
  const kver = parseVersion(release);
  if (!kver || compareVersions(kver, '5.11.0') < 0)
    return check(
      'kernel',
      title,
      Status.FAIL,
      `kernel ${release}`,
      'Linux 5.11 adds unprivileged overlayfs; 5.14 adds cgroup.kill. Upgrade the kernel.',
    );
  if (compareVersions(kver, '5.14.0') < 0)
    return check(
      'kernel',
      title,
      Status.WARN,
      `kernel ${release}: cgroup.kill absent, per-pid SIGKILL fallback in use`,
    );
  return check('kernel', title, Status.PASS, `kernel ${release}`);
}

async function bwrapCheck() {
  const r = await run('bwrap', ['--version']);
  const bv = parseVersion(r.stdout);
  if (!bv)
    return check(
      'bwrap',
      'bubblewrap present',
      Status.FAIL,
      r.error ?? r.stderr,
      'apt install bubblewrap',
    );
  const note =
    compareVersions(bv, '0.10.0') < 0 ? ' (overlay mounted by the launch chain, not by bwrap)' : '';
  return check('bwrap', 'bubblewrap present', Status.PASS, `bubblewrap ${bv}${note}`);
}

async function unshareCheck() {
  const title = 'util-linux unshare 2.38+';
  const r = await run('unshare', ['--version']);
  const uv = parseVersion(r.stdout);
  if (!uv || compareVersions(uv, '2.38.0') < 0)
    return check(
      'unshare',
      title,
      Status.FAIL,
      uv ? `unshare ${uv}` : (r.error ?? 'unavailable'),
      'Install util-linux 2.38 or newer for --map-users and --setuid.',
    );
  return check('unshare', title, Status.PASS, `unshare ${uv}`);
}

function toolChecks(env) {
  return ['newuidmap', 'newgidmap', 'nsenter', 'setpriv', 'mount', 'tar'].map((tool) => {
    const found = findInPath(tool, env.PATH);
    if (found) return check(`tool.${tool}`, `${tool} present`, Status.PASS, found);
    return check(
      `tool.${tool}`,
      `${tool} present`,
      Status.FAIL,
      'not in PATH',
      tool.startsWith('new') ? 'apt install uidmap' : 'apt install util-linux tar',
    );
  });
}

function usernsCheck() {
  const maxNs = readNumber('/proc/sys/user/max_user_namespaces');
  if (maxNs > 0)
    return check('userns', 'User namespaces enabled', Status.PASS, `max_user_namespaces ${maxNs}`);
  return check(
    'userns',
    'User namespaces enabled',
    Status.FAIL,
    `max_user_namespaces ${maxNs}`,
    'sysctl -w user.max_user_namespaces=65536',
  );
}

async function networkToolChecks(mode) {
  const tools = [
    ['slirp4netns', 'egress and allowlist network modes', 'slirp4netns'],
    ['nft', 'egress policy enforcement', 'nftables'],
  ];
  const out = [];
  for (const [tool, feature, pkg] of tools) {
    const r = await run(tool, ['--version']);
    const ver = parseVersion(`${r.stdout}\n${r.stderr}`);
    if (ver) out.push(check(`tool.${tool}`, `${tool} present`, Status.PASS, `${tool} ${ver}`));
    else
      out.push(
        check(
          `tool.${tool}`,
          `${tool} present`,
          mode === 'none' ? Status.WARN : Status.FAIL,
          `${r.error ?? 'unavailable'}; needed for ${feature}`,
          `apt install ${pkg}`,
        ),
      );
  }
  return out;
}

async function dockerCheck() {
  const title = 'Docker available for rootfs builds';
  const r = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (r.code === 0) return check('docker', title, Status.PASS, `docker ${r.stdout.trim()}`);
  return check(
    'docker',
    title,
    Status.WARN,
    r.error ?? r.stderr.trim() ?? 'unavailable',
    'Install Docker, or build the rootfs on another host and copy it.',
  );
}

function assetChecks(config) {
  const rootfsManifest = path.join(config.paths.rootfs, config.rootfs, 'manifest.json');
  const runtimeManifest = path.join(config.paths.runtime, config.runtime, 'manifest.json');
  return [
    fs.existsSync(rootfsManifest)
      ? check('rootfs', `Rootfs ${config.rootfs} installed`, Status.PASS, rootfsManifest)
      : check(
          'rootfs',
          `Rootfs ${config.rootfs} installed`,
          Status.WARN,
          `${rootfsManifest} missing`,
          `workbox rootfs build ${config.rootfs}`,
        ),
    fs.existsSync(runtimeManifest)
      ? check('runtime', `Runtime ${config.runtime} installed`, Status.PASS, runtimeManifest)
      : check(
          'runtime',
          `Runtime ${config.runtime} installed`,
          Status.WARN,
          `${runtimeManifest} missing`,
          'workbox runtime install',
        ),
  ];
}

function subidCheck(id, file, uidCfg, uid) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return check(
      id,
      `${file} covers the sandbox range`,
      Status.FAIL,
      e.message,
      `echo "root:${uidCfg.base}:${uidCfg.count}" >> ${file}`,
    );
  }
  const identities = [String(uid)];
  try {
    identities.push(os.userInfo().username);
  } catch {
    // numeric identity is enough
  }
  const ranges = parseSubid(text, identities);
  const ok = coversRange(ranges, uidCfg.base, uidCfg.count);
  return ok
    ? check(
        id,
        `${file} covers the sandbox range`,
        Status.PASS,
        `${uidCfg.base}..${uidCfg.base + uidCfg.count - 1} covered`,
      )
    : check(
        id,
        `${file} covers the sandbox range`,
        Status.FAIL,
        `no entry for ${identities.join('/')} covering ${uidCfg.base}..${uidCfg.base + uidCfg.count - 1}`,
        `echo "${identities[identities.length - 1]}:${uidCfg.base}:${uidCfg.count}" >> ${file}`,
      );
}

async function overlayProbe(uidCfg) {
  const title = 'Overlayfs inside a range-mapped user namespace';
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbox-doctor-'));
    for (const d of ['lower', 'upper', 'work', 'merged']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'lower', 'probe'), 'ok');
    for (const d of ['', 'lower', 'lower/probe', 'upper', 'work', 'merged'])
      fs.chownSync(path.join(dir, d), uidCfg.base, uidCfg.base);
    const map = `${uidCfg.base},0,${uidCfg.count}`;
    const script = `mount -t overlay overlay -o lowerdir=${dir}/lower,upperdir=${dir}/upper,workdir=${dir}/work ${dir}/merged && cat ${dir}/merged/probe`;
    const r = await run(
      'unshare',
      [
        '--user',
        '--mount',
        `--map-users=${map}`,
        `--map-groups=${map}`,
        '--setuid',
        '0',
        '--setgid',
        '0',
        '--',
        'sh',
        '-c',
        script,
      ],
      { timeoutMs: 10_000 },
    );
    if (r.code === 0 && r.stdout.trim() === 'ok')
      return check('overlay', title, Status.PASS, `mapped ${map}, overlay mounted and read`);
    return check(
      'overlay',
      title,
      Status.FAIL,
      (r.stderr || r.error || `exit ${r.code}`).trim(),
      'Check subuid/subgid coverage, kernel >= 5.11 and that the filesystem under the Workbox root supports overlayfs (ext4 or xfs with ftype=1).',
    );
  } catch (e) {
    return check(
      'overlay',
      title,
      Status.FAIL,
      e.message,
      'Run as root with a writable temp directory.',
    );
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function cgroupCheck(config) {
  const title = 'cgroup v2 with cpu, memory and pids delegated';
  try {
    const cg = new CgroupManager({ root: config.cgroup.root, parent: config.cgroup.parent });
    const parent = cg.ensureParent();
    const probe = cg.create(`doctor-${process.pid}`, {
      memoryBytes: 64 * 1024 * 1024,
      swapBytes: 0,
      cpuMillis: 100,
      pids: 8,
    });
    const hasKill = fs.existsSync(path.join(probe, 'cgroup.kill'));
    fs.rmdirSync(probe);
    const missing = REQUIRED_CONTROLLERS.filter((c) => !parent.controllers.includes(c));
    if (missing.length)
      return check(
        'cgroup',
        title,
        Status.FAIL,
        `parent lacks ${missing.join(', ')}`,
        'Enable the controllers in the root cgroup.subtree_control.',
      );
    return check(
      'cgroup',
      title,
      hasKill ? Status.PASS : Status.WARN,
      `${parent.path} delegates ${parent.controllers.join(', ')}${hasKill ? ', cgroup.kill available' : ', cgroup.kill absent'}`,
    );
  } catch (e) {
    return check(
      'cgroup',
      title,
      Status.FAIL,
      e.message,
      'Boot with systemd.unified_cgroup_hierarchy=1 and run as root.',
    );
  }
}

function diskCheck(root) {
  let probe = root;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    const st = fs.statfsSync(probe);
    const free = Number(st.bavail) * Number(st.bsize);
    const gib = (free / 1024 ** 3).toFixed(1);
    if (free >= 5 * 1024 ** 3)
      return check(
        'disk',
        'Free space under the Workbox root',
        Status.PASS,
        `${gib} GiB free at ${probe}`,
      );
    if (free >= 1024 ** 3)
      return check(
        'disk',
        'Free space under the Workbox root',
        Status.WARN,
        `${gib} GiB free at ${probe}`,
        'Free at least 5 GiB for rootfs, runtime and sandbox layers.',
      );
    return check(
      'disk',
      'Free space under the Workbox root',
      Status.FAIL,
      `${gib} GiB free at ${probe}`,
      'Free at least 5 GiB.',
    );
  } catch (e) {
    return check('disk', 'Free space under the Workbox root', Status.WARN, e.message);
  }
}

function readNumber(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim());
  } catch {
    return 0;
  }
}

/**
 * Human-readable report, one line per check.
 * @param {{ok: boolean, checks: Check[]}} report
 */
export function formatReport(report) {
  const mark = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };
  const lines = report.checks.map(
    (c) =>
      `${mark[c.status]}  ${c.title}: ${c.detail}${c.remedy ? `\n      remedy: ${c.remedy}` : ''}`,
  );
  lines.push(report.ok ? 'doctor: host is ready' : 'doctor: host is NOT ready');
  return lines.join('\n');
}
