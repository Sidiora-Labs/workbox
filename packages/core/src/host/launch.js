import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newId, PROTOCOL_VERSION } from '@workbox/protocol';
import { E } from '../errors.js';

export const LAUNCH_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/launch.sh',
);
export const RUNTIME_MOUNT = '/opt/workbox';
export const RUN_MOUNT = '/run/workbox';
export const RUNNER_SOCKET = 'runner.sock';
export const BOOT_FILE = 'boot.json';
export const LAUNCH_LOG = 'launch.log';

/** The fourteen capabilities every sandbox process keeps. Mirrors packages/runner/bin/init.sh. */
export const CAPABILITIES = Object.freeze([
  'CAP_CHOWN',
  'CAP_DAC_OVERRIDE',
  'CAP_FOWNER',
  'CAP_FSETID',
  'CAP_KILL',
  'CAP_SETGID',
  'CAP_SETUID',
  'CAP_SETPCAP',
  'CAP_NET_BIND_SERVICE',
  'CAP_NET_RAW',
  'CAP_SYS_CHROOT',
  'CAP_MKNOD',
  'CAP_AUDIT_WRITE',
  'CAP_SETFCAP',
]);

/** Effective capability mask for CAPABILITIES, as /proc/<pid>/status prints it. */
export const CAPABILITY_MASK = '00000000a80425fb';

export const SANDBOX_PATH =
  '/opt/workbox/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * @typedef {object} SandboxDirs
 * @property {string} root <sandboxes>/<id>
 * @property {string} upper overlay upper layer (the sandbox's writable filesystem)
 * @property {string} work overlay work directory
 * @property {string} merged mount point for the overlay inside the launch namespace
 * @property {string} run bind-mounted at /run/workbox: socket, boot file, outbox, inbox
 * @property {string} etc generated resolv.conf, hosts and hostname
 * @property {string} log launch.log
 */

/**
 * @param {string} sandboxesDir
 * @param {string} id
 * @returns {SandboxDirs}
 */
export function sandboxDirs(sandboxesDir, id) {
  if (typeof id !== 'string' || !/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))
    throw E.invalid(`invalid sandbox id ${id}`, { id });
  const root = path.resolve(sandboxesDir, id);
  if (!root.startsWith(`${path.resolve(sandboxesDir)}${path.sep}`))
    throw E.invalid(`sandbox id ${id} escapes its directory`, { id });
  return {
    root,
    upper: path.join(root, 'upper'),
    work: path.join(root, 'work'),
    merged: path.join(root, 'merged'),
    run: path.join(root, 'run'),
    etc: path.join(root, 'etc'),
    log: path.join(root, LAUNCH_LOG),
  };
}

/**
 * Create the per-sandbox directories owned by the mapped root (uid base) and write the files
 * bwrap binds over /etc. Idempotent for an existing sandbox.
 * @param {SandboxDirs} dirs
 * @param {{uidBase: number, hostname: string, nameservers: string[], address?: string}} opts
 */
export function prepareDirs(dirs, opts) {
  // The mapped root (uid base) must traverse every ancestor of upper/work to mount the overlay.
  const sandboxesDir = path.dirname(dirs.root);
  fs.mkdirSync(sandboxesDir, { recursive: true, mode: 0o755 });
  fs.chmodSync(sandboxesDir, 0o755);
  fs.mkdirSync(dirs.root, { recursive: true, mode: 0o711 });
  fs.chmodSync(dirs.root, 0o711);
  for (const d of [
    dirs.upper,
    dirs.work,
    dirs.merged,
    dirs.run,
    path.join(dirs.run, 'outbox'),
    path.join(dirs.run, 'inbox'),
  ]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.chownSync(d, opts.uidBase, opts.uidBase);
  }
  fs.mkdirSync(dirs.etc, { recursive: true, mode: 0o755 });
  const resolv = opts.nameservers.map((ns) => `nameserver ${ns}\n`).join('') || '# no network\n';
  fs.writeFileSync(path.join(dirs.etc, 'resolv.conf'), `${resolv}options ndots:0\n`, {
    mode: 0o644,
  });
  const hosts = ['127.0.0.1\tlocalhost', '::1\tlocalhost ip6-localhost ip6-loopback'];
  if (opts.address) hosts.push(`${opts.address}\t${opts.hostname}`);
  else hosts.push(`127.0.1.1\t${opts.hostname}`);
  fs.writeFileSync(path.join(dirs.etc, 'hosts'), `${hosts.join('\n')}\n`, { mode: 0o644 });
  fs.writeFileSync(path.join(dirs.etc, 'hostname'), `${opts.hostname}\n`, { mode: 0o644 });
}

/**
 * Write the single-use boot identity into the run directory. Returns the record for the store.
 * @param {SandboxDirs} dirs
 * @param {{sandboxId: string, uidBase: number, runtimeVersion: string}} opts
 * @returns {{bootId: string, nonce: string, nonceHash: string}}
 */
export function writeBootFile(dirs, opts) {
  const bootId = newId();
  const nonce = randomBytes(32).toString('hex');
  const hostToken = randomBytes(32).toString('hex');
  const file = path.join(dirs.run, BOOT_FILE);
  const body = {
    bootId,
    nonce,
    hostTokenHash: hashNonce(hostToken),
    sandboxId: opts.sandboxId,
    protocol: PROTOCOL_VERSION,
    runtime: opts.runtimeVersion,
    socket: `${RUN_MOUNT}/${RUNNER_SOCKET}`,
    issuedAt: Date.now(),
  };
  fs.writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  fs.chownSync(file, opts.uidBase, opts.uidBase);
  // Host-only token file: dirs.root is not bind-mounted into the box (only dirs.run is).
  fs.writeFileSync(path.join(dirs.root, 'host-token'), `${hostToken}\n`, { mode: 0o600 });
  return { bootId, nonce, nonceHash: hashNonce(nonce), hostToken };
}

/** Read the host-only control token written by writeBootFile, if present. @param {SandboxDirs} dirs */
export function readHostToken(dirs) {
  try {
    return fs.readFileSync(path.join(dirs.root, 'host-token'), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** @param {string} nonce */
export function hashNonce(nonce) {
  return createHash('sha256').update(nonce).digest('hex');
}

/**
 * @typedef {object} LaunchSpec
 * @property {string} sandboxId
 * @property {string} hostname
 * @property {string} rootfsDir host path of the shifted rootfs
 * @property {string} runtimeDir host path of the concrete runtime version
 * @property {SandboxDirs} dirs
 * @property {string} cgroupPath
 * @property {{base: number, count: number}} uid
 * @property {Record<string, string>} [env] extra environment for the runner
 * @property {number} [seccompFd] file descriptor carrying a compiled seccomp program
 * @property {Buffer} [seccompProgram] compiled program; spawnSandbox passes it on fd 3
 */

/**
 * The bwrap argument vector for a sandbox.
 * @param {LaunchSpec} spec
 * @returns {string[]}
 */
export function bwrapArgs(spec) {
  const d = spec.dirs;
  const args = [
    '--unshare-pid',
    '--unshare-net',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup',
    '--new-session',
    '--hostname',
    spec.hostname,
    '--bind',
    d.merged,
    '/',
    '--ro-bind',
    spec.runtimeDir,
    RUNTIME_MOUNT,
    '--bind',
    d.run,
    RUN_MOUNT,
    '--ro-bind',
    path.join(d.etc, 'resolv.conf'),
    '/etc/resolv.conf',
    '--ro-bind',
    path.join(d.etc, 'hosts'),
    '/etc/hosts',
    '--ro-bind',
    path.join(d.etc, 'hostname'),
    '/etc/hostname',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    '/tmp',
    '--tmpfs',
    '/dev/shm',
    '--chdir',
    '/workspace',
    '--clearenv',
  ];
  const env = {
    PATH: SANDBOX_PATH,
    HOME: '/root',
    USER: 'root',
    LOGNAME: 'root',
    SHELL: '/bin/bash',
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TMPDIR: '/tmp',
    WORKBOX_SANDBOX: spec.sandboxId,
    WORKBOX_RUN: RUN_MOUNT,
    ...(spec.env ?? {}),
  };
  for (const [k, val] of Object.entries(env)) args.push('--setenv', k, String(val));
  args.push('--cap-drop', 'ALL');
  for (const cap of CAPABILITIES) args.push('--cap-add', cap);
  if (spec.seccompFd !== undefined) args.push('--seccomp', String(spec.seccompFd));
  args.push('--', `${RUNTIME_MOUNT}/bin/init.sh`);
  return args;
}

/**
 * Environment for packages/core/scripts/launch.sh.
 * @param {LaunchSpec} spec
 */
export function launchEnv(spec) {
  return {
    PATH: process.env.PATH ?? '/usr/sbin:/usr/bin:/sbin:/bin',
    WB_CGROUP: spec.cgroupPath,
    WB_MAP: `${spec.uid.base},0,${spec.uid.count}`,
    WB_LOWER: spec.rootfsDir,
    WB_UPPER: spec.dirs.upper,
    WB_WORK: spec.dirs.work,
    WB_MERGED: spec.dirs.merged,
  };
}

/**
 * Spawn the launch chain detached from the daemon, stderr appended to launch.log.
 * The returned pid is bwrap's host pid for the sandbox's lifetime.
 * @param {LaunchSpec} spec
 * @returns {{pid: number, child: import('node:child_process').ChildProcess}}
 */
export function spawnSandbox(spec) {
  if (!fs.existsSync(LAUNCH_SCRIPT))
    throw E.unavailable(`launch script missing at ${LAUNCH_SCRIPT}`, { path: LAUNCH_SCRIPT });
  const logFd = fs.openSync(spec.dirs.log, 'a', 0o600);
  let seccompFd = spec.seccompFd;
  let seccompFileFd = null;
  if (seccompFd === undefined && Buffer.isBuffer(spec.seccompProgram)) {
    const file = path.join(spec.dirs.run, 'seccomp.bpf');
    fs.writeFileSync(file, spec.seccompProgram, { mode: 0o600 });
    seccompFileFd = fs.openSync(file, 'r');
    seccompFd = 3;
  }
  try {
    const stdio = ['ignore', 'ignore', logFd];
    if (seccompFileFd !== null) stdio.push(seccompFileFd);
    const child = spawn('/bin/sh', [LAUNCH_SCRIPT, ...bwrapArgs({ ...spec, seccompFd })], {
      env: launchEnv(spec),
      detached: true,
      stdio,
    });
    if (seccompFd === undefined) child.unref();
    if (!child.pid) throw E.unavailable('launch chain did not start', { log: spec.dirs.log });
    return { pid: child.pid, child };
  } finally {
    fs.closeSync(logFd);
    if (seccompFileFd !== null) fs.closeSync(seccompFileFd);
  }
}

/**
 * True while a process with this pid exists (a reaped child no longer does).
 * @param {number} pid
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** @param {SandboxDirs} dirs @param {number} [maxBytes] */
export function readLaunchLog(dirs, maxBytes = 16 * 1024) {
  try {
    const text = fs.readFileSync(dirs.log, 'utf8');
    return text.length > maxBytes ? text.slice(-maxBytes) : text;
  } catch {
    return '';
  }
}

/**
 * Remove every sandbox directory. The overlay lives only inside the sandbox mount namespace, so
 * nothing needs unmounting on the host once the processes are gone.
 * @param {SandboxDirs} dirs
 */
export function removeDirs(dirs) {
  fs.rmSync(dirs.root, { recursive: true, force: true });
}

/** True when any host mount references the sandbox directory (there should be none). @param {SandboxDirs} dirs */
export function hostMountsFor(dirs) {
  const info = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  return info
    .split('\n')
    .filter((l) => l.includes(dirs.root))
    .map((l) => l.split(' ')[4]);
}
