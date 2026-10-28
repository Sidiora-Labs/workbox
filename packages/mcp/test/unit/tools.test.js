import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, TOOL_NAMES, callTool, formatExec } from '../../src/tools.js';

test('exactly the four spec tools are exposed (req 6.4)', () => {
  assert.deepEqual(
    [...TOOL_NAMES],
    ['sandbox_create', 'sandbox_list', 'sandbox_exec', 'sandbox_destroy'],
  );
  assert.equal(TOOLS.length, 4);
});

test('callTool maps to the sdk and bounds exec output', async () => {
  const client = {
    createSandbox: async () => ({ id: 'sb-1', row: { state: 'READY' } }),
    listSandboxes: async () => ({ items: [{ id: 'sb-1', state: 'READY', health: 'HEALTHY' }] }),
    sandbox: (id) => ({
      exec: async (opts) => ({
        exitCode: 0,
        stdout: `ran:${opts.argv[2]}:${id}`,
        stderr: '',
        truncated: { stdout: false, stderr: false },
      }),
      destroy: async () => ({ state: 'DELETED' }),
    }),
  };
  const created = await callTool(client, 'sandbox_create', {});
  assert.match(created.content[0].text, /sb-1/);
  const exec = await callTool(client, 'sandbox_exec', { sandboxId: 'sb-1', command: 'echo hi' });
  assert.match(exec.content[0].text, /ran:echo hi:sb-1/);
  const unknown = await callTool(client, 'sandbox_shell', {});
  assert.equal(unknown.isError, true);
  assert.ok(formatExec({ stdout: 'x'.repeat(100000) }).length < 70000);
});
