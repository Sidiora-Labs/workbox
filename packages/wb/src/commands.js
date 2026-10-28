import fs from 'node:fs';
import path from 'node:path';
import { constants as osConstants } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { ProtocolError, Codes } from '@workbox/protocol';
import { OUTBOX_DIR, INBOX_DIR } from './client.js';
import {
  PRESET_DIR,
  assertPresetNetwork,
  getPreset,
  listPresets,
  recipeDigest,
} from './presets.js';

/**
 * Every wb subcommand implementation. Handlers receive `(ctx, argv)` where ctx is
 * `{client, out, err}` (byte writers) and return the value printed in --json mode.
 */

/** Split argv at the first `--`. @param {string[]} argv */
export function splitAtDoubleDash(argv) {
  const i = argv.indexOf('--');
  return i === -1 ? { opts: argv, rest: [] } : { opts: argv.slice(0, i), rest: argv.slice(i + 1) };
}

/** Parse `--key value` / `--flag` options. @param {string[]} argv @param {Set<string>} valueKeys */
export function parseOpts(argv, valueKeys = new Set()) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (valueKeys.has(key)) {
        if (i + 1 >= argv.length)
          throw new ProtocolError(Codes.INVALID_PARAMS, `--${key} needs a value`);
        (opts[key] ??= []).push(argv[++i]);
      } else opts[key] = true;
    } else positional.push(a);
  }
  return { opts, positional };
}

/** @param {object} ctx */
export async function statusCommand(ctx) {
  const [broker, runner] = await Promise.all([
    ctx.client.request('broker.status').catch((e) => ({ unavailable: e.message })),
    ctx.client.request('runner.status'),
  ]);
  return { broker, runner };
}

/** @param {object} ctx @param {string[]} argv */
export async function sessionCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'start': {
      const { opts, rest: cmd } = splitAtDoubleDash(rest);
      const { opts: o } = parseOpts(opts, new Set(['name', 'cwd', 'env']));
      if (cmd.length === 0)
        throw new ProtocolError(
          Codes.INVALID_PARAMS,
          'wb session start -- <cmd...> requires a command',
        );
      const env = {};
      for (const kv of o.env ?? []) {
        const i = kv.indexOf('=');
        if (i === -1)
          throw new ProtocolError(Codes.INVALID_PARAMS, `--env expects KEY=VALUE, got ${kv}`);
        env[kv.slice(0, i)] = kv.slice(i + 1);
      }
      return ctx.client.request('session.start', {
        argv: cmd,
        name: o.name?.[0],
        cwd: o.cwd?.[0],
        env: Object.keys(env).length ? env : undefined,
        pty: o.pty === true,
      });
    }
    case 'list':
      return ctx.client.request('session.list');
    case 'attach': {
      const id = rest[0];
      if (!id) throw new ProtocolError(Codes.INVALID_PARAMS, 'wb session attach <id>');
      await ctx.client.connect();
      return new Promise((resolve, reject) => {
        let done = false;
        // An exited session replays its output, then session.exit, then the attach reply: the
        // first exit seen settles the command, prints the exit and carries the session's status.
        const finish = (exited) => {
          if (done) return;
          done = true;
          off();
          const how = exited.signal ? `signal ${exited.signal}` : `code ${exited.code}`;
          ctx.err.write(`wb: session ${id} exited with ${how}\n`);
          resolve({ sessionId: id, exited, exitCode: exitStatus(exited.code, exited.signal) });
        };
        const off = ctx.client.onEvent((method, p) => {
          if (p?.sessionId !== id) return;
          if (method === 'session.output' && !done) ctx.out.write(Buffer.from(p.data, 'base64'));
          if (method === 'session.exit') finish(p);
        });
        ctx.client.request('session.attach', { sessionId: id, fromSeq: 0 }).then((att) => {
          if (att.exited) finish(att.exited);
        }, reject);
      });
    }
    case 'input': {
      const [id, ...words] = rest;
      if (!id) throw new ProtocolError(Codes.INVALID_PARAMS, 'wb session input <id> [text...]');
      return ctx.client.request('session.input', {
        sessionId: id,
        data: Buffer.from(words.join(' ')).toString('base64'),
      });
    }
    case 'stop': {
      const id = rest[0];
      if (!id) throw new ProtocolError(Codes.INVALID_PARAMS, 'wb session stop <id>');
      return ctx.client.request('session.stop', { sessionId: id });
    }
    default:
      throw new ProtocolError(Codes.INVALID_PARAMS, `unknown session subcommand ${sub ?? ''}`);
  }
}

/** Sample a pid's peak RSS (VmHWM) in bytes, null when unavailable. @param {number} pid */
export function peakRss(pid) {
  try {
    const m = /(?:^|\n)VmHWM:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Run a command to completion, streaming output and building the evidence envelope.
 * @param {string[]} argv @param {{cwd?: string, env?: Record<string,string>, out?: {write: Function}, err?: {write: Function}}} [opts]
 */
export async function runProcess(argv, opts = {}) {
  const startedAt = Date.now();
  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  const hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  const log = [];
  let rss = null;
  const sampler = setInterval(() => {
    const v = peakRss(child.pid);
    if (v !== null) rss = Math.max(rss ?? 0, v);
  }, 25);
  sampler.unref();
  child.stdout.on('data', (d) => {
    hashes.stdout.update(d);
    log.push(d);
    (opts.out ?? process.stdout).write(d);
  });
  child.stderr.on('data', (d) => {
    hashes.stderr.update(d);
    log.push(d);
    (opts.err ?? process.stderr).write(d);
  });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (c, s) => resolve([c, s]));
  }).catch((e) => {
    clearInterval(sampler);
    throw new ProtocolError(Codes.UNAVAILABLE, `cannot run ${argv[0]}: ${e.message}`);
  });
  clearInterval(sampler);
  const endedAt = Date.now();
  return {
    envelope: {
      argv,
      cwd: opts.cwd ?? process.cwd(),
      exitCode: code,
      signal: signal ?? null,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      peakRssBytes: rss,
      stdoutSha256: hashes.stdout.digest('hex'),
      stderrSha256: hashes.stderr.digest('hex'),
    },
    log: Buffer.concat(log),
    exitCode: code,
  };
}

/**
 * Shell-convention exit status of a finished child: its own code, or 128 + the signal number when
 * it died by a signal (SIGKILL -> 137), so a killed command never reads as success.
 * @param {number|null} code @param {string|null} signal
 */
export function exitStatus(code, signal) {
  if (Number.isInteger(code)) return code;
  const n = signal ? osConstants.signals[signal] : undefined;
  return n ? 128 + n : 1;
}

/** Write bytes into the outbox and hand them to the host CAS. @param {object} ctx @param {Buffer} data @param {{name?: string, kind?: string}} [meta] */
export async function putArtifactBytes(ctx, data, meta = {}) {
  fs.mkdirSync(ctx.outboxDir ?? OUTBOX_DIR, { recursive: true });
  const sha256 = createHash('sha256').update(data).digest('hex');
  const outboxName = `${sha256.slice(0, 16)}-${randomBytes(4).toString('hex')}.bin`;
  fs.writeFileSync(path.join(ctx.outboxDir ?? OUTBOX_DIR, outboxName), data);
  return ctx.client.request('broker.artifact.put', {
    outboxName,
    sha256,
    size: data.length,
    name: meta.name,
    kind: meta.kind,
  });
}

/** `wb run -- <cmd...>`: run, stream, store the log as an artifact, record evidence. */
export async function runCommand(ctx, argv) {
  const { rest: cmd } = splitAtDoubleDash(argv);
  if (cmd.length === 0)
    throw new ProtocolError(Codes.INVALID_PARAMS, 'wb run -- <cmd...> requires a command');
  const { envelope, log, exitCode } = await runProcess(cmd, { out: ctx.out, err: ctx.err });
  const artifact = await putArtifactBytes(ctx, log, { name: 'run.log', kind: 'evidence-log' });
  envelope.logSha256 = artifact.sha256;
  const recorded = await ctx.client.request('broker.evidence.record', { envelope });
  return {
    evidence: { id: recorded.id, ...envelope },
    artifact,
    exitCode: exitStatus(exitCode, envelope.signal),
  };
}

/** @param {object} ctx @param {string[]} argv */
export async function askCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'raise': {
      const { opts, positional } = parseOpts(
        rest,
        new Set(['kind', 'option', 'timeout-ms', 'recommended', 'ref', 'body']),
      );
      const title = positional.join(' ');
      if (!title) throw new ProtocolError(Codes.INVALID_PARAMS, 'wb ask raise --kind <k> <title>');
      return ctx.client.request('broker.ask.raise', {
        kind: opts.kind?.[0] ?? 'question',
        title,
        body: opts.body?.[0],
        options: opts.option,
        recommended: opts.recommended?.[0],
        ref: opts.ref?.[0],
        timeoutMs: opts['timeout-ms'] ? Number(opts['timeout-ms'][0]) : undefined,
      });
    }
    case 'status':
      return ctx.client.request('broker.ask.status', {
        askId: need(rest[0], 'wb ask status <id>'),
      });
    case 'list':
      return ctx.client.request('broker.ask.list', { status: rest[0] ?? 'all' });
    case 'wait': {
      const { opts, positional } = parseOpts(rest, new Set(['timeout-ms']));
      return ctx.client.request(
        'broker.ask.wait',
        {
          askId: need(positional[0], 'wb ask wait <id>'),
          timeoutMs: opts['timeout-ms'] ? Number(opts['timeout-ms'][0]) : undefined,
        },
        { timeoutMs: (opts['timeout-ms'] ? Number(opts['timeout-ms'][0]) : 300_000) + 30_000 },
      );
    }
    default:
      throw new ProtocolError(Codes.INVALID_PARAMS, `unknown ask subcommand ${sub ?? ''}`);
  }
}

/** @param {object} ctx @param {string[]} argv */
export async function secretCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  if (sub === 'list') return ctx.client.request('broker.secret.list');
  if (sub !== 'exec')
    throw new ProtocolError(Codes.INVALID_PARAMS, `unknown secret subcommand ${sub ?? ''}`);
  const { opts: refs, rest: cmd } = splitAtDoubleDash(rest);
  if (refs.length === 0 || cmd.length === 0)
    throw new ProtocolError(Codes.INVALID_PARAMS, 'wb secret exec <ref>... -- <cmd...>');
  const started = await ctx.client.request('session.start', { argv: cmd, secretRefs: refs });
  await ctx.client.connect();
  return new Promise((resolve, reject) => {
    const off = ctx.client.onEvent((method, p) => {
      if (p?.sessionId !== started.sessionId) return;
      if (method === 'session.output') ctx.out.write(Buffer.from(p.data, 'base64'));
      if (method === 'session.exit') {
        off();
        resolve({
          sessionId: started.sessionId,
          exited: p,
          exitCode: exitStatus(p.code, p.signal),
        });
      }
    });
    ctx.client
      .request('session.attach', { sessionId: started.sessionId, fromSeq: 0 })
      .catch(reject);
  });
}

/** @param {object} ctx @param {string[]} argv */
export async function eventCommand(ctx, argv) {
  const [sub, ...args] = argv;
  const { opts, positional } = parseOpts(args, new Set(['causation']));
  const [type, ...rest] = positional;
  if (sub !== 'emit' || !type)
    throw new ProtocolError(Codes.INVALID_PARAMS, 'wb event emit <type> [json] [--causation id]');
  let payload;
  if (rest.length) {
    try {
      payload = JSON.parse(rest.join(' '));
    } catch {
      throw new ProtocolError(Codes.INVALID_PARAMS, 'event payload must be JSON');
    }
  }
  return ctx.client.request('broker.event.emit', {
    type,
    payload,
    causation: opts.causation?.[0],
  });
}

/** @param {object} ctx @param {string[]} argv */
export async function leaseCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  if (sub === 'status') return ctx.client.request('broker.lease.status');
  if (sub === 'renew') {
    const { opts } = parseOpts(rest, new Set(['ttl-ms']));
    return ctx.client.request('broker.lease.renew', {
      ttlMs: opts['ttl-ms'] ? Number(opts['ttl-ms'][0]) : undefined,
    });
  }
  throw new ProtocolError(Codes.INVALID_PARAMS, `unknown lease subcommand ${sub ?? ''}`);
}

/** @param {object} ctx @param {string[]} argv */
export async function checkpointCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  if (sub === 'list') return ctx.client.request('broker.checkpoint.list');
  if (sub === 'create') {
    const { opts } = parseOpts(rest, new Set(['name', 'summary']));
    return ctx.client.request('broker.checkpoint.create', {
      name: opts.name?.[0],
      summary: opts.summary?.[0],
    });
  }
  throw new ProtocolError(Codes.INVALID_PARAMS, `unknown checkpoint subcommand ${sub ?? ''}`);
}

/** @param {object} ctx @param {string[]} argv */
export async function artifactCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'put': {
      const file = need(rest[0], 'wb artifact put <file>');
      const data = fs.readFileSync(file);
      return putArtifactBytes(ctx, data, { name: path.basename(file) });
    }
    case 'get': {
      const sha = need(rest[0], 'wb artifact get <sha256> [dest]');
      const got = await ctx.client.request('broker.artifact.get', { sha256: sha });
      const src = path.join(ctx.inboxDir ?? INBOX_DIR, got.inboxName);
      const dest = rest[1] ?? path.join(process.cwd(), got.inboxName);
      fs.copyFileSync(src, dest);
      return { ...got, path: dest };
    }
    case 'list':
      return ctx.client.request('broker.artifact.list', {});
    default:
      throw new ProtocolError(Codes.INVALID_PARAMS, `unknown artifact subcommand ${sub ?? ''}`);
  }
}

/** @param {object} ctx @param {string[]} argv */
export async function netCommand(ctx, argv) {
  const [sub, ...rest] = argv;
  if (sub === 'policy') return ctx.client.request('broker.net.policy');
  if (sub === 'test') {
    const [host, port] = rest;
    const usage = 'wb net test <host> <port>';
    const n = Number(need(port, usage));
    if (!Number.isInteger(n) || n < 1 || n > 65535)
      throw new ProtocolError(Codes.INVALID_PARAMS, `port must be in 1..65535: ${usage}`);
    return ctx.client.request('broker.net.test', { host: need(host, usage), port: n });
  }
  throw new ProtocolError(Codes.INVALID_PARAMS, `unknown net subcommand ${sub ?? ''}`);
}

const PIN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** Run argv to completion, keeping stdout and stderr apart. @param {string[]} argv @param {object} env */
async function capture(argv, env) {
  const out = [];
  const err = [];
  const r = await runProcess(argv, {
    env,
    out: { write: (d) => out.push(d) },
    err: { write: (d) => err.push(d) },
  });
  return {
    exitCode: exitStatus(r.exitCode, r.envelope.signal),
    stdout: Buffer.concat(out).toString('utf8'),
    stderr: Buffer.concat(err).toString('utf8'),
  };
}

const firstLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);

/** sha256 of a file's bytes, streamed. @param {string} file */
async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Resolve the preset's floating versions, reusing every one a previous manifest recorded: a
 * re-install never re-resolves silently.
 * @param {import('./presets.js').Preset} preset @param {Record<string, string>} previous @param {object} env
 */
async function resolvePins(preset, previous, env) {
  const pins = {};
  for (const [key, argv] of Object.entries(preset.resolve ?? {})) {
    const known = previous?.[key];
    if (typeof known === 'string' && PIN_RE.test(known)) {
      pins[key] = known;
      continue;
    }
    const r = await capture(argv, env);
    const value = firstLine(r.stdout) ?? '';
    if (r.exitCode !== 0 || !PIN_RE.test(value))
      throw new ProtocolError(Codes.UNAVAILABLE, `cannot resolve the ${key} version`, {
        exitCode: r.exitCode,
        stderr: r.stderr.slice(-2000),
      });
    pins[key] = value;
  }
  return pins;
}

/**
 * Version and digest of one installed tool.
 * @param {string} name @param {import('./presets.js').ToolCheck} check @param {object} env
 */
async function checkTool(name, check, env) {
  const r = await capture(check.verify, env);
  const version = firstLine(r.stdout) ?? firstLine(r.stderr);
  if (r.exitCode !== 0 || !version)
    throw new ProtocolError(Codes.UNAVAILABLE, `${name} does not verify`, {
      exitCode: r.exitCode,
      stderr: r.stderr.slice(-2000),
    });
  const file = fs.realpathSync(check.bin);
  return { version, path: file, sha256: await fileSha256(file) };
}

async function runSteps(ctx, preset, manifest, env) {
  for (const [index, step] of preset.steps.entries()) {
    if (step.when && !process.env[step.when]) continue;
    manifest.failed = { step: index, tools: Object.keys(step.tools) };
    const r = await runProcess(step.argv, { env, out: ctx.err, err: ctx.err });
    const exitCode = exitStatus(r.exitCode, r.envelope.signal);
    if (exitCode !== 0) {
      manifest.failed.exitCode = exitCode;
      return;
    }
    for (const [name, check] of Object.entries(step.tools))
      manifest.tools[name] = await checkTool(name, check, env);
  }
  delete manifest.failed;
  manifest.status = 'ok';
}

/**
 * Install a preset into a fresh manifest: `failed` until every step and every tool check passed,
 * so a failure never leaves a partial `ok`.
 */
async function installPreset(ctx, name, preset, previous) {
  const manifest = {
    name,
    status: 'failed',
    recipe: recipeDigest(preset),
    hosts: [...preset.hosts],
    resolved: {},
    tools: {},
    startedAt: Date.now(),
  };
  const env = { PATH: `/usr/local/sbin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}` };
  try {
    manifest.failed = { step: 'resolve' };
    manifest.resolved = await resolvePins(preset, previous?.resolved, env);
    for (const [key, value] of Object.entries(manifest.resolved))
      env[`WB_PIN_${key.toUpperCase()}`] = value;
    await runSteps(ctx, preset, manifest, env);
  } catch (e) {
    manifest.failed = { ...manifest.failed, error: e.message };
  }
  manifest.endedAt = Date.now();
  manifest.digest = createHash('sha256')
    .update(JSON.stringify([manifest.recipe, manifest.resolved, manifest.tools]))
    .digest('hex');
  return manifest;
}

function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * `wb preset list|install <name>`. Install writes `/var/lib/workbox-preset/<name>.json` and
 * mirrors the same manifest to the host store; an `ok` manifest of the same recipe makes a
 * re-install a no-op. The sandbox network is checked first and never widened from inside.
 * @param {object} ctx @param {string[]} argv
 */
export async function presetCommand(ctx, argv) {
  const [sub, name] = argv;
  if (sub === 'list') return { presets: listPresets() };
  if (sub !== 'install')
    throw new ProtocolError(Codes.INVALID_PARAMS, `unknown preset subcommand ${sub ?? ''}`);
  const preset = getPreset(need(name, 'wb preset install <name>'));
  const file = path.join(ctx.presetDir ?? PRESET_DIR, `${name}.json`);
  const previous = readManifest(file);
  if (previous?.status === 'ok' && previous.recipe === recipeDigest(preset))
    return { name, status: 'ok', unchanged: true, manifest: previous };
  assertPresetNetwork(name, preset, await ctx.client.request('broker.net.policy'));
  const manifest = await installPreset(ctx, name, preset, previous);
  writeManifest(file, manifest);
  await ctx.client.request('broker.preset.manifest', { name, manifest });
  if (manifest.status !== 'ok')
    throw new ProtocolError(Codes.UNAVAILABLE, `preset ${name} install failed`, {
      manifest: file,
      failed: manifest.failed,
    });
  return { name, status: 'ok', unchanged: false, manifest };
}

function need(value, usage) {
  if (!value) throw new ProtocolError(Codes.INVALID_PARAMS, usage);
  return value;
}
