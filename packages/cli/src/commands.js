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
 * Interactive shell via a PTY session (task 2.5). With a terminal on stdin the local engine runs
 * it in raw mode, forwarding keystrokes and window resizes until the shell exits; otherwise the
 * session is started detached and described.
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
  if (ctx.client || !input.isTTY) {
    const started = await managerOrRemoteStart(ctx, id, params);
    ctx.err.write(
      `shell session ${started.sessionId} (pty) started detached: stdin is not a tty\n`,
    );
    return started;
  }
  return interactiveShell(manager(ctx), id, params, { input, out });
}

/**
 * Run a PTY session with the local terminal in raw mode until it exits.
 * @param {object} m the local sandbox manager
 * @param {string} id sandbox id
 * @param {object} params session.start params
 * @param {{input: NodeJS.ReadStream, out: NodeJS.WriteStream}} io
 */
async function interactiveShell(m, id, params, { input, out }) {
  const run = { sessionId: null, resolveExit: null };
  const exited = new Promise((resolve) => {
    run.resolveExit = resolve;
  });
  const onEvent = (ev) => {
    if (ev.sandboxId !== id || !run.sessionId || ev.params?.sessionId !== run.sessionId) return;
    if (ev.method === 'session.output' && typeof ev.params.data === 'string')
      out.write(Buffer.from(ev.params.data, 'base64'));
    if (ev.method === 'session.exit') run.resolveExit(ev.params);
  };
  const call = (method, p) =>
    m.request(id, method, { sessionId: run.sessionId, ...p }).catch(() => undefined);
  const onData = (d) => call('session.input', { data: d.toString('base64') });
  const onResize = () => {
    if (out.rows && out.columns) call('session.resize', { rows: out.rows, cols: out.columns });
  };
  m.on('event', onEvent);
  try {
    run.sessionId = (await m.request(id, 'session.start', params)).sessionId;
    const attached = await m.request(id, 'session.attach', {
      sessionId: run.sessionId,
      fromSeq: 0,
    });
    if (attached.exited) run.resolveExit(attached.exited);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
    out.on('resize', onResize);
    const exit = await exited;
    const code = exit.code ?? 128 + (os.constants.signals[exit.signal] ?? 0);
    return { text: true, sessionId: run.sessionId, exitCode: code };
  } finally {
    out.off('resize', onResize);
    input.off('data', onData);
    if (input.isRaw) input.setRawMode(false);
    input.pause();
    m.off('event', onEvent);
    if (run.sessionId) await call('session.remove', {});
  }
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
