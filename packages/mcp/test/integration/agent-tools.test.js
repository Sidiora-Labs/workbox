import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WorkboxClient } from '@workbox/sdk';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { loadConfig } from '../../../core/src/config.js';
import { BUILTIN_ROOTFS_DIR, RootfsManager, sha256File } from '../../../core/src/host/rootfs.js';
import { SecretProvider } from '../../../core/src/secrets.js';
import { ASSETS_ROOT } from '../../../core/test/helpers/engine.js';
import { MAX_OUTPUT_BYTES } from '../../src/tools.js';

const MAIN = fileURLToPath(new URL('../../src/main.js', import.meta.url));

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

/** `workbox-mcp` as a child process over stdio; `request` resolves to the reply with its id. */
function spawnMcp(env) {
  const child = spawn(process.execPath, [MAIN], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const garbage = [];
  let stderr = '';
  let nextId = 1;
  child.stderr.on('data', (d) => (stderr += d));
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      garbage.push(line);
      return;
    }
    if (msg?.jsonrpc !== '2.0' || !waiting.has(msg.id)) garbage.push(line);
    else waiting.get(msg.id).resolve(msg);
  });
  child.on('exit', (code, signal) => {
    for (const w of waiting.values())
      w.reject(new Error(`mcp exited (${code ?? signal}) before replying; stderr: ${stderr}`));
  });
  return {
    child,
    garbage,
    stderr: () => stderr,
    request(method, params, timeoutMs = 120_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error(`no reply to ${method} in ${timeoutMs} ms; stderr: ${stderr}`));
        }, timeoutMs);
        const settle = (fn) => (value) => {
          clearTimeout(timer);
          waiting.delete(id);
          fn(value);
        };
        waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}

/** One tools/call whose result is a single JSON text block. */
async function callJson(mcp, name, args, timeoutMs) {
  const reply = await mcp.request('tools/call', { name, arguments: args }, timeoutMs);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.isError, undefined, reply.result.content[0].text);
  return JSON.parse(reply.result.content[0].text);
}

test(
  'agent tools hand tasks to the real agents in real boxes over stdio (network none)',
  { timeout: 900_000 },
  async (t) => {
    await ensureAgentsRootfs();
    const srv = await bootServer();
    // A host secret provider holding no agent credential: the path of a host without the secret.
    srv.manager.secrets = new SecretProvider({ env: {} });
    const client = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.admin });
    const mcp = spawnMcp({ WORKBOX_SERVER: srv.base, WORKBOX_TOKEN: TOKENS.admin });
    const boxes = new Set();
    const live = () =>
      srv.manager
        .list({ limit: 100 })
        .items.filter((row) => row.state !== 'DELETED')
        .map((row) => row.id)
        .sort();
    try {
      const init = await mcp.request('initialize', { protocolVersion: '2025-06-18' });
      assert.equal(init.result.serverInfo.name, 'workbox');
      const { result } = await mcp.request('tools/list', {});
      assert.deepEqual(result.tools.map((tool) => tool.name).slice(-2), [
        'agent_run',
        'agent_output',
      ]);

      let claude;
      await t.test(
        '(a) claude without a credential ends on its own error, in /workspace',
        async () => {
          claude = await callJson(
            mcp,
            'agent_run',
            {
              agent: 'claude',
              prompt: 'say hi',
              networkMode: 'none',
              secretRefs: [],
              timeoutMs: 120_000,
            },
            180_000,
          );
          boxes.add(claude.sandboxId);
          assert.equal(claude.running, false);
          assert.equal(typeof claude.exitCode, 'number');
          assert.notEqual(claude.exitCode, 0, claude.output);
          assert.equal(claude.signal, null);
          assert.equal(claude.truncated, false);
          assert.match(claude.output, /Not logged in|Unable to connect|connection/i);
          assert.doesNotMatch(claude.output, /cannot be used with root\/sudo privileges/);
          const row = srv.manager.get(claude.sandboxId);
          assert.equal(row.rootfs, 'agents');
          assert.equal(row.profile.network.mode, 'none');
          assert.equal(row.labels['workbox.agent'], 'claude');
          const { sessions } = await client.sandbox(claude.sandboxId).listSessions();
          const session = sessions.find((s) => s.sessionId === claude.sessionId);
          assert.equal(session.cwd, '/workspace');
          assert.deepEqual(session.argv.slice(-4), [
            '--dangerously-skip-permissions',
            '-p',
            '--',
            'say hi',
          ]);
        },
      );

      await t.test('(b) codex past its timeout keeps running; agent_output reads on', async () => {
        const first = await callJson(mcp, 'agent_run', {
          agent: 'codex',
          prompt: 'say hi',
          networkMode: 'none',
          secretRefs: [],
          timeoutMs: 3000,
        });
        boxes.add(first.sandboxId);
        assert.equal(first.running, true);
        assert.match(first.sessionId, /\S/);
        assert.equal('exitCode' in first, false);
        assert.equal(first.truncated, false);
        const later = await callJson(
          mcp,
          'agent_output',
          { sandboxId: first.sandboxId, sessionId: first.sessionId, timeoutMs: 45_000 },
          120_000,
        );
        assert.equal(later.sandboxId, first.sandboxId);
        assert.equal(later.sessionId, first.sessionId);
        assert.ok(later.output.startsWith(first.output), 'the read replays from the first byte');
        assert.ok(
          !later.running || later.output.length > first.output.length,
          `no new output or exit: ${later.output}`,
        );
        assert.match(later.output, /^workdir: \/workspace$/m);
        const startedAt = Date.now();
        const now = await callJson(mcp, 'agent_output', {
          sandboxId: first.sandboxId,
          sessionId: first.sessionId,
        });
        assert.ok(Date.now() - startedAt < 10_000, 'a 0 ms read returns at once');
        assert.ok(now.output.startsWith(later.output), 'a 0 ms read returns what already exists');
        const gone = await callJson(mcp, 'sandbox_destroy', { sandboxId: first.sandboxId });
        assert.deepEqual(gone, { id: first.sandboxId, state: 'DELETED' });
        boxes.delete(first.sandboxId);
      });

      await t.test(
        '(c) a secret the host lacks is a tool error naming it and the sign-in',
        async () => {
          const before = live();
          for (const [agent, ref, signIn] of [
            ['claude', 'ANTHROPIC_API_KEY', 'claude setup-token'],
            ['codex', 'OPENAI_API_KEY', 'codex login --device-auth'],
          ]) {
            const reply = await mcp.request('tools/call', {
              name: 'agent_run',
              arguments: { agent, prompt: 'say hi', networkMode: 'none' },
            });
            assert.equal(reply.error, undefined);
            assert.equal(reply.result.isError, true);
            const text = reply.result.content[0].text;
            assert.match(text, new RegExp(`secret ${ref} is not configured on the Workbox host`));
            assert.ok(text.includes(`\`${signIn}\``), text);
          }
          assert.deepEqual(live(), before, 'the boxes made for the refused runs are gone');
        },
      );

      await t.test('(d) a run given a sandboxId runs in that same box', async () => {
        const before = live();
        const again = await callJson(
          mcp,
          'agent_run',
          {
            agent: 'claude',
            prompt: 'say hi again',
            sandboxId: claude.sandboxId,
            secretRefs: [],
            timeoutMs: 120_000,
          },
          180_000,
        );
        assert.equal(again.sandboxId, claude.sandboxId);
        assert.notEqual(again.sessionId, claude.sessionId);
        assert.equal(again.running, false);
        assert.notEqual(again.exitCode, 0);
        assert.match(again.output, /Not logged in|Unable to connect|connection/i);
        assert.deepEqual(live(), before);
        const { sessions } = await client.sandbox(claude.sandboxId).listSessions();
        const ids = sessions.map((s) => s.sessionId);
        assert.ok(ids.includes(claude.sessionId) && ids.includes(again.sessionId));
      });

      await t.test('agent_output keeps the last 64 KiB of a real session and says so', async () => {
        const { sessionId } = await client.sandbox(claude.sandboxId).startSession({
          argv: [
            'sh',
            '-c',
            `head -c ${MAX_OUTPUT_BYTES + 5000} /dev/zero | tr '\\0' x; echo; echo END >&2`,
          ],
        });
        const out = await callJson(
          mcp,
          'agent_output',
          { sandboxId: claude.sandboxId, sessionId, timeoutMs: 30_000 },
          60_000,
        );
        assert.equal(out.running, false);
        assert.equal(out.exitCode, 0);
        assert.equal(out.signal, null);
        assert.equal(out.truncated, true);
        assert.equal(Buffer.byteLength(out.output), MAX_OUTPUT_BYTES);
        assert.match(out.output, /^x+\nEND\n$/);
      });

      const missing = await mcp.request('tools/call', {
        name: 'agent_output',
        arguments: { sandboxId: claude.sandboxId, sessionId: 'no-such-session' },
      });
      assert.equal(missing.result.isError, true);
      assert.match(missing.result.content[0].text, /^E_NOT_FOUND: session no-such-session/);

      const gone = await callJson(mcp, 'sandbox_destroy', { sandboxId: claude.sandboxId });
      assert.equal(gone.state, 'DELETED');
      boxes.delete(claude.sandboxId);
      assert.deepEqual(live(), []);
      assert.deepEqual(mcp.garbage, []);
    } finally {
      for (const id of boxes)
        await client
          .sandbox(id)
          .destroy()
          .catch(() => undefined);
      await mcp.close();
      await srv.stop();
    }
    assert.equal(mcp.child.exitCode, 0, mcp.stderr());
  },
);
