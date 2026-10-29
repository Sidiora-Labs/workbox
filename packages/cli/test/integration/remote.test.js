import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CgroupManager } from '@workbox/core';
import { hashToken } from '@workbox/server';
import { ensureAssets, ASSETS_ROOT } from '../../../core/test/helpers/engine.js';
import { tmpDir } from '../../../core/test/helpers/tmp.js';

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

/** One bearer token per role; the serve config file below grants each its scopes. */
const TOKENS = Object.freeze({
  admin: 'remote-admin-token',
  exec: 'remote-exec-token',
  read: 'remote-read-token',
});

const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * A fresh Workbox root for the served engine, linked to the shared rootfs and runtime assets, with
 * a private cgroup parent; `cleanup` removes both, live sandboxes included.
 * @param {string} tag
 */
async function serveRoot(tag) {
  await ensureAssets();
  const t = tmpDir(`workbox-remote-${tag}-`);
  fs.chmodSync(t.dir, 0o711);
  const root = path.join(t.dir, 'root');
  fs.mkdirSync(root, { mode: 0o711 });
  fs.symlinkSync(path.join(ASSETS_ROOT, 'rootfs'), path.join(root, 'rootfs'));
  fs.symlinkSync(path.join(ASSETS_ROOT, 'runtime'), path.join(root, 'runtime'));
  const parent = `workbox-remote-${process.pid}-${tag}`;
  const base = { ...process.env };
  for (const k of ['WORKBOX_CONFIG', 'WORKBOX_TOKEN', 'WORKBOX_API_KEYS', 'WORKBOX_PORT'])
    delete base[k];
  const env = {
    ...base,
    WORKBOX_ROOT: root,
    WORKBOX_CGROUP_PARENT: parent,
    WORKBOX_NETWORK_MODE: 'none',
  };
  // Remote clients get a root that must never come into existence: they open no local engine.
  const clientRoot = path.join(t.dir, 'client-root');
  const clientEnv = {
    ...base,
    WORKBOX_ROOT: clientRoot,
    WORKBOX_CGROUP_PARENT: `${parent}-client`,
  };
  const config = path.join(t.dir, 'serve.json');
  const keys = [
    { id: 'ops', token: TOKENS.admin, scopes: ['admin'] },
    { id: 'harness', tokenSha256: hashToken(TOKENS.exec), scopes: ['exec', 'read'] },
    { id: 'observer', tokenSha256: hashToken(TOKENS.read), scopes: ['read'] },
  ];
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
  return { root, env, clientEnv, clientRoot, config, cgroups, cleanup };
}

/**
 * Spawn the real `workbox` binary. `done` resolves when it exits; `child` is exposed for signals.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} args
 */
function spawnCli(env, args) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', MAIN, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
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

const shQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Run the real `workbox` binary on a real pseudo-terminal: util-linux `script` gives it a tty for
 * stdin and stdout, and `stty -a` then prints the modes the CLI left on that tty. `done` resolves
 * with the CLI's exit code and everything the terminal showed; `child.stdin` types into it.
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} args
 */
function spawnTty(env, args) {
  const cli = [process.execPath, '--disable-warning=ExperimentalWarning', MAIN, ...args];
  const cmd = `${cli.map(shQuote).join(' ')}; rc=$?; stty -a; exit $rc`;
  const child = spawn('script', ['-qefc', cmd, '/dev/null'], {
    env: { ...env, SHELL: '/bin/sh' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let screen = '';
  child.stdout.on('data', (d) => (screen += d));
  child.stderr.on('data', (d) => (screen += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, screen, at: Date.now() });
    });
  });
  return { child, done, screen: () => screen };
}

/** True when `stty -a` output shows a cooked terminal: canonical input with echo. */
const cooked = (screen) => /(^|\s)icanon(\s|$)/m.test(screen) && /(^|\s)echo(\s|$)/m.test(screen);

/** One HTTP request on a fresh connection; resolves with the status. */
function httpStatus(method, url, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Start `workbox serve --config` and wait until its /readyz answers 200. */
async function startServe(r, live) {
  const s = spawnCli(r.env, ['serve', '--config', r.config]);
  live.add(s);
  await until(() => /listening on http:\/\/[\d.]+:\d+\n/.test(s.out()));
  const origin = s.out().match(/listening on (http:\/\/[\d.]+:\d+)/)[1];
  await until(() => httpStatus('GET', `${origin}/readyz`).then((st) => st === 200));
  return { ...s, origin };
}

/** SIGTERM a serve process; it must exit 0 on its own. */
async function stopServe(s, live) {
  s.child.kill('SIGTERM');
  const done = await s.done;
  live.delete(s);
  assert.equal(done.signal, null, 'SIGTERM is handled, not fatal');
  assert.equal(done.code, 0, done.stderr);
}

test('remote mode: serve with a config file, then create, ls, inspect, exec and rm through the CLI', async () => {
  const r = await serveRoot('e2e');
  const live = new Set();
  const remote = (origin, token) => ['--server', origin, '--token', token];
  const cli = (...args) => spawnCli(r.clientEnv, args).done;
  try {
    let serve = await startServe(r, live);
    const admin = remote(serve.origin, TOKENS.admin);
    const created = await cli('sandbox', 'create', '--name', 'remote1', ...admin);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.state, 'READY');
    assert.equal(created.json.health, 'HEALTHY');
    assert.equal(created.json.name, 'remote1');
    const id = created.json.id;
    const cgroupPath = created.json.cgroup;
    assert.ok(cgroupPath.startsWith(r.cgroups.parentPath), 'the served engine owns the sandbox');
    assert.ok(r.cgroups.procs(cgroupPath).length > 0);

    const listed = await cli('sandbox', 'ls', ...admin);
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(
      listed.json.items.map((s) => s.id),
      [id],
    );
    const read = remote(serve.origin, TOKENS.read);
    const inspect = await cli('sandbox', ...read, 'inspect', id, '--json');
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.equal(inspect.json.desired, 'READY');
    assert.equal(inspect.json.health, 'HEALTHY');
    assert.equal(inspect.stdout.trim().includes('\n'), false, '--json prints one compact line');

    const exec = remote(serve.origin, TOKENS.exec);
    const ran = await cli(
      'sandbox',
      'exec',
      id,
      ...exec,
      '--',
      'sh',
      '-c',
      'echo remote-$((6 * 7)) > /workspace/proof && cat /workspace/proof',
    );
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(ran.json.stdout, 'remote-42\n');
    assert.equal(ran.json.exitCode, 0);
    const proof = path.join(r.root, 'sandboxes', id, 'upper', 'workspace', 'proof');
    assert.equal(fs.readFileSync(proof, 'utf8'), 'remote-42\n', 'the command ran inside the box');
    const failing = await cli(
      'sandbox',
      'exec',
      id,
      ...exec,
      '--',
      'sh',
      '-c',
      'echo out; echo err >&2; exit 7',
    );
    assert.equal(failing.code, 7, 'the CLI exits with the remote command’s own exit code');
    assert.equal(failing.json.stdout, 'out\n');
    assert.equal(failing.json.stderr, 'err\n');
    assert.equal(failing.json.exitCode, 7);

    const follow = spawnCli(r.clientEnv, [
      'events',
      ...read,
      '--sandbox',
      id,
      '--type',
      'cli.*',
      '--after',
      '0',
      '--follow',
    ]);
    live.add(follow);
    const emitted = await cli(
      'sandbox',
      'exec',
      id,
      ...exec,
      '--',
      'wb',
      'event',
      'emit',
      'cli.done',
      '{"ok":true}',
      '--json',
    );
    assert.equal(emitted.code, 0, emitted.stderr);
    await until(() => follow.out().includes('"cli.done"'));
    follow.child.kill('SIGINT');
    const followed = await follow.done;
    live.delete(follow);
    assert.equal(followed.signal, null, 'SIGINT ends the follow cleanly');
    assert.equal(followed.code, 0, followed.stderr);
    const lines = followed.stdout.trim().split('\n');
    assert.deepEqual(
      lines.map((l) => JSON.parse(l)).map((e) => [e.sandboxId, e.type, e.source, e.payload]),
      [[id, 'cli.done', 'wb', { ok: true }]],
    );
    const history = await cli('events', ...read, '--sandbox', id);
    assert.equal(history.code, 0, history.stderr);
    const types = history.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).type);
    for (const type of ['sandbox.created', 'exec.finished', 'cli.done'])
      assert.ok(types.includes(type), `${type} in ${types.join(', ')}`);

    const wrong = await cli('sandbox', 'ls', ...remote(serve.origin, 'not-a-token'));
    assert.equal(wrong.code, 4);
    assert.equal(wrong.stdout, '');
    assert.equal(wrong.stderr, 'workbox: missing or invalid bearer token (E_DENIED)\n');
    assert.equal(await httpStatus('GET', `${serve.origin}/v1/sandboxes`, 'not-a-token'), 401);
    const noExec = await cli('sandbox', 'exec', id, ...read, '--', 'true');
    assert.equal(noExec.code, 4);
    assert.equal(noExec.stderr, 'workbox: scope exec required (E_DENIED)\n');
    const noRm = await cli('sandbox', 'rm', id, ...read);
    assert.equal(noRm.code, 4);
    assert.equal(noRm.stderr, 'workbox: scope admin required (E_DENIED)\n');
    const noRmExec = await cli('sandbox', 'rm', id, ...exec);
    assert.equal(noRmExec.code, 4);
    assert.equal(noRmExec.stderr, 'workbox: scope admin required (E_DENIED)\n');
    const sandboxUrl = `${serve.origin}/v1/sandboxes/${id}`;
    assert.equal(await httpStatus('POST', `${sandboxUrl}/exec`, TOKENS.read), 403);
    assert.equal(await httpStatus('DELETE', sandboxUrl, TOKENS.read), 403);
    const missing = await cli('sandbox', 'inspect', 'sb-nope', ...read);
    assert.equal(missing.code, 3, missing.stderr);

    await stopServe(serve, live);
    assert.ok(r.cgroups.procs(cgroupPath).length > 0, 'the sandbox outlived the server');
    const down = await cli('sandbox', 'ls', ...admin);
    assert.equal(down.code, 4);
    assert.match(down.stderr, /^workbox: GET \/v1\/sandboxes failed: .* \(E_UNAVAILABLE\)\n$/);

    serve = await startServe(r, live);
    const again = remote(serve.origin, TOKENS.admin);
    const back = await cli('sandbox', 'inspect', id, ...again);
    assert.equal(back.code, 0, back.stderr);
    assert.equal(back.json.desired, 'READY');
    assert.equal(back.json.health, 'HEALTHY', 'the restarted server reattached the live sandbox');
    const still = await cli('sandbox', 'exec', id, ...again, '--', 'cat', '/workspace/proof');
    assert.equal(still.code, 0, still.stderr);
    assert.equal(still.json.stdout, 'remote-42\n');

    const removed = await cli('sandbox', 'rm', id, ...again);
    assert.equal(removed.code, 0, removed.stderr);
    assert.equal(removed.json.state, 'DELETED');
    assert.equal(removed.json.health, 'ABSENT');
    assert.equal(fs.existsSync(cgroupPath), false, 'the cgroup directory is gone');
    assert.equal(fs.existsSync(path.join(r.root, 'sandboxes', id)), false);
    const gone = await cli('sandbox', 'inspect', id, ...again);
    assert.equal(gone.code, 0, gone.stderr);
    assert.equal(gone.json.desired, 'DELETED');
    const empty = await cli('sandbox', 'ls', ...again);
    assert.deepEqual(empty.json.items, []);
    await stopServe(serve, live);

    const badConfig = path.join(path.dirname(r.config), 'bad.json');
    fs.writeFileSync(badConfig, JSON.stringify({ keys: [{ id: 'k', token: 't', scopes: ['x'] }] }));
    const refused = await spawnCli(r.env, ['serve', '--config', badConfig]).done;
    assert.equal(refused.code, 2);
    assert.match(
      refused.stderr,
      /invalid serve config .*unknown scope x for key k \(E_INVALID_PARAMS\)/,
    );
    assert.equal(fs.existsSync(r.clientRoot), false, 'remote commands never opened a local engine');
  } finally {
    for (const s of live) {
      s.child.kill('SIGKILL');
      await s.done;
    }
    await r.cleanup();
  }
});

test('remote mode: an interactive shell on a real terminal, then a server stopped mid-session', async () => {
  const r = await serveRoot('shell');
  const live = new Set();
  const ttys = [];
  try {
    const serve = await startServe(r, live);
    const admin = ['--server', serve.origin, '--token', TOKENS.admin];
    const created = await spawnCli(r.clientEnv, ['sandbox', 'create', ...admin]).done;
    assert.equal(created.code, 0, created.stderr);
    const id = created.json.id;
    const exec = ['--server', serve.origin, '--token', TOKENS.exec];

    const shell = spawnTty(r.clientEnv, ['sandbox', 'shell', id, ...exec]);
    ttys.push(shell);
    await until(() => shell.screen().length > 0);
    shell.child.stdin.write('echo wb-$((40+2)); exit 3\n');
    const ran = await shell.done;
    assert.equal(ran.code, 3, `the CLI exits with the shell's own code:\n${ran.screen}`);
    assert.match(ran.screen, /wb-42/, 'the keystrokes ran in the box and its output came back');
    assert.ok(cooked(ran.screen), `the terminal is restored:\n${ran.screen}`);

    const dropped = spawnTty(r.clientEnv, ['sandbox', 'shell', id, ...exec]);
    ttys.push(dropped);
    await until(() => dropped.screen().length > 0);
    dropped.child.stdin.write('echo live-$((6*7))\n');
    await until(() => dropped.screen().includes('live-42'));
    const stoppedAt = Date.now();
    const [lost] = await Promise.all([dropped.done, stopServe(serve, live)]);
    assert.ok(lost.at - stoppedAt < 5000, `the CLI hung ${lost.at - stoppedAt} ms after the stop`);
    assert.equal(lost.signal, null);
    assert.equal(lost.code, 4, lost.screen);
    assert.match(
      lost.screen,
      /workbox: connection to http:\/\/127\.0\.0\.1:\d+ lost: .*; session \S+ keeps running in sandbox \S+ \(E_UNAVAILABLE\)/,
    );
    assert.ok(cooked(lost.screen), `the terminal is restored after the drop:\n${lost.screen}`);
    assert.equal(fs.existsSync(r.clientRoot), false, 'remote shells never opened a local engine');
  } finally {
    for (const t of ttys) {
      t.child.kill('SIGKILL');
      await t.done;
    }
    for (const s of live) {
      s.child.kill('SIGKILL');
      await s.done;
    }
    await r.cleanup();
  }
});
