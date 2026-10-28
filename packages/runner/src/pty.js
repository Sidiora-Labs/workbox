import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { ProtocolError, Codes } from '@workbox/protocol';

/**
 * PTY spawn without a native dependency: util-linux `script(1)` allocates a pty, runs the argv
 * under it and merges stdout/stderr. Available in the minimal rootfs (util-linux) and on the host.
 * Trade-off vs node-pty (spec task 2.5): Node has no ioctl, so resize runs coreutils
 * `stty -F <slave> rows R cols C`, which issues TIOCSWINSZ on the slave; the kernel updates the
 * window size and delivers SIGWINCH to the terminal's foreground process group.
 */

/** Unix98 pty slaves use majors 136..143 (256 minors each). */
const PTS_MAJOR_FIRST = 136;
const PTS_MAJOR_LAST = 143;
const LOOKUP_ATTEMPTS = 50;
const LOOKUP_DELAY_MS = 20;

/** @param {string} s @returns {string} single-quoted shell word */
export function shellQuote(s) {
  if (typeof s !== 'string' || s.includes('\0'))
    throw new ProtocolError(Codes.INVALID_PARAMS, 'argv entries must be NUL-free strings');
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Build the script(1) argv that runs `argv` under a pty.
 * @param {string[]} argv
 * @param {{rows?: number, cols?: number}} [size]
 * @returns {string[]}
 */
export function ptyArgv(argv, size = {}) {
  const rows = size.rows ?? 24;
  const cols = size.cols ?? 80;
  const inner = `stty rows ${rows} cols ${cols} 2>/dev/null; exec ${argv.map(shellQuote).join(' ')}`;
  return ['script', '-q', '-e', '-c', inner, '/dev/null'];
}

/**
 * Spawn `argv` attached to a pty. The returned child exposes merged stdout (stderr is null).
 * @param {string[]} argv
 * @param {{cwd?: string, env?: Record<string,string>, uid?: number, gid?: number, rows?: number, cols?: number}} [opts]
 */
export function spawnPty(argv, opts = {}) {
  const a = ptyArgv(argv, opts);
  let child;
  try {
    child = spawn(a[0], a.slice(1), {
      cwd: opts.cwd,
      env: { ...opts.env, TERM: opts.env?.TERM ?? 'xterm-256color' },
      uid: opts.uid,
      gid: opts.gid,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
  } catch (e) {
    throw new ProtocolError(Codes.UNSUPPORTED, `pty spawn failed: ${e.message}`);
  }
  child.ptySize = { rows: opts.rows ?? 24, cols: opts.cols ?? 80 };
  child.ptyOwner = { uid: opts.uid, gid: opts.gid };
  return child;
}

/**
 * The slave path for a `/proc/<pid>/stat` tty_nr, or null when it is not a Unix98 pty slave.
 * @param {number} ttyNr
 * @returns {string|null}
 */
export function ptsPath(ttyNr) {
  const major = (ttyNr >> 8) & 0xfff;
  const minor = (ttyNr & 0xff) | ((ttyNr >> 12) & 0xfff00);
  if (ttyNr <= 0 || major < PTS_MAJOR_FIRST || major > PTS_MAJOR_LAST) return null;
  return `/dev/pts/${(major - PTS_MAJOR_FIRST) * 256 + minor}`;
}

/**
 * The process script(1) runs on the pty slave: script's child, the pty's session leader.
 * @param {number} pid the script(1) pid
 * @returns {{pid: number, tty: string}|null}
 */
export function ptyLeader(pid) {
  let children;
  try {
    children = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().split(/\s+/);
  } catch {
    return null;
  }
  for (const c of children.filter(Boolean)) {
    try {
      const stat = fs.readFileSync(`/proc/${c}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const tty = ptsPath(Number(fields[4]));
      if (tty) return { pid: Number(c), tty };
    } catch {
      // child exited between the listing and the read
    }
  }
  return null;
}

async function waitForLeader(child) {
  for (let i = 0; i < LOOKUP_ATTEMPTS; i++) {
    const leader = ptyLeader(child.pid);
    if (leader) return leader;
    await new Promise((r) => {
      setTimeout(r, LOOKUP_DELAY_MS);
    });
  }
  throw new ProtocolError(Codes.STATE, 'pty slave not found for the session', { pid: child.pid });
}

/**
 * Set the pty window size with TIOCSWINSZ (via `stty -F`) as the session's owner; the kernel
 * delivers SIGWINCH to the foreground process group.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} rows
 * @param {number} cols
 * @returns {Promise<{rows: number, cols: number}>}
 */
export async function resizePty(child, rows, cols) {
  if (
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 1000 ||
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > 1000
  )
    throw new ProtocolError(Codes.INVALID_PARAMS, 'rows/cols must be integers in 1..1000');
  const leader = await waitForLeader(child);
  await new Promise((resolve, reject) => {
    execFile(
      'stty',
      ['-F', leader.tty, 'rows', String(rows), 'cols', String(cols)],
      { uid: child.ptyOwner?.uid, gid: child.ptyOwner?.gid, timeout: 5000 },
      (e, _out, err) =>
        e
          ? reject(
              new ProtocolError(Codes.UNAVAILABLE, `pty resize failed: ${err.trim() || e.message}`),
            )
          : resolve(),
    );
  });
  child.ptySize = { rows, cols };
  return { rows, cols };
}

/**
 * Signal the process group running on the pty slave; script(1) itself is signalled by the caller.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} signal
 * @returns {boolean} true when a group was signalled
 */
export function signalPtyGroup(child, signal) {
  const leader = ptyLeader(child.pid);
  if (!leader) return false;
  try {
    process.kill(-leader.pid, signal);
    return true;
  } catch {
    return false;
  }
}
