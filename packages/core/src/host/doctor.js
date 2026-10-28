import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CgroupManager, REQUIRED_CONTROLLERS } from './cgroup.js';
import { removeUnder } from './safefs.js';
import { PROXY_LINK, NET_DEFAULTS, proxyLinkArgv } from './netns.js';
import { ensureRootAccess } from './launch.js';

export const Status = Object.freeze({ PASS: 'pass', FAIL: 'fail', WARN: 'warn' });

/** Oldest Node.js the daemon and CLI support (package.json engines). */
export const MIN_NODE = '22.13.0';

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

/**
 * Entries of users other than `identities` whose range overlaps base..base+count-1.
 * @param {string} text
 * @param {string[]} identities
 * @param {number} base
 * @param {number} count
 * @returns {string[]} the overlapping lines, e.g. ["alice:150000:65536"]
 */
export function subidOverlaps(text, identities, base, count) {
  const out = [];
  for (const line of text.split('\n')) {
    const [who, start, n] = line.trim().split(':');
    if (!who || identities.includes(who) || !/^\d+$/.test(start ?? '') || !/^\d+$/.test(n ?? ''))
      continue;
    if (Number(start) < base + count && Number(start) + Number(n) > base) out.push(line.trim());
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

/** Where the kernel reports its devices and modules; tests point these at fixtures. */
export const KERNEL_PATHS = Object.freeze({
  tun: '/dev/net/tun',
  modules: '/sys/module',
  libModules: '/lib/modules',
});

/**
 * Probe every host prerequisite. Fails are blocking; warns are degraded or optional features.
 * The overlay probe runs under the Workbox root, which it prepares as the daemon does.
 * @param {import('../config.js').Config} config
 * @param {{uid?: number, release?: string, env?: NodeJS.ProcessEnv, nodeVersion?: string, kernel?: Partial<typeof KERNEL_PATHS>}} [opts]
 * @returns {Promise<{ok: boolean, checks: Check[]}>}
 */
export async function runDoctor(config, opts = {}) {
  const ctx = {
    uid: opts.uid ?? process.getuid(),
    release: opts.release ?? os.release(),
    env: opts.env ?? process.env,
    node: opts.nodeVersion ?? process.versions.node,
    kernel: { ...KERNEL_PATHS, ...opts.kernel },
  };
  const assets = assetChecks(config);
  const checks = [
    privilegesCheck(ctx.uid),
    kernelCheck(ctx.release),
    nodeCheck(ctx.node),
    await bwrapCheck(),
    await unshareCheck(),
    ...toolChecks(ctx.env),
    xzCheck(ctx.env, assets.find((c) => c.id === 'runtime').status === Status.PASS),
    ...subidChecks('subuid', '/etc/subuid', config.uid, ctx.uid),
    ...subidChecks('subgid', '/etc/subgid', config.uid, ctx.uid),
    usernsCheck(),
    await overlayProbe(config.paths.root, config.uid),
    await cgroupCheck(config),
    ...(await networkToolChecks(config.network.mode)),
    ...networkDeviceChecks(config.network.mode, ctx.kernel, ctx.release),
    await proxyLinkCheck(),
    await dockerCheck(),
    ...assets,
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
      'Upgrade to Linux 5.14 or newer for cgroup.kill.',
    );
  return check('kernel', title, Status.PASS, `kernel ${release}`);
}

/**
 * The Node.js running the daemon and CLI against MIN_NODE.
 * @param {string} version e.g. process.versions.node
 * @returns {Check}
 */
export function nodeCheck(version) {
  const title = `Node.js ${MIN_NODE} or newer`;
  const nv = parseVersion(version);
  if (nv && compareVersions(nv, MIN_NODE) >= 0)
    return check('node', title, Status.PASS, `node ${nv}`);
  return check(
    'node',
    title,
    Status.FAIL,
    `node ${version ?? 'unknown'}`,
    `Install Node.js ${MIN_NODE} or newer (Node 22 LTS) and run Workbox with it.`,
  );
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

/**
 * xz unpacks the Node tarball `workbox runtime install` fetches; with a runtime installed only a
 * later install needs it.
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} runtimeInstalled
 */
function xzCheck(env, runtimeInstalled) {
  const found = findInPath('xz', env.PATH);
  if (found) return check('tool.xz', 'xz present', Status.PASS, found);
  return check(
    'tool.xz',
    'xz present',
    runtimeInstalled ? Status.WARN : Status.FAIL,
    'not in PATH; workbox runtime install extracts the Node .tar.xz with it',
    'apt install xz-utils',
  );
}

/**
 * How the running kernel provides module `name`: 'loaded' (or built in with parameters) when
 * /sys/module has it, 'built in' or 'module' from /lib/modules/<release>, else null. Read-only.
 * @param {string} name
 * @param {typeof KERNEL_PATHS} kernel
 * @param {string} release
 */
export function kernelModule(name, kernel, release) {
  if (fs.existsSync(path.join(kernel.modules, name))) return 'loaded';
  const dir = path.join(kernel.libModules, release);
  const ko = new RegExp(`(^|/)${name}\\.ko(\\.[a-z]+)?$`);
  const listed = (file) => {
    try {
      return fs
        .readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .some((line) => ko.test(line.split(':')[0].trim()));
    } catch {
      return false;
    }
  };
  if (listed('modules.builtin')) return 'built in';
  if (listed('modules.dep')) return 'module';
  return null;
}

/**
 * Kernel support the egress and allowlist modes need beyond their tools: /dev/net/tun for
 * slirp4netns and the dummy link type for the host-only proxy link. Read-only: nothing is opened,
 * loaded or created.
 * @param {'none'|'egress'|'allowlist'} mode the configured default network mode
 * @param {typeof KERNEL_PATHS} kernel
 * @param {string} release
 * @returns {Check[]}
 */
export function networkDeviceChecks(mode, kernel, release) {
  const missing = mode === 'none' ? Status.WARN : Status.FAIL;
  const fallback = 'or set network.mode to none and use only network-less sandboxes';
  let tun = null;
  try {
    tun = fs.statSync(kernel.tun);
  } catch {
    tun = null;
  }
  const tunModule = kernelModule('tun', kernel, release);
  const tunCheck = tun?.isCharacterDevice()
    ? check(
        'tun',
        '/dev/net/tun for slirp4netns',
        Status.PASS,
        `${kernel.tun} is a character device`,
      )
    : check(
        'tun',
        '/dev/net/tun for slirp4netns',
        missing,
        `${kernel.tun} ${tun ? 'is not a character device' : 'missing'}; egress and allowlist sandboxes cannot start`,
        tunModule
          ? `modprobe tun (the kernel has it ${tunModule}), ${fallback}`
          : `Use a kernel built with CONFIG_TUN, ${fallback}`,
      );
  const dummy = kernelModule('dummy', kernel, release);
  const dummyCheck = dummy
    ? check('dummy', 'dummy link type for the proxy link', Status.PASS, `dummy ${dummy}`)
    : check(
        'dummy',
        'dummy link type for the proxy link',
        missing,
        `no dummy driver in ${kernel.modules} or ${path.join(kernel.libModules, release)}; the proxy link ${PROXY_LINK} cannot be created`,
        `Use a kernel built with CONFIG_DUMMY, ${fallback}`,
      );
  return [tunCheck, dummyCheck];
}

/**
 * Read-only probe of the host-only dummy link the sandbox proxies bind to: reports whether
 * `link` exists and carries `address`, and never creates or changes it.
 * @param {string} [link]
 * @param {string} [address] IPv4
 * @returns {Promise<Check>}
 */
export async function proxyLinkCheck(link = PROXY_LINK, address = NET_DEFAULTS.proxyHost) {
  const title = `Proxy link ${link} with ${address}`;
  const create = proxyLinkArgv(address)
    .map((argv) => argv.join(' ').replace(PROXY_LINK, link))
    .join(' && ');
  const r = await run('ip', ['-o', '-4', 'addr', 'show', 'dev', link]);
  if (r.code !== 0)
    return check(
      'proxy-link',
      title,
      Status.WARN,
      `${link} absent (${(r.error ?? r.stderr).trim() || `exit ${r.code}`}); the daemon creates it on the first egress or allowlist sandbox`,
      `Let the daemon create it, or run as root: ${create}`,
    );
  const inet = r.stdout.split(/\s+/).find((w) => w.split('/')[0] === address);
  if (!inet)
    return check(
      'proxy-link',
      title,
      Status.WARN,
      `${link} present without ${address}`,
      `ip addr replace ${address}/32 dev ${link}`,
    );
  return check('proxy-link', title, Status.PASS, `${link} has ${inet}`);
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

function subidChecks(id, file, uidCfg, uid) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return [
      check(
        id,
        `${file} covers the sandbox range`,
        Status.FAIL,
        e.message,
        `echo "root:${uidCfg.base}:${uidCfg.count}" >> ${file}`,
      ),
    ];
  }
  const identities = [String(uid)];
  try {
    identities.push(os.userInfo().username);
  } catch {
    // numeric identity is enough
  }
  return [
    coverageCheck(id, file, uidCfg, text, identities),
    exclusiveCheck(id, file, uidCfg, text, identities),
  ];
}

function exclusiveCheck(id, file, uidCfg, text, identities) {
  const span = `${uidCfg.base}..${uidCfg.base + uidCfg.count - 1}`;
  const title = `${file} sandbox range not shared with other users`;
  const others = subidOverlaps(text, identities, uidCfg.base, uidCfg.count);
  if (!others.length) return check(`${id}.exclusive`, title, Status.PASS, `${span} exclusive`);
  return check(
    `${id}.exclusive`,
    title,
    Status.WARN,
    `${others.join(', ')} overlaps ${span}; those users can map sandbox-owned ids`,
    `Move the overlapping entries in ${file} off ${span}, or set uid.base to a free range.`,
  );
}

function coverageCheck(id, file, uidCfg, text, identities) {
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

/** statfs magic numbers of the filesystems the overlay probe names in its detail. */
const FS_TYPES = new Map([
  [0xef53, 'ext4'],
  [0x58465342, 'xfs'],
  [0x01021994, 'tmpfs'],
  [0x9123683e, 'btrfs'],
  [0x794c7630, 'overlayfs'],
  [0x65735546, 'fuse'],
]);

function fsTypeName(dir) {
  try {
    const type = Number(fs.statfsSync(dir).type);
    return FS_TYPES.get(type) ?? `0x${type.toString(16)}`;
  } catch {
    return 'unknown';
  }
}

/**
 * The first ancestor of `dir` the mapped root (host uid and gid `base`) cannot search, or null.
 * The overlay is mounted as the mapped root, so every directory above the Workbox root must let
 * it through.
 * @param {string} dir
 * @param {number} base
 * @returns {{dir: string, mode: string, owner: string}|null}
 */
export function blockingAncestor(dir, base) {
  for (let d = path.dirname(path.resolve(dir)); ; d = path.dirname(d)) {
    const st = fs.statSync(d);
    const searchable =
      st.mode & 0o001 ||
      (st.gid === base && st.mode & 0o010) ||
      (st.uid === base && st.mode & 0o100);
    if (!searchable)
      return {
        dir: d,
        mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
        owner: `${st.uid}:${st.gid}`,
      };
    if (d === path.dirname(d)) return null;
  }
}

/**
 * Mount an overlay the way a launch does: as the mapped root, with every layer under the Workbox
 * root, so a root the mapped root cannot traverse or a filesystem that rejects being an upper
 * layer fails here rather than at the first sandbox.
 * @param {string} root
 * @param {{base: number, count: number}} uidCfg
 */
async function overlayProbe(root, uidCfg) {
  const title = 'Overlayfs inside a range-mapped user namespace';
  let dir;
  try {
    ensureRootAccess(root, uidCfg.base);
    const blocked = blockingAncestor(root, uidCfg.base);
    if (blocked)
      return check(
        'overlay',
        title,
        Status.FAIL,
        `${blocked.dir} (mode ${blocked.mode}, owner ${blocked.owner}) keeps the mapped root (uid ${uidCfg.base}) from reaching the Workbox root ${root}`,
        `chmod o+x ${blocked.dir}, or move the Workbox root under directories every user can search.`,
      );
    dir = fs.mkdtempSync(path.join(root, '.doctor-'));
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
      `${(r.stderr || r.error || `exit ${r.code}`).trim()} (Workbox root ${root} on ${fsTypeName(root)})`,
      'Check subuid/subgid coverage and kernel >= 5.11, and put the Workbox root on a filesystem overlayfs accepts as an upper layer: ext4, xfs with ftype=1 or tmpfs, never overlayfs itself.',
    );
  } catch (e) {
    return check(
      'overlay',
      title,
      Status.FAIL,
      e.message,
      `Run as root with the Workbox root ${root} writable.`,
    );
  } finally {
    if (dir) removeUnder(root, dir);
  }
}

/** Limits applied to the doctor's probe cgroup. */
const PROBE_LIMITS = Object.freeze({
  memoryBytes: 64 * 1024 * 1024,
  swapBytes: 0,
  cpuMillis: 100,
  pids: 8,
});

/**
 * Create the probe cgroup `name` under the manager's parent, run `fn` on its path and remove the
 * probe in a `finally`, killing anything that joined it, so a check that throws midway never
 * leaves a cgroup behind on the host.
 * @template T
 * @param {CgroupManager} cg
 * @param {string} name
 * @param {(probe: string) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProbeCgroup(cg, name, fn) {
  const probe = cg.create(name, PROBE_LIMITS);
  try {
    return await fn(probe);
  } finally {
    await cg.remove(probe, { timeoutMs: 5_000 });
  }
}

async function cgroupCheck(config) {
  const title = 'cgroup v2 with cpu, memory and pids delegated';
  try {
    const cg = new CgroupManager({ root: config.cgroup.root, parent: config.cgroup.parent });
    const parent = cg.ensureParent();
    const hasKill = await withProbeCgroup(cg, `doctor-${process.pid}`, (probe) =>
      fs.existsSync(path.join(probe, 'cgroup.kill')),
    );
    const missing = REQUIRED_CONTROLLERS.filter((c) => !parent.controllers.includes(c));
    if (missing.length)
      return check(
        'cgroup',
        title,
        Status.FAIL,
        `parent lacks ${missing.join(', ')}`,
        'Enable the controllers in the root cgroup.subtree_control.',
      );
    if (!hasKill)
      return check(
        'cgroup',
        title,
        Status.WARN,
        `${parent.path} delegates ${parent.controllers.join(', ')}, cgroup.kill absent`,
        'Upgrade to Linux 5.14 or newer for cgroup.kill.',
      );
    return check(
      'cgroup',
      title,
      Status.PASS,
      `${parent.path} delegates ${parent.controllers.join(', ')}, cgroup.kill available`,
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
    return check(
      'disk',
      'Free space under the Workbox root',
      Status.WARN,
      e.message,
      'Put the Workbox root on a mounted local filesystem the daemon can stat.',
    );
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
