import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpts, connectionOpts, sandboxCommand } from '../../src/commands.js';

test('option parsing and remote sandbox routing', async () => {
  assert.deepEqual(
    connectionOpts(['--server', 'http://x', '--token', 't', 'rest']).server,
    'http://x',
  );
  assert.equal(parseOpts(['--name', 'n'], new Set(['name'])).opts.name, 'n');
  const calls = [];
  const client = {
    createSandbox: async (input) => {
      calls.push(input);
      return { id: 'sb-1', row: { id: 'sb-1' } };
    },
    listSandboxes: async () => ({ items: [] }),
    sandbox: () => ({ inspect: async () => ({ id: 'sb-1' }), exec: async () => ({ exitCode: 0 }) }),
  };
  const ctx = { client, out: { write() {} }, err: { write() {} } };
  assert.deepEqual(await sandboxCommand(ctx, ['ls']), { items: [] });
  assert.deepEqual(await sandboxCommand(ctx, ['inspect', 'sb-1']), { id: 'sb-1' });
  assert.throws(() => parseOpts(['--name'], new Set(['name'])), /needs a value/);
});
