import { spawn } from 'node:child_process';
import { ProtocolError, Codes } from '@workbox/protocol';

/**
 * PTY spawn without a native dependency: util-linux `script(1)` allocates a pty, runs the argv
 * under it and merges stdout/stderr. Available in the minimal rootfs (util-linux) and on the host.
 * Trade-off vs node-pty (spec task 2.5): no direct winsize ioctl; resize is recorded and a
 * SIGWINCH is delivered to the process group so curses apps re-read the size after `stty` input.
 */

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
  return child;
}

/**
 * Record a new size and notify the process group with SIGWINCH.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} rows
 * @param {number} cols
 * @returns {{rows: number, cols: number}}
 */
export function resizePty(child, rows, cols) {
  if (
    !Number.isInteger(rows) ||
    rows < 1 ||
    rows > 1000 ||
    !Number.isInteger(cols) ||
    cols < 1 ||
    cols > 1000
  )
    throw new ProtocolError(Codes.INVALID_PARAMS, 'rows/cols must be integers in 1..1000');
  child.ptySize = { rows, cols };
  try {
    process.kill(-child.pid, 'SIGWINCH');
  } catch {
    // group already gone
  }
  return { rows, cols };
}
