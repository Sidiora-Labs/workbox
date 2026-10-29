import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  MAX_WAIT_MS,
  openSandboxFile,
  readSessionOutput,
  waitForSessionExit,
  writeSandboxFile,
} from '@workbox/server';
import { parseOpts, sessionExitCode } from './commands.js';

/**
 * Background sessions and file copies for `workbox sandbox`: `run`, `logs`, `wait`, `kill` and
 * `cp`. Each works against the local engine or, with `ctx.client`, a server over plain HTTP.
 */

/** Usage line of each command. */
export const CONTROL_USAGE = Object.freeze({
  run: 'workbox sandbox run <id> [--name n] [--wait] -- <cmd...>',
  logs: 'workbox sandbox logs <id> <sessionId>',
  wait: 'workbox sandbox wait <id> <sessionId> [--timeout ms]',
  kill: 'workbox sandbox kill <id> <sessionId> [--signal NAME]',
  cp: 'workbox sandbox cp <src> <dest> (one of them <id>:<path>)',
});

const BOX_PATH = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/;

/**
 * A `cp` operand: `<id>:<path>` names a sandbox path, anything else a local one.
 * @param {string} arg
 * @returns {{id: string, path: string}|{local: string}}
 */
export function parseCpTarget(arg) {
  const m = BOX_PATH.exec(arg);
  return m ? { id: m[1], path: m[2] } : { local: arg };
}

/**
 * A signal name as the API takes it: upper case with the `SIG` prefix.
 * @param {string} name e.g. `term`, `KILL`, `SIGINT`
 */
export function signalName(name) {
  const upper = String(name).toUpperCase();
  return upper.startsWith('SIG') ? upper : `SIG${upper}`;
}

/** The session and file calls of one sandbox, local or remote. */
function sandboxOps(ctx, id) {
  if (ctx.client) {
    const box = ctx.client.sandbox(id);
    return {
      start: (params) => box.startSession(params),
      read: (sessionId, fromSeq) => box.session(sessionId).output({ fromSeq }),
      wait: async (sessionId, timeoutMs) =>
        (await box.session(sessionId).wait({ timeoutMs })).exited,
      signal: (sessionId, signal) => box.session(sessionId).signal(signal),
      download: (filePath) => box.download(filePath, { stream: true }),
      upload: (filePath, source, opts) => box.upload(filePath, source, opts),
    };
  }
  const m = ctx.engine?.manager;
  if (!m) throw new Error('this command needs a local engine or --server');
  return {
    start: (params) => m.request(id, 'session.start', params),
    read: (sessionId, fromSeq) => readSessionOutput(m, id, { sessionId, fromSeq }),
    wait: (sessionId, timeoutMs) => waitForSessionExit(m, id, sessionId, { timeoutMs }),
    signal: (sessionId, signal) => m.request(id, 'session.signal', { sessionId, signal }),
    download: async (filePath) => (await openSandboxFile(m, id, filePath)).chunks,
    upload: (filePath, source, opts) => writeSandboxFile(m, id, filePath, source, opts),
  };
}

/** Wait in server-sized steps until the session exits or `timeoutMs` (default: no limit) passes. */
async function waitFor(ops, sessionId, timeoutMs) {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  for (;;) {
    const left = Math.max(0, deadline - Date.now());
    const exited = await ops.wait(sessionId, Math.min(MAX_WAIT_MS, left));
    if (exited) return exited;
    if (Date.now() >= deadline) return null;
  }
}

/** Write a session's retained output from its start: stderr to `err`, the rest to `out`. */
async function printOutput(ops, sessionId, out, err) {
  let fromSeq = 0;
  for (;;) {
    const r = await ops.read(sessionId, fromSeq);
    if (r.gap && fromSeq === 0)
      err.write(`workbox: output before chunk ${r.gap.available} was dropped from the spool\n`);
    for (const c of r.chunks)
      (c.stream === 'stderr' ? err : out).write(Buffer.from(c.data, 'base64'));
    fromSeq = r.nextSeq;
    if (!r.truncated || r.chunks.length === 0) return;
  }
}

function need(value, usage) {
  if (!value) throw coded('E_INVALID_PARAMS', usage);
  return value;
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

function millis(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw coded('E_INVALID_PARAMS', `${flag} must be milliseconds`);
  return n;
}

/**
 * `run <id> [--name n] [--wait] -- <cmd...>`: start a background (non-PTY) session and print
 * `{sessionId}`; with `--wait`, wait for it, print its output and exit with its code.
 * @param {object} ctx @param {string[]} argv
 */
export async function sandboxRun(ctx, argv) {
  const dash = argv.indexOf('--');
  const cmd = dash === -1 ? [] : argv.slice(dash + 1);
  const { opts, positional } = parseOpts(
    dash === -1 ? argv : argv.slice(0, dash),
    new Set(['name']),
  );
  const id = need(positional[0], CONTROL_USAGE.run);
  need(cmd.length, CONTROL_USAGE.run);
  const ops = sandboxOps(ctx, id);
  const { sessionId } = await ops.start({ argv: cmd, name: opts.name });
  if (!opts.wait) return { sessionId };
  const exited = await waitFor(ops, sessionId);
  await printOutput(ops, sessionId, ctx.out, ctx.err);
  return { text: true, sessionId, exitCode: sessionExitCode(exited) };
}

/**
 * `logs <id> <sessionId>`: print the session's retained output from its start.
 * @param {object} ctx @param {string[]} argv
 */
export async function sandboxLogs(ctx, argv) {
  const { positional } = parseOpts(argv);
  const id = need(positional[0], CONTROL_USAGE.logs);
  const sessionId = need(positional[1], CONTROL_USAGE.logs);
  await printOutput(sandboxOps(ctx, id), sessionId, ctx.out, ctx.err);
  return { text: true, sessionId };
}

/**
 * `wait <id> <sessionId> [--timeout ms]`: wait for the session to exit and print
 * `{sessionId, exited, exitCode}`, exiting with its code; past the timeout, fail with E_TIMEOUT.
 * @param {object} ctx @param {string[]} argv
 */
export async function sandboxWait(ctx, argv) {
  const { opts, positional } = parseOpts(argv, new Set(['timeout']));
  const id = need(positional[0], CONTROL_USAGE.wait);
  const sessionId = need(positional[1], CONTROL_USAGE.wait);
  const timeoutMs = opts.timeout === undefined ? undefined : millis(opts.timeout, '--timeout');
  const exited = await waitFor(sandboxOps(ctx, id), sessionId, timeoutMs);
  if (!exited)
    throw coded('E_TIMEOUT', `session ${sessionId} is still running after ${timeoutMs} ms`);
  return { sessionId, exited, exitCode: sessionExitCode(exited) };
}

/**
 * `kill <id> <sessionId> [--signal NAME]`: signal the session's process group (default SIGTERM).
 * @param {object} ctx @param {string[]} argv
 */
export function sandboxKill(ctx, argv) {
  const { opts, positional } = parseOpts(argv, new Set(['signal']));
  const id = need(positional[0], CONTROL_USAGE.kill);
  const sessionId = need(positional[1], CONTROL_USAGE.kill);
  return sandboxOps(ctx, id).signal(sessionId, signalName(opts.signal ?? 'SIGTERM'));
}

/**
 * `cp <src> <dest>`: copy one file into or out of a sandbox, streamed, of any size. A sandbox
 * path ending in `/` takes the source's name, and so does a local destination directory. An
 * upload keeps the local file's permission bits; a failed download leaves no partial file.
 * @param {object} ctx @param {string[]} argv
 */
export async function sandboxCp(ctx, argv) {
  const { positional } = parseOpts(argv);
  const [src, dest] = [
    need(positional[0], CONTROL_USAGE.cp),
    need(positional[1], CONTROL_USAGE.cp),
  ];
  const from = parseCpTarget(src);
  const to = parseCpTarget(dest);
  if (Boolean(from.id) === Boolean(to.id))
    throw coded('E_INVALID_PARAMS', `exactly one side must be <id>:<path>: ${CONTROL_USAGE.cp}`);
  if (to.id) return upload(ctx, from.local, to);
  return download(ctx, from, to.local);
}

async function upload(ctx, local, to) {
  let st;
  try {
    st = fs.statSync(local);
  } catch (e) {
    throw coded('E_NOT_FOUND', `${local}: ${e.code}`);
  }
  if (!st.isFile()) throw coded('E_INVALID_PARAMS', `${local} is not a file`);
  const target = to.path.endsWith('/') ? `${to.path}${path.basename(local)}` : to.path;
  const out = await sandboxOps(ctx, to.id).upload(target, fs.createReadStream(local), {
    mode: st.mode & 0o777,
  });
  return { from: local, to: `${to.id}:${target}`, bytes: out.bytes };
}

async function download(ctx, from, local) {
  const isDir = fs.existsSync(local) && fs.statSync(local).isDirectory();
  const target = isDir ? path.join(local, path.posix.basename(from.path)) : local;
  const source = await sandboxOps(ctx, from.id).download(from.path);
  try {
    await pipeline(source, fs.createWriteStream(target));
  } catch (e) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    throw e;
  }
  return { from: `${from.id}:${from.path}`, to: target, bytes: fs.statSync(target).size };
}

/** The commands this module adds to `workbox sandbox`, by subcommand. */
export const CONTROL_COMMANDS = Object.freeze({
  run: sandboxRun,
  logs: sandboxLogs,
  wait: sandboxWait,
  kill: sandboxKill,
  cp: sandboxCp,
});
