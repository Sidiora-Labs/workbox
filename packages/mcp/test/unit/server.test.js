import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { WorkboxClient } from '@workbox/sdk';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import {
  ErrorCodes,
  PROTOCOL_VERSIONS,
  VERSION,
  handleMessage,
  runStdio,
} from '../../src/server.js';
import { TOOLS } from '../../src/tools.js';

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });

/** Feed lines to runStdio, end the input and collect every reply line once it has drained. */
async function converse(client, lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const done = runStdio({ client, input, output });
  for (const line of lines) input.write(`${line}\n`);
  input.end();
  await done;
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test('initialize negotiates the protocol version; ping and tools/list answer', async () => {
  const client = new WorkboxClient({ baseUrl: 'http://127.0.0.1:9' });
  assert.deepEqual(PROTOCOL_VERSIONS, ['2025-06-18', '2025-03-26', '2024-11-05']);
  for (const version of PROTOCOL_VERSIONS) {
    const init = await handleMessage(rpc(1, 'initialize', { protocolVersion: version }), client);
    assert.deepEqual(init, {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'workbox', version: VERSION },
      },
    });
  }
  const future = await handleMessage(
    rpc(2, 'initialize', { protocolVersion: '2099-01-01' }),
    client,
  );
  assert.equal(future.result.protocolVersion, '2025-06-18');
  const bare = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize' }, client);
  assert.equal(bare.result.protocolVersion, '2025-06-18');
  assert.deepEqual(await handleMessage(rpc(4, 'ping'), client), {
    jsonrpc: '2.0',
    id: 4,
    result: {},
  });
  const list = await handleMessage(rpc('five', 'tools/list', {}), client);
  assert.equal(list.id, 'five');
  assert.equal(list.result.tools, TOOLS);
});

test('notifications and responses get no reply; malformed requests get JSON-RPC errors', async () => {
  const client = new WorkboxClient({ baseUrl: 'http://127.0.0.1:9' });
  assert.equal(
    await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, client),
    null,
  );
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'tools/call' }, client), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 9, result: {} }, client), null);
  assert.deepEqual(await handleMessage([rpc(1, 'ping')], client), {
    jsonrpc: '2.0',
    id: null,
    error: { code: ErrorCodes.INVALID_REQUEST, message: 'a message must be a JSON-RPC object' },
  });
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 1 }, client)).error.code, -32600);
  const unknown = await handleMessage(rpc(2, 'resources/list', {}), client);
  assert.deepEqual(unknown.error, { code: -32601, message: 'method not found: resources/list' });
  const nameless = await handleMessage(rpc(3, 'tools/call', { arguments: {} }), client);
  assert.deepEqual(nameless.error, { code: -32602, message: 'tools/call requires params.name' });
  const tool = await handleMessage(rpc(4, 'tools/call', { name: 'sandbox_shell' }), client);
  assert.equal(tool.error.code, -32602);
  assert.equal(tool.error.message, 'unknown tool: sandbox_shell');
  const args = await handleMessage(
    rpc(5, 'tools/call', { name: 'sandbox_destroy', arguments: { sandboxId: 1 } }),
    client,
  );
  assert.deepEqual(args.error, {
    code: -32602,
    message: 'sandbox_destroy: invalid arguments: sandboxId must be a string',
    data: { tool: 'sandbox_destroy', problems: ['sandboxId must be a string'] },
  });
  assert.deepEqual(ErrorCodes, {
    PARSE: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL: -32603,
  });
});

test('the stdio loop answers each line, concurrently, against a real server', async () => {
  const srv = await bootServer();
  const client = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.read, retryDelayMs: 5 });
  try {
    const replies = await converse(client, [
      JSON.stringify(rpc(1, 'tools/call', { name: 'sandbox_list', arguments: { limit: 1 } })),
      'not json',
      '',
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify(rpc(2, 'ping')),
    ]);
    assert.deepEqual(
      replies.map((r) => r.id),
      [null, 2, 1],
      'the ping is answered while the earlier tools/call is still in flight',
    );
    assert.deepEqual(replies[0], {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'parse error' },
    });
    assert.deepEqual(replies[1].result, {});
    assert.deepEqual(replies[2].result, {
      content: [{ type: 'text', text: '{"sandboxes":[],"cursor":null,"complete":true}' }],
    });
  } finally {
    await srv.stop();
  }
});
