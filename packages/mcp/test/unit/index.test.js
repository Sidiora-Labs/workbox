import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mcp from '../../src/index.js';
import * as tools from '../../src/tools.js';
import * as server from '../../src/server.js';
import * as entry from '../../src/main.js';

test('index re-exports the tools, the server and the entry point', () => {
  assert.deepEqual(Object.keys(mcp).sort(), [
    'DEFAULT_SERVER',
    'ErrorCodes',
    'MAX_EXEC_TIMEOUT_MS',
    'MAX_OUTPUT_BYTES',
    'PROTOCOL_VERSIONS',
    'TOOLS',
    'TOOL_NAMES',
    'ToolCallError',
    'VERSION',
    'callTool',
    'checkArguments',
    'formatExec',
    'handleMessage',
    'main',
    'runStdio',
  ]);
  for (const [name, value] of Object.entries(mcp))
    assert.equal(value, tools[name] ?? server[name] ?? entry[name], name);
  assert.deepEqual(
    [...mcp.TOOL_NAMES],
    [
      'sandbox_create',
      'sandbox_list',
      'sandbox_exec',
      'sandbox_destroy',
      'agent_run',
      'agent_output',
    ],
  );
});
