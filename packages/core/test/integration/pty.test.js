import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Supervisor } from '../../src/sandbox/supervisor.js';
import { CgroupManager } from '../../src/host/cgroup.js';
import { exec } from '../../src/sandbox/exec.js';
import { testEngine, ensureAssets, ASSETS_ROOT } from '../helpers/engine.js';
import { tmpDir } from '../helpers/tmp.js';

const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.js', import.meta.url));

const until = async (fn, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 25));
  }
};

/**
 * PTY sessions in a real sandbox: the child sees a terminal, the requested size is the initial
 * window size, resize changes what `stty size` reports and delivers SIGWINCH, a pipe session
 * refuses resize, and stopping a PTY session still escalates TERM to KILL.
 */
test('pty sessions in a real sandbox: isatty, resize, pipe refusal, TERM to KILL', async () => {
  const eng = await testEngine();
  let sup = null;
  try {
    const row = eng.store.createSandbox({ name: 'pty', rootfs: 'minimal', runtime: 'current' });
    sup = new Supervisor({ ...eng, sandbox: row });
    await sup.launch();
    const out = new Map();
    const exits = new Map();
    sup.on('event', (method, p) => {
      if (method === 'session.output')
        out.set(p.sessionId, (out.get(p.sessionId) ?? '') + Buffer.from(p.data, 'base64'));
      if (method === 'session.exit') exits.set(p.sessionId, p);
    });
    const text = (sid) => out.get(sid) ?? '';
    const start = async (params) => {
      const info = await sup.request('session.start', params);
      await sup.request('session.attach', { sessionId: info.sessionId, fromSeq: 0 });
      return info.sessionId;
    };

    const loop = [
      'test -t 0 && test -t 1 && echo ISATTY=yes',
      "trap 'echo GOT-WINCH' WINCH",
      'i=0; last=',
      'while [ $i -lt 400 ]; do s=$(stty size); [ "$s" != "$last" ] && echo SIZE=$s; last=$s',
      '[ "$s" = "40 120" ] && exit 0; i=$((i+1)); sleep 0.05; done; exit 3',
    ].join('\n');
    const tty = await start({ argv: ['sh', '-c', loop], pty: true, rows: 30, cols: 100 });
    await until(() => /SIZE=30 100/.test(text(tty)));
    assert.match(text(tty), /ISATTY=yes/);
    const resized = await sup.request('session.resize', { sessionId: tty, rows: 40, cols: 120 });
    assert.deepEqual(resized, { sessionId: tty, rows: 40, cols: 120 });
    await until(() => exits.has(tty));
    assert.equal(exits.get(tty).code, 0, text(tty));
    assert.match(text(tty), /SIZE=40 120/);
    assert.match(text(tty), /GOT-WINCH/, 'the foreground group got SIGWINCH');

    const pipe = await start({ argv: ['sleep', '30'] });
    await assert.rejects(sup.request('session.resize', { sessionId: pipe, rows: 10, cols: 10 }), {
      code: 'E_UNSUPPORTED',
    });
    await sup.request('session.stop', { sessionId: pipe, graceMs: 1000 });

    const stubborn = await start({
      argv: ['sh', '-c', 'echo PID=$$; trap "" TERM HUP; while :; do sleep 1; done'],
      pty: true,
    });
    await until(() => /PID=\d+/.test(text(stubborn)));
    const leader = text(stubborn).match(/PID=(\d+)/)[1];
    const stopped = await sup.request('session.stop', { sessionId: stubborn, graceMs: 500 });
    assert.equal(stopped.escalated, true);
    assert.equal(stopped.exited.signal, 'SIGKILL');
    const probe = await exec(sup, {
      argv: ['sh', '-c', `awk '{print $3}' /proc/${leader}/stat 2>/dev/null || echo GONE`],
    });
    assert.match(probe.stdout.trim(), /^(GONE|Z|X)$/, `pty leader ${leader} was killed`);
  } finally {
    if (sup) await sup.destroy().catch(() => undefined);
    await eng.cleanup();
  }
});

/** A Workbox root for the CLI's local engine, sharing the test assets. @param {string} tag */
async function cliRoot(tag) {
  await ensureAssets();
  const t = tmpDir(`workbox-pty-${tag}-`);
  fs.chmodSync(t.dir, 0o711);
  fs.symlinkSync(path.join(ASSETS_ROOT, 'rootfs'), path.join(t.dir, 'rootfs'));
  fs.symlinkSync(path.join(ASSETS_ROOT, 'runtime'), path.join(t.dir, 'runtime'));
  const parent = `workbox-pty-${process.pid}-${tag}`;
  const env = { ...process.env, WORKBOX_ROOT: t.dir, WORKBOX_CGROUP_PARENT: parent };
  env.WORKBOX_NETWORK_MODE = 'none';
  delete env.WORKBOX_CONFIG;
  const cgroups = new CgroupManager({ root: '/sys/fs/cgroup', parent });
  const cleanup = async () => {
    if (fs.existsSync(cgroups.parentPath)) {
      for (const name of cgroups.list())
        await cgroups.remove(cgroups.childPath(name), { timeoutMs: 10_000 }).catch(() => undefined);
      fs.rmdirSync(cgroups.parentPath);
    }
    t.cleanup();
  };
  return { env, cleanup };
}

function runCli(env, args) {
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', CLI_MAIN, ...args],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * `workbox shell` driven through a real host pseudo-terminal (script(1)): the CLI puts the host
 * terminal in raw mode, the box shell sees a tty of the host terminal's size, a host resize
 * reaches the box, and the shell's exit code becomes the CLI's.
 */
test('workbox shell: raw mode, isatty inside and resize forwarding through a host pty', async () => {
  const root = await cliRoot('shell');
  let id = null;
  let host = null;
  try {
    const created = await runCli(root.env, ['sandbox', 'create', '--name', 'ptyshell']);
    assert.equal(created.code, 0, created.stderr);
    id = JSON.parse(created.stdout).id;

    const node = `${process.execPath} --disable-warning=ExperimentalWarning`;
    const inner = `tty; stty rows 30 cols 100; exec ${node} ${CLI_MAIN} shell ${id}`;
    host = spawn('script', ['-q', '-e', '-c', inner, '/dev/null'], {
      env: { ...root.env, TERM: 'xterm' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let screen = '';
    host.stdout.on('data', (d) => (screen += d));
    const closed = new Promise((resolve) => host.on('close', (code) => resolve(code)));
    await until(() => /\/dev\/pts\/\d+/.test(screen));
    const hostTty = screen.match(/(\/dev\/pts\/\d+)/)[1];
    const hostMode = () => execFileSync('stty', ['-F', hostTty, '-a'], { encoding: 'utf8' });
    await until(() => /-icanon/.test(hostMode()) && /-echo\b/.test(hostMode()), 30_000);

    const type = (line) => host.stdin.write(`${line}\r`);
    type('test -t 0 && test -t 1 && echo "ISA""TTY=yes"; echo "SI""ZE=$(stty size)"');
    await until(() => /SIZE=30 100/.test(screen), 30_000);
    assert.match(screen, /ISATTY=yes/);

    execFileSync('stty', ['-F', hostTty, 'rows', '40', 'cols', '120']);
    const deadline = Date.now() + 15_000;
    while (!/SIZE=40 120/.test(screen) && Date.now() < deadline) {
      type('echo "SI""ZE=$(stty size)"');
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.match(screen, /SIZE=40 120/, 'the host resize reached the box pty');

    type('exit 7');
    assert.equal(await closed, 7, screen);
    host = null;
  } finally {
    if (host) host.kill('SIGKILL');
    if (id) await runCli(root.env, ['sandbox', 'rm', id]);
    await root.cleanup();
  }
});
