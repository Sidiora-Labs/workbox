import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CgroupManager } from '../../packages/core/src/index.js';
import { ensureAssets, ASSETS_ROOT } from '../../packages/core/test/helpers/engine.js';
import { tmpDir } from '../../packages/core/test/helpers/tmp.js';

/**
 * Coding agents against the real vendor APIs: a real `workbox serve` holds the key as its host
 * secret and `workbox agent <claude|codex> -p ... --server` runs the agent in an allowlist box of
 * the `agents` rootfs. Each run needs its key in WORKBOX_E2E_ANTHROPIC_API_KEY or
 * WORKBOX_E2E_OPENAI_API_KEY; without it the run is skipped, which is "not run", never a pass.
 */

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

const MAIN = fileURLToPath(new URL('../../packages/cli/src/main.js', import.meta.url));
const TOKEN = 'e2e-agents-token';
const PROMPT = 'Reply with exactly: wb-agent-ok';

const RUNS = [
  { agent: 'claude', ref: 'ANTHROPIC_API_KEY', key: process.env.WORKBOX_E2E_ANTHROPIC_API_KEY },
  { agent: 'codex', ref: 'OPENAI_API_KEY', key: process.env.WORKBOX_E2E_OPENAI_API_KEY },
];

function spawnCli(env, args, ms) {
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
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done, out: () => stdout };
}

const readyz = (origin) =>
  new Promise((resolve) => {
    http
      .get(`${origin}/readyz`, { agent: false }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode === 200));
      })
      .on('error', () => resolve(false));
  });

for (const run of RUNS) {
  const envName = `WORKBOX_E2E_${run.ref}`;
  test(
    `${run.agent} answers a real prompt through workbox agent --server`,
    {
      timeout: 900_000,
      skip: run.key ? false : `not run: ${envName} is not set, so no real ${run.agent} API call`,
    },
    async () => {
      await ensureAssets();
      if (!fs.existsSync(path.join(ASSETS_ROOT, 'rootfs', 'agents')))
        throw new Error('the agents rootfs is not built under the test assets root');
      const t = tmpDir(`workbox-e2e-agent-${run.agent}-`);
      fs.chmodSync(t.dir, 0o711);
      const root = path.join(t.dir, 'root');
      fs.mkdirSync(root, { mode: 0o711 });
      fs.symlinkSync(path.join(ASSETS_ROOT, 'rootfs'), path.join(root, 'rootfs'));
      fs.symlinkSync(path.join(ASSETS_ROOT, 'runtime'), path.join(root, 'runtime'));
      const parent = `workbox-e2e-agent-${process.pid}-${run.agent}`;
      const base = { ...process.env };
      for (const k of Object.keys(base))
        if (k.startsWith('WORKBOX_SECRET_') || k.startsWith('WORKBOX_E2E_')) delete base[k];
      const config = path.join(t.dir, 'serve.json');
      const keys = [{ id: 'ops', token: TOKEN, scopes: ['admin', 'read', 'exec'] }];
      fs.writeFileSync(config, JSON.stringify({ keys, host: '127.0.0.1', port: 0 }), {
        mode: 0o600,
      });
      const serveEnv = {
        ...base,
        WORKBOX_ROOT: root,
        WORKBOX_CGROUP_PARENT: parent,
        WORKBOX_NETWORK_MODE: 'none',
        WORKBOX_SECRETS_FILE: path.join(t.dir, 'no-secrets.json'),
        [`WORKBOX_SECRET_${run.ref}`]: run.key,
      };
      const clientEnv = { ...base, WORKBOX_ROOT: path.join(t.dir, 'client-root') };
      const serve = spawnCli(serveEnv, ['serve', '--config', config], 900_000);
      const cgroups = new CgroupManager({ root: '/sys/fs/cgroup', parent });
      try {
        const deadline = Date.now() + 30_000;
        while (!/listening on http:\/\/[\d.]+:\d+\n/.test(serve.out())) {
          if (Date.now() > deadline) throw new Error('workbox serve did not listen');
          await delay(50);
        }
        const origin = serve.out().match(/listening on (http:\/\/[\d.]+:\d+)/)[1];
        while (!(await readyz(origin))) await delay(50);
        const remote = ['--server', origin, '--token', TOKEN];
        const r = await spawnCli(clientEnv, ['agent', run.agent, '-p', PROMPT, ...remote], 600_000)
          .done;
        assert.match(r.stdout, /wb-agent-ok/, `${r.stdout}\n${r.stderr}`);
        assert.equal(r.code, 0, r.stderr);
        assert.ok(!(r.stdout + r.stderr).includes(run.key), 'the key never shows');
        const id = r.stderr.match(/new sandbox (\S+) for /)[1];
        const rm = await spawnCli(clientEnv, ['sandbox', 'rm', id, ...remote], 60_000).done;
        assert.equal(rm.code, 0, rm.stderr);
      } finally {
        serve.child.kill('SIGTERM');
        await serve.done;
        if (fs.existsSync(cgroups.parentPath)) {
          for (const name of cgroups.list())
            await cgroups
              .remove(cgroups.childPath(name), { timeoutMs: 10_000 })
              .catch(() => undefined);
          fs.rmdirSync(cgroups.parentPath);
        }
        t.cleanup();
      }
    },
  );
}
