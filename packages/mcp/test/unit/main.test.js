import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runStdio } from '../../src/server.js';

test('stdio loop answers newline-delimited JSON-RPC', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const rl = runStdio({ client: { listSandboxes: async () => ({ items: [] }) }, input, output });
  input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
  input.write('not json\n');
  await new Promise((r) => setTimeout(r, 100));
  rl.close();
  const lines = text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines[0].result.tools.length, 4);
  assert.equal(lines[1].error.code, -32700);
});
