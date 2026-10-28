import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_ROOTFS_DIR,
  CgroupManager,
  RootfsManager,
  loadConfig,
  sha256File,
} from '@workbox/core';
import { WorkboxClient } from '@workbox/sdk';
import { ensureAssets, ASSETS_ROOT } from '../../../core/test/helpers/engine.js';
import { tmpDir } from '../../../core/test/helpers/tmp.js';
import { missingSecretError } from '../../src/agent.js';

// Localhost test traffic must never go through an ambient HTTP(S) proxy.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])
  delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

const MAIN = fileURLToPath(new URL('../../src/main.js', import.meta.url));
const TOKEN = 'agent-admin-token';
/** Fake host keys the vendor APIs reject, built from parts so no key-shaped literal is stored. */
const FAKE = 'fake-workbox-test-0001';
const KEYS = Object.freeze({
  ANTHROPIC_API_KEY: ['sk', 'ant', FAKE].join('-'),
  OPENAI_API_KEY: ['sk', FAKE].join('-'),
});
const ESC = String.fromCharCode(27);
const CSI = new RegExp(`${ESC}\\[[0-9;?<>=]*[ -/]*[@-~]`, 'g');
const OSC = new RegExp(`${ESC}[\\]P][^${ESC}\\u0007]*(\\u0007|${ESC}\\\\)`, 'g');
/** What a terminal shows, as plain text: escape sequences out, runs of blanks as one space. */
const plain = (s) => s.replace(OSC, '').replace(CSI, ' ').replace(/\s+/g, ' ');

const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await delay(50);
  }
};

/**
 * The `agents` rootfs under the shared assets root, rebuilt only when absent, shifted for another
 * uid base, or built from another Dockerfile.
 */
async function ensureAgentsRootfs() {
  const cfg = loadConfig({ env: { WORKBOX_ROOT: ASSETS_ROOT } });
  const rootfs = new RootfsManager({ paths: cfg.paths, uid: cfg.uid });
  const built = rootfs.get('agents');
  const dockerfile = sha256File(path.join(BUILTIN_ROOTFS_DIR, 'agents', 'Dockerfile'));
  if (built?.uid?.base !== cfg.uid.base || built?.source?.dockerfileSha256 !== dockerfile)
    await rootfs.build('agents', { force: true });
}

/**
 * A fresh Workbox root linked to the shared rootfs and runtime assets, with a private cgroup
 * parent and a secrets file that does not exist. `env` drives an engine on it, with `secrets` as
 * its WORKBOX_SECRET_* variables; `clientEnv` is for remote CLIs, which open no engine.
 * `cleanup` removes the root and every sandbox left in it.
 * @param {string} tag @param {Record<string, string>} [secrets]
 */
async function agentRoot(tag, secrets = {}) {
  await ensureAssets();
  await ensureAgentsRootfs();
  const t = tmpDir(`workbox-agent-${tag}-`);
  fs.chmodSync(t.dir, 0o711);
  const root = path.join(t.dir, 'root');
  fs.mkdirSync(root, { mode: 0o711 });
  fs.symlinkSync(path.join(ASSETS_ROOT, 'rootfs'), path.join(root, 'rootfs'));
  fs.symlinkSync(path.join(ASSETS_ROOT, 'runtime'), path.join(root, 'runtime'));
  const parent = `workbox-agent-${process.pid}-${tag}`;
  const base = { ...process.env };
  for (const k of Object.keys(base))
    if (k.startsWith('WORKBOX_SECRET_') || k.startsWith('WORKBOX_E2E_')) delete base[k];
  for (const k of ['WORKBOX_CONFIG', 'WORKBOX_TOKEN', 'WORKBOX_API_KEYS', 'WORKBOX_PORT'])
    delete base[k];
  const env = {
    ...base,
    WORKBOX_ROOT: root,
    WORKBOX_CGROUP_PARENT: parent,
    WORKBOX_NETWORK_MODE: 'none',
    WORKBOX_SECRETS_FILE: path.join(t.dir, 'no-secrets.json'),
  };
  for (const [ref, value] of Object.entries(secrets)) env[`WORKBOX_SECRET_${ref}`] = value;
  const clientRoot = path.join(t.dir, 'client-root');
  const clientEnv = { ...base, WORKBOX_ROOT: clientRoot, WORKBOX_CGROUP_PARENT: `${parent}-c` };
  const config = path.join(t.dir, 'serve.json');
  const keys = [{ id: 'ops', token: TOKEN, scopes: ['admin', 'read', 'exec'] }];
  fs.writeFileSync(config, JSON.stringify({ keys, host: '127.0.0.1', port: 0 }), { mode: 0o600 });
  const cgroups = new CgroupManager({ root: '/sys/fs/cgroup', parent });
  const cleanup = async () => {
    if (fs.existsSync(cgroups.parentPath)) {
      for (const name of cgroups.list())
        await cgroups.remove(cgroups.childPath(name), { timeoutMs: 10_000 }).catch(() => undefined);
      fs.rmdirSync(cgroups.parentPath);
    }
    t.cleanup();
  };
  return { root, env, clientEnv, clientRoot, config, cleanup };
}

/**
 * Spawn the real `workbox` binary. `done` resolves when it exits; `child` is exposed for signals.
 * @param {NodeJS.ProcessEnv} env @param {string[]} args @param {number} [ms] kill after
 */
function spawnCli(env, args, ms = 120_000) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), ms);
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = null;
      }
      resolve({ code, signal, stdout, stderr, json });
    });
  });
  return { child, done, out: () => stdout };
}

const cli = (env, ...args) => spawnCli(env, args).done;

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run the real `workbox` binary on a real pseudo-terminal from util-linux `script`; `stty -a` then
 * prints the modes the CLI left on it. `child.stdin` types into the terminal.
 * @param {NodeJS.ProcessEnv} env @param {string[]} args
 */
function spawnTty(env, args) {
  const argv = [process.execPath, '--disable-warning=ExperimentalWarning', MAIN, ...args];
  const cmd = `stty rows 40 cols 120; ${argv.map(shQuote).join(' ')}; rc=$?; stty -a; exit $rc`;
  const child = spawn('script', ['-qefc', cmd, '/dev/null'], {
    env: { ...env, SHELL: '/bin/sh' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let screen = '';
  child.stdout.on('data', (d) => (screen += d));
  child.stderr.on('data', (d) => (screen += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, screen });
    });
  });
  return { child, done, screen: () => screen };
}

/** True when `stty -a` output shows a cooked terminal: canonical input with echo. */
const cooked = (screen) => /(^|\s)icanon(\s|$)/m.test(screen) && /(^|\s)echo(\s|$)/m.test(screen);

/** The sandbox a `workbox agent` run created, from its stderr notice among any engine logs. */
const newBox = (r, agent) => {
  const m = r.stderr.match(
    new RegExp(`^workbox: new sandbox (\\S+) for ${agent}; reuse it with`, 'm'),
  );
  assert.ok(m, `no new-sandbox notice: ${r.stderr}`);
  return m[1];
};

function httpStatus(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
  });
}

async function startServe(r, live) {
  const s = spawnCli(r.env, ['serve', '--config', r.config], 900_000);
  live.add(s);
  await until(() => /listening on http:\/\/[\d.]+:\d+\n/.test(s.out()));
  const origin = s.out().match(/listening on (http:\/\/[\d.]+:\d+)/)[1];
  await until(() => httpStatus(`${origin}/readyz`).then((st) => st === 200));
  return { ...s, origin };
}

/** Every byte a session's spool still holds, replayed over the server's session WebSocket. */
async function spool(client, id, sessionId) {
  let text = '';
  for await (const ev of client.sandbox(id).attach(sessionId)) {
    if (ev.type === 'session.output') text += Buffer.from(ev.params.data, 'base64').toString();
    if (ev.type === 'session.exit') break;
  }
  return text;
}

/** All files under `dir`, concatenated. */
function readTree(dir) {
  let text = '';
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true }))
    if (e.isFile()) text += fs.readFileSync(path.join(e.parentPath, e.name), 'utf8');
  return text;
}

test(
  'local agent: refusals before any box, headless claude in /workspace, reuse, detach and attach',
  { timeout: 600_000 },
  async () => {
    const r = await agentRoot('local');
    const env = r.env;
    try {
      const lacking = await cli(env, 'agent', 'claude', '-p', 'hi', '--network', 'none');
      assert.equal(lacking.code, 3, lacking.stderr);
      assert.equal(
        lacking.stderr,
        `workbox: ${missingSecretError('claude', 'ANTHROPIC_API_KEY').message} (E_NOT_FOUND)\n`,
      );
      for (const part of [
        'secret ANTHROPIC_API_KEY is not configured on the host',
        '/etc/workbox/secrets.json',
        '--secret CLAUDE_CODE_OAUTH_TOKEN',
        '--no-secret',
        '`claude setup-token`',
      ])
        assert.ok(lacking.stderr.includes(part), part);
      const detach = await cli(env, 'agent', 'claude', '-p', 'hi', '--detach', '--no-secret');
      assert.equal(detach.code, 2);
      assert.match(
        detach.stderr,
        /^workbox: --detach on the local engine needs --network none: this CLI runs the box's allowlist network .* pass --server URL --token T \(E_INVALID_PARAMS\)\n$/,
      );
      const notty = await cli(env, 'agent', 'claude', '--network', 'none', '--no-secret');
      assert.equal(notty.code, 2);
      assert.match(notty.stderr, /interactive claude session needs a terminal on stdin; pass -p/);
      const none = await cli(env, 'sandbox', 'ls');
      assert.deepEqual(none.json.items, [], 'no refusal created a box');

      const run = await cli(
        env,
        'agent',
        'claude',
        '-p',
        'say hi',
        '--network',
        'none',
        '--no-secret',
      );
      const id = newBox(run, 'claude');
      assert.match(run.stdout, /Not logged in/, run.stdout + run.stderr);
      assert.doesNotMatch(run.stdout + run.stderr, /cannot be used with root\/sudo privileges/);
      assert.notEqual(run.code, 0);
      const box = await cli(env, 'sandbox', 'inspect', id);
      assert.equal(box.code, 0, box.stderr);
      assert.equal(box.json.rootfs, 'agents');
      assert.deepEqual(box.json.profile, { network: { mode: 'none' } });
      assert.equal(box.json.labels['workbox.agent'], 'claude');
      assert.equal(box.json.sessions.length, 1);
      const [session] = box.json.sessions;
      assert.equal(session.name, 'agent-claude');
      assert.equal(session.cwd, '/workspace', 'the real claude ran in /workspace');
      assert.deepEqual(session.argv.slice(4), [
        'claude',
        '--dangerously-skip-permissions',
        '-p',
        '--',
        'say hi',
      ]);
      assert.equal(run.code, session.exited.code, 'the CLI exits with the session’s code');

      const started = await cli(
        env,
        'agent',
        'claude',
        id,
        '-p',
        'again',
        '--detach',
        '--no-secret',
      );
      assert.equal(started.code, 0, started.stderr);
      assert.doesNotMatch(started.stderr, /new sandbox/, 'a reused box is not announced');
      assert.deepEqual(Object.keys(started.json), ['sandboxId', 'sessionId']);
      assert.equal(started.json.sandboxId, id);
      const attached = await cli(env, 'sandbox', 'attach', id, started.json.sessionId);
      assert.match(attached.stdout, /Not logged in/, attached.stderr);
      assert.equal(attached.code, run.code, 'attach exits with the session’s code');

      const minimal = await cli(env, 'sandbox', 'create', '--network', 'none');
      assert.equal(minimal.code, 0, minimal.stderr);
      const wrong = await cli(env, 'agent', 'codex', minimal.json.id, '-p', 'x', '--no-secret');
      assert.equal(wrong.code, 2);
      assert.ok(
        wrong.stderr.endsWith(
          `workbox: sandbox ${minimal.json.id} runs the minimal rootfs; codex needs a box of the ` +
            'agents rootfs (omit the sandbox id to create one) (E_INVALID_PARAMS)\n',
        ),
        wrong.stderr,
      );
      for (const made of [id, minimal.json.id]) {
        const rm = await cli(env, 'sandbox', 'rm', made);
        assert.equal(rm.code, 0, rm.stderr);
        assert.equal(rm.json.state, 'DELETED');
      }
    } finally {
      await r.cleanup();
    }
  },
);

test(
  'remote agent: vendor APIs reached with the host key, missing secret, detach and attach, terminals',
  { timeout: 900_000 },
  async () => {
    const r = await agentRoot('remote', KEYS);
    const live = new Set();
    const ttys = [];
    const ids = [];
    const client = () => new WorkboxClient({ baseUrl: serve.origin, token: TOKEN });
    let serve;
    try {
      serve = await startServe(r, live);
      const remote = ['--server', serve.origin, '--token', TOKEN];
      const agent = (...args) => spawnCli(r.clientEnv, ['agent', ...args, ...remote], 300_000).done;
      const outputs = [];

      const claude = await agent('claude', '-p', 'Reply with exactly: wb-agent-ok');
      outputs.push(claude.stdout, claude.stderr);
      const claudeId = newBox(claude, 'claude');
      ids.push(claudeId);
      assert.match(claude.stdout + claude.stderr, /Invalid API key/);
      assert.equal(claude.code, 1, claude.stdout + claude.stderr);

      const codex = await agent('codex', '-p', 'Reply with exactly: wb-agent-ok');
      outputs.push(codex.stdout, codex.stderr);
      const codexId = newBox(codex, 'codex');
      ids.push(codexId);
      assert.match(codex.stderr, /401 Unauthorized/, codex.stderr);
      assert.match(codex.stderr, /Incorrect API key/);
      assert.equal(codex.code, 1, codex.stderr);
      assert.doesNotMatch(codex.stderr, /Not inside a trusted directory|approval required/i);

      const c = client();
      for (const [id, run] of [
        [claudeId, claude],
        [codexId, codex],
      ]) {
        const box = await c.sandbox(id).inspect();
        assert.equal(box.rootfs, 'agents');
        assert.equal(box.profile.network.mode, 'allowlist');
        const { sessions } = await c.sandbox(id).listSessions();
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].cwd, '/workspace');
        assert.equal(run.code, sessions[0].exited.code, 'the CLI exits with the session’s code');
        outputs.push(await spool(c, id, sessions[0].sessionId));
      }

      const lacking = await agent('claude', '-p', 'hi', '--secret', 'CLAUDE_CODE_OAUTH_TOKEN');
      assert.equal(lacking.code, 3, lacking.stderr);
      const lackingId = newBox(lacking, 'claude');
      assert.ok(
        lacking.stderr.endsWith(
          `workbox: ${missingSecretError('claude', 'CLAUDE_CODE_OAUTH_TOKEN').message} (E_NOT_FOUND)\n`,
        ),
        lacking.stderr,
      );
      assert.match(lacking.stderr, /--secret ANTHROPIC_API_KEY \(Claude API key/);
      assert.equal((await c.sandbox(lackingId).inspect()).desired, 'DELETED', 'box removed');

      const detached = await agent('claude', claudeId, '-p', 'Reply with exactly: wb', '--detach');
      assert.equal(detached.code, 0, detached.stderr);
      assert.equal(detached.json.sandboxId, claudeId);
      const attached = await cli(
        r.clientEnv,
        'sandbox',
        'attach',
        claudeId,
        detached.json.sessionId,
        ...remote,
      );
      outputs.push(attached.stdout, attached.stderr);
      assert.match(attached.stdout + attached.stderr, /Invalid API key/);
      assert.equal(attached.code, 1, 'attach exits with the session’s code');
      const again = await cli(
        r.clientEnv,
        'sandbox',
        'attach',
        claudeId,
        detached.json.sessionId,
        ...remote,
      );
      assert.equal(again.stdout, attached.stdout, 'a finished session replays the same output');
      assert.equal(again.code, 1);

      const term = spawnTty(r.clientEnv, ['agent', 'claude', claudeId, ...remote]);
      ttys.push(term);
      await until(() => /bypass permissions on/.test(plain(term.screen())), 90_000).catch(() => {
        throw new Error(`no claude prompt:\n${plain(term.screen())}`);
      });
      assert.doesNotMatch(plain(term.screen()), /Detected a custom API key/);
      term.child.stdin.write('\u0003');
      await until(() => /again to exit/i.test(plain(term.screen())), 10_000).catch(() => {});
      term.child.stdin.write('\u0003');
      const shown = await term.done;
      outputs.push(shown.screen);
      assert.ok(cooked(shown.screen), `the terminal is restored:\n${shown.screen}`);
      const claudeSessions = (await c.sandbox(claudeId).listSessions()).sessions;
      const interactive = claudeSessions.find(
        (s) => s.argv.at(-1) === '--dangerously-skip-permissions',
      );
      assert.ok(interactive?.exited, 'the interactive claude session exited');
      assert.equal(shown.code, interactive.exited.code, plain(shown.screen));

      const codexTerm = spawnTty(r.clientEnv, ['agent', 'codex', codexId, ...remote]);
      ttys.push(codexTerm);
      await until(() => /Ask Codex to do anything/.test(plain(codexTerm.screen())), 90_000).catch(
        () => {
          throw new Error(`no codex prompt:\n${plain(codexTerm.screen())}`);
        },
      );
      assert.doesNotMatch(plain(codexTerm.screen()), /Sign in with ChatGPT/);
      codexTerm.child.stdin.write('\u0003');
      await delay(1000);
      codexTerm.child.stdin.write('\u0003');
      const codexShown = await codexTerm.done;
      outputs.push(codexShown.screen);
      assert.ok(cooked(codexShown.screen), `the terminal is restored:\n${codexShown.screen}`);
      const codexSessions = (await c.sandbox(codexId).listSessions()).sessions;
      const codexInteractive = codexSessions.find(
        (s) => s.argv.at(-1) === '--dangerously-bypass-approvals-and-sandbox',
      );
      assert.ok(codexInteractive?.exited, 'the interactive codex session exited');
      assert.equal(codexShown.code, codexInteractive.exited.code, plain(codexShown.screen));
      for (const [id, list] of [
        [claudeId, claudeSessions],
        [codexId, codexSessions],
      ])
        for (const s of list) outputs.push(await spool(c, id, s.sessionId));

      const audit = readTree(path.join(r.root, 'audit'));
      assert.ok(audit.length > 0, 'the audit log was read');
      for (const value of Object.values(KEYS)) {
        assert.ok(!audit.includes(value), 'the audit log never holds a key');
        for (const text of outputs) assert.ok(!text.includes(value), 'no output shows a key');
      }

      for (const id of ids) {
        const rm = await cli(r.clientEnv, 'sandbox', 'rm', id, ...remote);
        assert.equal(rm.code, 0, rm.stderr);
      }
      assert.equal(fs.existsSync(r.clientRoot), false, 'remote commands never opened an engine');
    } finally {
      for (const t of ttys) {
        t.child.kill('SIGKILL');
        await t.done;
      }
      for (const s of live) {
        s.child.kill('SIGTERM');
        await s.done;
      }
      await r.cleanup();
    }
  },
);
