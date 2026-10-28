import { newId } from '@workbox/protocol';
import { E } from '../errors.js';

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * @typedef {object} ExecResult
 * @property {string} sessionId
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {string} stdout
 * @property {string} stderr
 * @property {{stdout: boolean, stderr: boolean}} truncated
 * @property {boolean} timedOut
 * @property {number} durationMs
 */

/** Bounded per-stream capture that records truncation instead of growing. */
class Capture {
  /** @param {number} maxBytes */
  constructor(maxBytes) {
    this.max = maxBytes;
    this.buffers = { stdout: [], stderr: [] };
    this.sizes = { stdout: 0, stderr: 0 };
    this.truncated = { stdout: false, stderr: false };
  }

  /** @param {'stdout'|'stderr'} stream @param {Buffer} data */
  push(stream, data) {
    const room = this.max - this.sizes[stream];
    if (room <= 0) {
      this.truncated[stream] = true;
      return;
    }
    const slice = data.length > room ? data.subarray(0, room) : data;
    if (slice.length < data.length) this.truncated[stream] = true;
    this.buffers[stream].push(slice);
    this.sizes[stream] += slice.length;
  }

  /**
   * The captured text. A truncated stream drops the partial character the byte cap cut through,
   * so the result never ends in a replacement character the program did not write.
   * @param {'stdout'|'stderr'} stream
   */
  text(stream) {
    const buf = Buffer.concat(this.buffers[stream]);
    const end = this.truncated[stream] ? utf8Boundary(buf) : buf.length;
    return buf.subarray(0, end).toString('utf8');
  }
}

/**
 * Length of `buf` without a trailing incomplete UTF-8 sequence: when the last lead byte within
 * the final four bytes announces more continuation bytes than follow it, cut before that lead.
 * Bytes that are not UTF-8 at all are left for the decoder to replace.
 * @param {Buffer} buf
 * @returns {number}
 */
export function utf8Boundary(buf) {
  const end = buf.length;
  for (let i = end - 1; i >= 0 && i >= end - 4; i--) {
    const b = buf[i];
    if ((b & 0xc0) === 0x80) continue;
    let need = 1;
    if ((b & 0xe0) === 0xc0) need = 2;
    else if ((b & 0xf0) === 0xe0) need = 3;
    else if ((b & 0xf8) === 0xf0) need = 4;
    return i + need > end ? i : end;
  }
  return end;
}

/**
 * Run a command inside a sandbox to completion with a deadline and bounded capture.
 * `target` is anything with `request(method, params)` and `on/off('event', fn)`: a Supervisor.
 * Output beyond maxOutputBytes per stream is dropped and reported through `truncated`.
 * @param {{request: Function, on: Function, off: Function}} target
 * @param {{argv: string[], cwd?: string, env?: Record<string,string>, uid?: number, gid?: number, input?: string|Buffer, timeoutMs?: number, maxOutputBytes?: number, graceMs?: number, name?: string}} opts
 * @returns {Promise<ExecResult>}
 */
function validateExecOpts(opts) {
  if (!Array.isArray(opts.argv) || opts.argv.length === 0)
    throw E.invalid('argv must be a non-empty array');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const graceMs = opts.graceMs ?? 2000;
  const maxOut = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const check = (value, min, max, name) => {
    if (!Number.isInteger(value) || value < min || value > max)
      throw E.invalid(`${name} must be an integer in ${min}..${max}`, { [name]: value });
  };
  check(timeoutMs, 1, 3_600_000, 'timeoutMs');
  check(graceMs, 0, 600_000, 'graceMs');
  check(maxOut, 0, 64 * 1024 * 1024, 'maxOutputBytes');
  return { timeoutMs, graceMs, maxOut };
}

export async function exec(target, opts) {
  const { timeoutMs, graceMs, maxOut } = validateExecOpts(opts);
  const started = Date.now();
  const capture = new Capture(maxOut);
  const run = { sessionId: null, exit: null, resolveExit: null };
  const exited = new Promise((resolve) => {
    run.resolveExit = resolve;
  });
  const onEvent = (method, params) => {
    if (!params || params.sessionId !== run.sessionId) return;
    if (
      method === 'session.output' &&
      (params.stream === 'stdout' || params.stream === 'stderr' || params.stream === 'pty') &&
      typeof params.data === 'string'
    )
      capture.push(
        params.stream === 'pty' ? 'stdout' : params.stream,
        Buffer.from(params.data, 'base64'),
      );
    if (method === 'session.exit') {
      run.exit = params;
      run.resolveExit();
    }
  };
  target.on('event', onEvent);
  let timedOut = false;
  try {
    await startAndAttach(target, opts, run);
    if (!run.exit) {
      timedOut = await waitOrTimeout(exited, timeoutMs);
      if (timedOut) run.exit = await stopAfterTimeout(target, run, graceMs);
    }
    return {
      sessionId: run.sessionId,
      exitCode: run.exit?.code ?? null,
      signal: run.exit?.signal ?? null,
      stdout: capture.text('stdout'),
      stderr: capture.text('stderr'),
      truncated: capture.truncated,
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    target.off('event', onEvent);
    if (run.sessionId)
      await target.request('session.remove', { sessionId: run.sessionId }).catch(() => undefined);
  }
}

async function startAndAttach(target, opts, run) {
  const name = opts.name ?? `exec-${newId().slice(-8).toLowerCase()}`;
  const info = await target.request('session.start', {
    argv: opts.argv,
    cwd: opts.cwd,
    env: opts.env,
    uid: opts.uid,
    gid: opts.gid,
    name,
  });
  run.sessionId = info.sessionId;
  const attached = await target.request('session.attach', { sessionId: run.sessionId, fromSeq: 0 });
  if (attached.exited && !run.exit)
    run.exit = { code: attached.exited.code, signal: attached.exited.signal };
  if (opts.input !== undefined && !run.exit) {
    await target.request('session.input', {
      sessionId: run.sessionId,
      data: Buffer.from(opts.input).toString('base64'),
      eof: true,
    });
  }
}

async function stopAfterTimeout(target, run, graceMs) {
  const stopped = await target.request(
    'session.stop',
    { sessionId: run.sessionId, graceMs },
    { timeoutMs: graceMs + 10_000 },
  );
  return run.exit ?? { code: stopped.exited?.code ?? null, signal: stopped.exited?.signal ?? null };
}

/**
 * @param {Promise<void>} promise
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} true when the timeout won
 */
function waitOrTimeout(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(true), timeoutMs);
  });
  return Promise.race([promise.then(() => false), deadline]).finally(() => clearTimeout(timer));
}
