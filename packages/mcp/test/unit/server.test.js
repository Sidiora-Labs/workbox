import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage } from '../../src/server.js';

test('json-rpc initialize/tools/list/call/ping and unknown method', async () => {
  const client = { listSandboxes: async () => ({ items: [] }) };
  const init = await handleMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    client,
  );
  assert.equal(init.result.serverInfo.name, 'workbox');
  const list = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, client);
  assert.deepEqual(
    list.result.tools.map((t) => t.name),
    ['sandbox_create', 'sandbox_list', 'sandbox_exec', 'sandbox_destroy'],
  );
  const call = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'sandbox_list', arguments: {} },
    },
    client,
  );
  assert.equal(call.result.content[0].type, 'text');
  assert.deepEqual(await handleMessage({ jsonrpc: '2.0', id: 4, method: 'ping' }, client), {
    jsonrpc: '2.0',
    id: 4,
    result: {},
  });
  const bad = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'nope' }, client);
  assert.equal(bad.error.code, -32601);
});
