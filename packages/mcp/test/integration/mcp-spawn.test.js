import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { MAX_OUTPUT_BYTES, TOOLS } from '../../src/tools.js';

const MAIN = fileURLToPath(new URL('../../src/main.js', import.meta.url));
const NAMES = [
  'sandbox_create',
  'sandbox_list',
  'sandbox_exec',
  'sandbox_destroy',
  'agent_run',
  'agent_output',
];

/**
 * `workbox-mcp` as a child process over stdio. `request` sends one JSON-RPC request and resolves
 * to the reply with its id; every stdout line that is not JSON-RPC lands in `garbage`.
 */
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
  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  return {
    child,
    garbage,
    stderr: () => stderr,
    notify: (method, params) => send({ method, params }),
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
        send({ id, method, params });
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
async function callJson(mcp, name, args) {
  const reply = await mcp.request('tools/call', { name, arguments: args });
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  assert.equal(reply.result.isError, undefined, reply.result.content[0].text);
  assert.equal(reply.result.content.length, 1);
  assert.equal(reply.result.content[0].type, 'text');
  return JSON.parse(reply.result.content[0].text);
}

test(
  'a spawned MCP server drives a real sandbox through a real server over stdio',
  { timeout: 300_000 },
  async (t) => {
    const srv = await bootServer();
    const mcp = spawnMcp({ WORKBOX_SERVER: srv.base, WORKBOX_TOKEN: TOKENS.admin });
    try {
      await t.test('initialize negotiates the protocol and announces only tools', async () => {
        const init = await mcp.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'workbox-mcp-test', version: '0' },
        });
        assert.deepEqual(init.result, {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'workbox', version: '0.1.0-alpha.1' },
        });
        mcp.notify('notifications/initialized');
        assert.deepEqual((await mcp.request('ping')).result, {});
      });

      await t.test('tools/list returns exactly the sandbox and agent tools, verbatim', async () => {
        const { result } = await mcp.request('tools/list', {});
        assert.deepEqual(
          result.tools.map((tool) => tool.name),
          NAMES,
        );
        assert.deepEqual(result.tools, JSON.parse(JSON.stringify(TOOLS)));
      });

      await t.test(
        'unknown tools, bad arguments and unknown methods are JSON-RPC errors',
        async () => {
          const unknown = await mcp.request('tools/call', { name: 'sandbox_shell', arguments: {} });
          assert.equal(unknown.error.code, -32602);
          assert.match(unknown.error.message, /unknown tool: sandbox_shell/);
          assert.deepEqual(unknown.error.data.tools, NAMES);
          const missing = await mcp.request('tools/call', {
            name: 'sandbox_exec',
            arguments: { sandboxId: 'sbx-x' },
          });
          assert.equal(missing.error.code, -32602);
          assert.deepEqual(missing.error.data.problems, ['command is required']);
          const wrong = await mcp.request('tools/call', {
            name: 'sandbox_exec',
            arguments: { sandboxId: 'sbx-x', command: 'true', timeoutMs: 'soon', argv: ['x'] },
          });
          assert.equal(wrong.error.code, -32602);
          assert.deepEqual(wrong.error.data.problems, [
            'timeoutMs must be an integer in 1..240000',
            'argv is not a parameter',
          ]);
          const nameless = await mcp.request('tools/call', { arguments: {} });
          assert.equal(nameless.error.code, -32602);
          assert.equal((await mcp.request('resources/list', {})).error.code, -32601);
        },
      );

      const created = await callJson(mcp, 'sandbox_create', {
        name: 'mcp-box',
        networkMode: 'none',
      });
      assert.equal(created.name, 'mcp-box');
      assert.equal(created.state, 'READY');
      assert.match(created.id, /\S/);

      await t.test('sandbox_exec runs inside that sandbox and returns its output', async () => {
        const ran = await callJson(mcp, 'sandbox_exec', {
          sandboxId: created.id,
          command: 'wb status --json; echo "uid=$(id -u)"; echo to-stderr >&2; exit 7',
        });
        assert.equal(ran.exitCode, 7);
        assert.equal(ran.signal, null);
        assert.equal(ran.timedOut, false);
        assert.deepEqual(ran.truncated, { stdout: false, stderr: false });
        assert.equal(ran.notice, undefined);
        assert.equal(ran.stderr, 'to-stderr\n');
        const lines = ran.stdout.trim().split('\n');
        const { broker, runner } = JSON.parse(lines.slice(0, -1).join('\n'));
        assert.equal(broker.sandboxId, created.id);
        assert.equal(runner.sandboxId, created.id);
        assert.equal(broker.name, 'mcp-box');
        assert.equal(broker.network.mode, 'none');
        assert.match(lines.at(-1), /^uid=\d+$/);
        const execs = srv
          .auditEntries()
          .filter((e) => e.action === 'api.sandbox.exec' && e.sandboxId === created.id);
        assert.deepEqual(
          execs.map((e) => [e.actor, e.data.status, e.data.outcome, e.data.exitCode]),
          [['api:root', 200, 'ok', 7]],
        );
      });

      await t.test('output past the cap comes back cut and reported, never silently', async () => {
        const ran = await callJson(mcp, 'sandbox_exec', {
          sandboxId: created.id,
          command: `head -c ${MAX_OUTPUT_BYTES + 5000} /dev/zero | tr '\\0' x; echo done >&2`,
        });
        assert.equal(ran.exitCode, 0);
        assert.equal(ran.stdout, 'x'.repeat(MAX_OUTPUT_BYTES));
        assert.equal(ran.stderr, 'done\n');
        assert.deepEqual(ran.truncated, { stdout: true, stderr: false });
        assert.equal(ran.notice, `stdout truncated to ${MAX_OUTPUT_BYTES} bytes`);
      });

      await t.test('a command past its deadline is reported as timed out', async () => {
        const ran = await callJson(mcp, 'sandbox_exec', {
          sandboxId: created.id,
          command: 'echo started; exec sleep 600',
          timeoutMs: 1000,
        });
        assert.equal(ran.timedOut, true);
        assert.equal(ran.exitCode, null);
        assert.equal(ran.stdout, 'started\n');
      });

      await t.test('a call the server refuses is a tool error the model can read', async () => {
        const reply = await mcp.request('tools/call', {
          name: 'sandbox_exec',
          arguments: { sandboxId: 'sbx-does-not-exist', command: 'true' },
        });
        assert.equal(reply.result.isError, true);
        assert.match(reply.result.content[0].text, /^E_NOT_FOUND: /);
      });

      await t.test('sandbox_list shows the sandbox, sandbox_destroy removes it', async () => {
        const listed = await callJson(mcp, 'sandbox_list', {});
        assert.deepEqual(listed, {
          sandboxes: [
            {
              id: created.id,
              name: 'mcp-box',
              state: 'READY',
              health: listed.sandboxes[0]?.health,
              rootfs: created.rootfs,
            },
          ],
          cursor: null,
          complete: true,
        });
        assert.equal(typeof listed.sandboxes[0].health, 'string');
        const gone = await callJson(mcp, 'sandbox_destroy', { sandboxId: created.id });
        assert.deepEqual(gone, { id: created.id, state: 'DELETED' });
        assert.equal(srv.manager.get(created.id).state, 'DELETED');
        assert.deepEqual((await callJson(mcp, 'sandbox_list', {})).sandboxes, []);
      });

      assert.deepEqual(mcp.garbage, []);
    } finally {
      await mcp.close();
      await srv.stop();
    }
    assert.equal(mcp.child.exitCode, 0, mcp.stderr());
  },
);
