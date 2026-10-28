import os from 'node:os';
import { runDoctor, formatReport, Audit, loadConfig } from '@workbox/core';

/**
 * Operator CLI command bodies. Each receives `(ctx, argv)`; ctx is either local
 * (`{engine}`) or remote (`{client}`) — commands prefer whichever is present so the same
 * surface works with `--server`.
 */

/** Parse `--key value`/`--flag`. @param {string[]} argv @param {Set<string>} valueKeys */
export function parseOpts(argv, valueKeys = new Set()) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (valueKeys.has(key)) {
        if (i + 1 >= argv.length) throw new Error(`--${key} needs a value`);
        opts[key] = argv[++i];
      } else opts[key] = true;
    } else positional.push(a);
  }
  return { opts, positional };
}

/** Extract connection options shared by every command. @param {string[]} argv */
export function connectionOpts(argv) {
  const { opts, positional } = parseOpts(argv, new Set(['server', 'token', 'config']));
  return { server: opts.server, token: opts.token, config: opts.config, opts, positional };
}

/**
 * argv without `--server URL` and `--token T`, so they may sit anywhere before a `--`.
 * @param {string[]} argv
 */
export function withoutConnection(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') {
      out.push(...argv.slice(i));
      break;
    }
    if (argv[i] === '--server' || argv[i] === '--token') i++;
    else out.push(argv[i]);
  }
  return out;
}

function manager(ctx) {
  if (ctx.engine) return ctx.engine.manager;
  throw new Error('this command needs a local engine or --server');
}

/**
 * Probe this host's prerequisites. With `--server` there is no local engine, so the config is
 * resolved from the environment; the host checked is always the local one.
 * @param {object} ctx @param {string[]} argv
 */
export async function doctorCommand(ctx, argv) {
  const report = await runDoctor(ctx.engine?.config ?? loadConfig());
  if (argv.includes('--json')) return report;
  ctx.out.write(`${formatReport(report)}\n`);
  return { text: true, ok: report.ok ?? true };
}

async function sandboxCreate(ctx, rest) {
  const { opts } = parseOpts(
    rest,
    new Set(['name', 'rootfs', 'runtime', 'network', 'idempotency-key']),
  );
  const input = {
    name: opts.name,
    rootfs: opts.rootfs,
    runtime: opts.runtime,
    idempotencyKey: opts['idempotency-key'],
    profile: opts.network ? { network: { mode: opts.network } } : undefined,
  };
  if (!ctx.client) return manager(ctx).create(input);
  const created = await ctx.client.createSandbox(input);
  return created.row ?? { id: created.id };
}

function sandboxExec(ctx, rest) {
  const id = need(rest[0], 'workbox sandbox exec <id> -- <cmd...>');
  const dash = rest.indexOf('--');
  const cmd = dash === -1 ? rest.slice(1) : rest.slice(dash + 1);
  if (!cmd.length) throw new Error('workbox sandbox exec <id> -- <cmd...>');
  return ctx.client
    ? ctx.client.sandbox(id).exec({ argv: cmd })
    : manager(ctx).exec(id, { argv: cmd });
}

async function localInspect(ctx, id) {
  const m = manager(ctx);
  const row = m.inspect(id);
  const { source, sessions } = await m.sessions(id);
  return { ...row, sessionsFrom: source, sessions };
}

/** @param {object} ctx @param {string[]} argv */
export async function sandboxCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  const remote = ctx.client;
  const byId = {
    inspect: (id) => (remote ? remote.sandbox(id).inspect() : localInspect(ctx, id)),
    rm: (id) => (remote ? remote.sandbox(id).destroy() : manager(ctx).destroy(id)),
    destroy: (id) => (remote ? remote.sandbox(id).destroy() : manager(ctx).destroy(id)),
    drain: (id) => (remote ? remote.sandbox(id).drain() : manager(ctx).drain(id)),
    events: (id) =>
      remote
        ? remote.sandbox(id).listEvents()
        : {
            transitions: manager(ctx).transitions(id),
            events: ctx.engine.store.listEvents(id, {}),
          },
  };
  if (sub === 'create') return sandboxCreate(ctx, rest);
  if (sub === 'shell') return shellCommand(ctx, rest);
  if (sub === 'ls' || sub === 'list') return remote ? remote.listSandboxes() : manager(ctx).list();
  if (sub === 'exec') return sandboxExec(ctx, rest);
  const fn = byId[sub];
  if (fn) return fn(need(rest[0], `workbox sandbox ${sub} <id>`));
  throw new Error(`unknown sandbox subcommand ${sub ?? ''}`);
}

/**
 * Interactive shell via a PTY session (task 2.5). With a terminal on stdin it runs through
 * `runInteractive` against the local engine or `--server`; otherwise the session is started
 * detached and described.
 * @param {object} ctx
 * @param {string[]} argv
 */
export async function shellCommand(ctx, argv) {
  const id = need(argv[0], 'workbox shell <id>');
  const input = ctx.in ?? process.stdin;
  const out = ctx.out ?? process.stdout;
  const params = {
    argv: ['/bin/bash', '-l'],
    pty: true,
    rows: out.rows || 24,
    cols: out.columns || 80,
    name: 'shell',
  };
  if (!input.isTTY) {
    const started = await managerOrRemoteStart(ctx, id, params);
    ctx.err.write(
      `shell session ${started.sessionId} (pty) started detached: stdin is not a tty\n`,
    );
    return started;
  }
  return runInteractive(ctx, id, params, { input, out });
}

/** CLI signals that end an interactive run; each hangs up the session like a closed terminal. */
const HANGUPS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/** How long a hung-up session gets to exit before the CLI stops waiting for it. */
const HANGUP_GRACE_MS = 2000;

/**
 * Exit status of a finished session: its code, or 128 + the number of the signal that ended it.
 * @param {{code?: number|null, signal?: string|null}} exit
 */
export function sessionExitCode(exit) {
  if (typeof exit?.code === 'number') return exit.code;
  return 128 + (os.constants.signals[exit?.signal] ?? 0);
}

/**
 * Run a PTY session with the local terminal in raw mode until it exits, against the local engine
 * or, when `ctx.client` is set, the server's session WebSocket. Keystrokes and window resizes go
 * to the session and its output to `out`. The terminal is restored on every way out: the session
 * exiting, an error, a lost connection (a coded error, E_UNAVAILABLE) or SIGINT/SIGTERM/SIGHUP
 * to this process, which hang the session up and return 128 + that signal's number.
 * @param {object} ctx `{engine}` or `{client}`
 * @param {string} id sandbox id
 * @param {{argv: string[], name?: string, cwd?: string, env?: Record<string, string>, rows?: number, cols?: number}} params
 *   session.start params; `pty` is forced on and rows/cols default to the terminal's
 * @param {{input?: NodeJS.ReadStream, out?: NodeJS.WriteStream}} [io] a TTY stdin and its output
 *   (default `ctx.in`/`ctx.out`, then the process's)
 * @returns {Promise<{text: true, sessionId: string, exitCode: number}>}
 */
export async function runInteractive(ctx, id, params, io = {}) {
  const input = io.input ?? ctx.in ?? process.stdin;
  const out = io.out ?? ctx.out ?? process.stdout;
  if (!input.isTTY || typeof input.setRawMode !== 'function')
    throw coded('E_INVALID_PARAMS', 'an interactive session needs a terminal on stdin');
  const start = {
    ...params,
    pty: true,
    rows: params.rows ?? (out.rows || 24),
    cols: params.cols ?? (out.columns || 80),
  };
  const write = (buf) => out.write(buf);
  const link = ctx.client
    ? await remoteLink(ctx.client, id, start, write)
    : await localLink(manager(ctx), id, start, write);
  let onSignal = () => undefined;
  const hangup = new Promise((resolve) => {
    onSignal = resolve;
  });
  const onData = (d) => link.input(d);
  const onResize = () => {
    if (out.rows && out.columns) link.resize(out.rows, out.columns);
  };
  let exit = null;
  const settled = link.exited.then(
    (e) => (exit = e),
    () => undefined,
  );
  try {
    for (const s of HANGUPS) process.on(s, onSignal);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
    out.on('resize', onResize);
    const signal = await Promise.race([link.exited.then((e) => ((exit = e), null)), hangup]);
    if (!signal) return { text: true, sessionId: link.sessionId, exitCode: sessionExitCode(exit) };
    link.signal('SIGHUP');
    let timer;
    const grace = new Promise((resolve) => {
      timer = setTimeout(resolve, HANGUP_GRACE_MS);
    });
    await Promise.race([settled, grace]);
    clearTimeout(timer);
    return { text: true, sessionId: link.sessionId, exitCode: 128 + os.constants.signals[signal] };
  } finally {
    for (const s of HANGUPS) process.off(s, onSignal);
    out.off('resize', onResize);
    input.off('data', onData);
    if (input.isRaw) input.setRawMode(false);
    input.pause();
    link.close();
    if (exit) await link.remove();
  }
}

/**
 * A PTY session on the local manager, attached from its first byte.
 * @param {object} m @param {string} id @param {object} params @param {(b: Buffer) => void} write
 */
async function localLink(m, id, params, write) {
  let sessionId = null;
  let settle = () => undefined;
  const exited = new Promise((resolve) => {
    settle = resolve;
  });
  const onEvent = (ev) => {
    if (ev.sandboxId !== id || !sessionId || ev.params?.sessionId !== sessionId) return;
    if (ev.method === 'session.output' && typeof ev.params.data === 'string')
      write(Buffer.from(ev.params.data, 'base64'));
    if (ev.method === 'session.exit') settle(ev.params);
  };
  const call = (method, p) => m.request(id, method, { sessionId, ...p }).catch(() => undefined);
  m.on('event', onEvent);
  try {
    sessionId = (await m.request(id, 'session.start', params)).sessionId;
    const attached = await m.request(id, 'session.attach', { sessionId, fromSeq: 0 });
    if (attached.exited) settle(attached.exited);
  } catch (e) {
    m.off('event', onEvent);
    throw e;
  }
  return {
    sessionId,
    exited,
    input: (d) => call('session.input', { data: d.toString('base64') }),
    resize: (rows, cols) => call('session.resize', { rows, cols }),
    signal: (signal) => call('session.signal', { signal }),
    close: () => m.off('event', onEvent),
    remove: () => call('session.remove', {}),
  };
}

/**
 * A PTY session on a remote server, attached over its session WebSocket. `exited` rejects with
 * E_UNAVAILABLE when the connection ends before the session does. The server has no route that
 * forgets a session, so `remove` leaves the exited session to the server.
 * @param {import('@workbox/sdk').WorkboxClient} client @param {string} id @param {object} params
 * @param {(b: Buffer) => void} write
 */
async function remoteLink(client, id, params, write) {
  const sandbox = client.sandbox(id);
  const { sessionId } = await sandbox.startSession(params);
  const stream = sandbox.attach(sessionId);
  const lost = (detail) =>
    coded(
      'E_UNAVAILABLE',
      `connection to ${client.baseUrl} lost: ${detail}; session ${sessionId} keeps running in sandbox ${id}`,
    );
  const exited = (async () => {
    try {
      for await (const ev of stream) {
        if (ev.type === 'session.output' && typeof ev.params?.data === 'string')
          write(Buffer.from(ev.params.data, 'base64'));
        if (ev.type === 'session.exit') return ev.params;
      }
    } catch (e) {
      throw e?.code === 'E_UNAVAILABLE' ? lost(e.message) : e;
    }
    throw lost('the session stream ended before the session exited');
  })();
  return {
    sessionId,
    exited,
    input: (d) => stream.input(d),
    resize: (rows, cols) => stream.resize(rows, cols),
    signal: (signal) => stream.sendSignal(signal),
    close: () => stream.close(),
    remove: async () => undefined,
  };
}

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

async function managerOrRemoteStart(ctx, id, params) {
  if (ctx.client) return ctx.client.sandbox(id).startSession(params);
  return manager(ctx).request(id, 'session.start', params);
}

/** @param {object} ctx @param {string[]} argv */
export async function rootfsCommand(ctx, argv) {
  const [sub, name] = argv;
  if (!ctx.engine) throw new Error('rootfs commands are local-only');
  if (sub === 'list') return { rootfs: ctx.engine.rootfs.list() };
  if (sub === 'build') return ctx.engine.rootfs.build(name ?? 'minimal');
  throw new Error(`unknown rootfs subcommand ${sub ?? ''}`);
}

/** @param {object} ctx @param {string[]} argv */
export async function runtimeCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  if (!ctx.engine) throw new Error('runtime commands are local-only');
  if (sub === 'list') return { runtimes: ctx.engine.runtime.list() };
  if (sub === 'install') {
    const { opts } = parseOpts(rest, new Set(['node-version', 'tarball']));
    return ctx.engine.runtime.install({
      nodeVersion: opts['node-version'],
      nodeTarball: opts.tarball,
    });
  }
  throw new Error(`unknown runtime subcommand ${sub ?? ''}`);
}

/** @param {object} ctx @param {string[]} argv */
export async function auditCommand(ctx, argv) {
  const [sub] = argv;
  if (!ctx.engine) throw new Error('audit commands are local-only');
  if (sub === 'verify') return Audit.verify(ctx.engine.config.paths.audit);
  throw new Error(`unknown audit subcommand ${sub ?? ''}`);
}

function need(v, usage) {
  if (!v) throw new Error(usage);
  return v;
}
