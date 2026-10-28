#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { WorkboxClient } from '@workbox/sdk';
import { openLocalEngine } from './local.js';
import { serveCommand } from './serve.js';
import {
  connectionOpts,
  withoutConnection,
  doctorCommand,
  sandboxCommand,
  shellCommand,
  rootfsCommand,
  runtimeCommand,
  auditCommand,
} from './commands.js';

/** CLI version. */
export const CLI_VERSION = '0.1.0-dev';

/** Top-level help text. */
export const HELP = `workbox — operator CLI

Usage:
  workbox doctor [--json]
  workbox rootfs build|list [name]
  workbox runtime install|list [--node-version v]
  workbox sandbox create|ls|inspect|rm|exec|shell|drain|events [--server URL --token T]
  workbox shell <id>
  workbox serve [--config server.json] [--port 8790] [--host 127.0.0.1]
  workbox audit verify
  workbox --help | --version

Sandbox commands talk to a local engine by default, or to a remote server with --server/--token.
The serve config file holds {"keys": [{"id", "tokenSha256", "scopes"}], "host", "port", "serverNames"}.
Exit codes: 0 ok, 1 internal, 2 usage, 3 not found, 4 denied/unavailable, 5 timeout.`;

/** @param {unknown} e */
export function exitCodeForError(e) {
  const code = e?.code ?? '';
  if (code === 'E_INVALID_PARAMS' || code === 'E_PARSE') return 2;
  if (code === 'E_NOT_FOUND') return 3;
  if (['E_DENIED', 'E_QUARANTINED', 'E_UNAVAILABLE', 'E_CLOSED'].includes(code)) return 4;
  if (code === 'E_TIMEOUT') return 5;
  return 1;
}

/**
 * @param {string[]} argv
 * @param {{out?: NodeJS.WriteStream, err?: NodeJS.WriteStream, engine?: object, client?: object, serve?: Function}} [deps]
 * @returns {Promise<number>}
 */
const COMMANDS = {
  doctor: doctorCommand,
  sandbox: sandboxCommand,
  shell: shellCommand,
  rootfs: rootfsCommand,
  runtime: runtimeCommand,
  audit: auditCommand,
};

function printResult(out, result, rest) {
  if (result !== undefined && typeof result?.text !== 'boolean')
    out.write(`${JSON.stringify(result, null, rest.includes('--json') ? 0 : 2)}\n`);
}

function resultExit(result) {
  if (typeof result?.exitCode === 'number' && result.exitCode !== 0) return result.exitCode;
  if (result?.exited && typeof result.exited.code === 'number') return result.exited.code;
  return 0;
}

/** Commands that talk to running sandboxes rediscover them from store and cgroup first. */
const RECONCILING = new Set(['serve', 'sandbox', 'shell']);

async function buildContext(deps, cmd, rest, io) {
  const conn = connectionOpts(rest);
  let client = deps.client ?? null;
  if (!client && conn.server)
    client = new WorkboxClient({
      baseUrl: conn.server,
      token: conn.token ?? process.env.WORKBOX_TOKEN ?? '',
    });
  let engine = deps.engine ?? null;
  let ownEngine = false;
  const needsEngine = !client && (cmd in COMMANDS || cmd === 'serve');
  if (needsEngine && !engine) {
    engine = await openLocalEngine({ reconcile: RECONCILING.has(cmd) });
    ownEngine = true;
  }
  return { ctx: { engine, client, ...io }, engine, ownEngine };
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  if (argv.includes('--version') || argv[0] === 'version') {
    out.write(`workbox ${CLI_VERSION}\n`);
    return 0;
  }
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === 'help') {
    out.write(`${HELP}\n`);
    return 0;
  }
  let engine = null;
  let ownEngine = false;
  try {
    const built = await buildContext(deps, cmd, rest, { out, err });
    engine = built.engine;
    ownEngine = built.ownEngine;
    const args = withoutConnection(rest);
    if (cmd === 'serve') {
      await (deps.serve ?? serveCommand)(built.ctx, args);
      return 0;
    }
    const fn = COMMANDS[cmd];
    if (!fn) {
      err.write(`workbox: unknown command ${cmd}\n\n${HELP}\n`);
      return 2;
    }
    const result = await fn(built.ctx, args);
    printResult(out, result, rest);
    return resultExit(result);
  } catch (e) {
    err.write(`workbox: ${e.message}${e.code ? ` (${e.code})` : ''}\n`);
    return exitCodeForError(e);
  } finally {
    if (ownEngine) engine?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Sandboxes launched by this process are detached from it; exit rather than wait on the
  // launch-chain handles that would otherwise keep a one-shot command alive.
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
