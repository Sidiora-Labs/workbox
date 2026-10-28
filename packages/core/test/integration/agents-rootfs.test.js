import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { BUILTIN_ROOTFS_DIR, RootfsManager, sha256File } from '../../src/host/rootfs.js';
import { Manager } from '../../src/sandbox/manager.js';
import { ASSETS_ROOT, testEngine } from '../helpers/engine.js';
import { agentSandboxInput, agentSessionParams } from '../../../sdk/src/agents.js';

// Host-side test traffic must never go through an ambient HTTP(S) proxy.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])
  delete process.env[k];

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
    return rootfs.build('agents', { force: true });
  return built;
}

const run = (manager, id, params, timeoutMs = 60_000) =>
  manager.exec(id, {
    argv: params.argv,
    cwd: params.cwd,
    env: params.env,
    name: params.name,
    timeoutMs,
  });

test(
  'agents rootfs: pinned CLIs, unattended config as root, vendor hosts through the allowlist',
  { timeout: 2_400_000 },
  async (t) => {
    await ensureAgentsRootfs();
    const eng = await testEngine({ network: 'none' });
    const manager = new Manager({
      config: eng.config,
      store: eng.store,
      audit: eng.audit,
      cgroups: eng.cgroups,
      rootfs: eng.rootfs,
      runtime: eng.runtime,
      logger: eng.logger,
    });
    const ids = [];
    const create = async (input) => {
      const sb = await manager.create(input);
      ids.push(sb.id);
      return sb.id;
    };
    try {
      const none = await create(
        agentSandboxInput('claude', { name: 'agents-none', network: 'none' }),
      );

      await t.test('the pinned node, claude and codex versions', async () => {
        const r = await manager.exec(none, {
          argv: ['sh', '-c', 'node --version; claude --version; codex --version; id -u'],
        });
        assert.equal(r.exitCode, 0, r.stderr);
        assert.deepEqual(r.stdout.trim().split('\n'), [
          'v22.23.4',
          '2.1.312 (Claude Code)',
          'codex-cli 0.165.0',
          '0',
        ]);
      });

      await t.test('headless claude as root runs in bypass mode and stops at sign-in', async () => {
        const r = await run(manager, none, agentSessionParams('claude', { prompt: 'say hi' }));
        const out = r.stdout + r.stderr;
        assert.equal(r.timedOut, false);
        assert.equal(r.exitCode, 1, out);
        assert.doesNotMatch(out, /cannot be used with root\/sudo privileges/);
        assert.match(r.stdout, /Not logged in/);
      });

      await t.test(
        'headless codex runs without its sandbox or approvals and fails on the network',
        async () => {
          // Offline, codex retries the unreachable API with backoff for minutes; the first 45 s
          // show the effective config and the network failures.
          const r = await run(
            manager,
            none,
            agentSessionParams('codex', { prompt: 'say hi' }),
            45_000,
          );
          assert.match(r.stderr, /^approval: never$/m);
          assert.match(r.stderr, /^sandbox: danger-full-access$/m);
          assert.match(r.stderr, /^workdir: \/workspace$/m);
          assert.match(
            r.stderr,
            /failed to lookup address|stream disconnected|error sending request|Network is unreachable/,
          );
          assert.doesNotMatch(r.stderr, /Not inside a trusted directory|approval required/i);
        },
      );

      const allow = await create(
        agentSandboxInput('claude', { name: 'agents-allow', extras: [], allow: ['@openai'] }),
      );
      await t.test(
        'allowlist @anthropic + @openai: vendor APIs reached, example.com refused',
        async () => {
          const probe = async (url) => {
            const r = await manager.exec(allow, {
              argv: [
                'sh',
                '-c',
                `curl -s -o /dev/null --max-time 20 -w '%{http_code} %{http_connect}' '${url}'`,
              ],
            });
            const [code, connect] = r.stdout.trim().split(' ');
            return { code, connect };
          };
          for (const url of ['https://api.anthropic.com/', 'https://api.openai.com/']) {
            const r = await probe(url);
            assert.equal(r.connect, '200', `${url} tunnels through the proxy`);
            assert.match(r.code, /^[1-5]\d\d$/, `${url} answered: ${r.code}`);
          }
          // Online without a credential, headless codex ends on the API's 401: stdin is the
          // empty file, so it does not wait for piped input.
          const codex = await run(
            manager,
            allow,
            agentSessionParams('codex', { prompt: 'say hi' }),
            180_000,
          );
          assert.equal(codex.timedOut, false, codex.stderr);
          assert.equal(codex.exitCode, 1, codex.stderr);
          assert.match(codex.stderr, /401 Unauthorized/);
          assert.doesNotMatch(codex.stderr, /Not inside a trusted directory|approval required/i);
          assert.deepEqual(await probe('https://example.com/'), { code: '000', connect: '403' });
        },
      );
    } finally {
      for (const id of ids) await manager.destroy(id, { timeoutMs: 10_000 }).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    }
  },
);
