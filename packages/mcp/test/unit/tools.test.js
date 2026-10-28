import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkboxClient } from '@workbox/sdk';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import {
  MAX_EXEC_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  TOOLS,
  TOOL_NAMES,
  ToolCallError,
  callTool,
  checkArguments,
  formatExec,
} from '../../src/tools.js';

const ID = { type: 'string', minLength: 1, maxLength: 128 };

/** The tool list, verbatim: changing it is a change to req 6 ac_4. */
const EXPECTED = [
  {
    name: 'sandbox_create',
    description: 'Create an isolated sandbox and wait until it is ready. Returns its id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 64 },
        rootfs: { type: 'string', minLength: 1, maxLength: 128 },
        networkMode: { type: 'string', enum: ['none', 'egress', 'allowlist'] },
        allow: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 253 },
          maxItems: 64,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sandbox_list',
    description: 'List sandboxes with their state and health, one page at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        cursor: { type: 'string', minLength: 1, maxLength: 256 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sandbox_exec',
    description:
      'Run a shell command to completion inside a sandbox. Returns the exit code, stdout and ' +
      'stderr, each capped at 64 KiB; any cut is reported in truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        sandboxId: ID,
        command: { type: 'string', minLength: 1, maxLength: 65_536 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 240_000 },
      },
      required: ['sandboxId', 'command'],
      additionalProperties: false,
    },
  },
  {
    name: 'sandbox_destroy',
    description: 'Destroy a sandbox and delete its writable layer.',
    inputSchema: {
      type: 'object',
      properties: { sandboxId: ID },
      required: ['sandboxId'],
      additionalProperties: false,
    },
  },
];

function frozenThroughout(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenThroughout);
}

const problemsOf = (name, args) => {
  try {
    checkArguments(name, args);
    return [];
  } catch (e) {
    assert.ok(e instanceof ToolCallError);
    assert.equal(e.code, -32602);
    return e.data.problems ?? [e.message];
  }
};

test('exactly the four spec tools, verbatim and frozen all the way down (req 6 ac_4)', () => {
  assert.deepEqual(TOOLS, EXPECTED);
  assert.deepEqual(
    [...TOOL_NAMES],
    ['sandbox_create', 'sandbox_list', 'sandbox_exec', 'sandbox_destroy'],
  );
  assert.ok(frozenThroughout(TOOLS));
  assert.ok(Object.isFrozen(TOOL_NAMES));
  assert.equal(MAX_OUTPUT_BYTES, 65_536);
  assert.equal(MAX_EXEC_TIMEOUT_MS, 240_000);
  for (const tool of TOOLS) assert.ok(tool.description.length <= 160, tool.name);
});

test('checkArguments holds every call to its input schema', () => {
  assert.deepEqual(checkArguments('sandbox_list', undefined), {});
  assert.deepEqual(checkArguments('sandbox_exec', { sandboxId: 's', command: 'ls' }), {
    sandboxId: 's',
    command: 'ls',
  });
  assert.throws(
    () => checkArguments('sandbox_shell', {}),
    (e) =>
      e instanceof ToolCallError &&
      e.message === 'unknown tool: sandbox_shell' &&
      e.data.tools === TOOL_NAMES,
  );
  assert.throws(() => checkArguments('toString', {}), /unknown tool: toString/);
  assert.deepEqual(problemsOf('sandbox_list', []), ['sandbox_list: arguments must be an object']);
  assert.deepEqual(problemsOf('sandbox_destroy', {}), ['sandboxId is required']);
  assert.deepEqual(problemsOf('sandbox_destroy', { sandboxId: '' }), [
    'sandboxId must be 1..128 characters',
  ]);
  assert.deepEqual(problemsOf('sandbox_exec', { sandboxId: 7, command: 'x', timeoutMs: 0 }), [
    'sandboxId must be a string',
    'timeoutMs must be an integer in 1..240000',
  ]);
  assert.deepEqual(problemsOf('sandbox_list', { limit: 1.5, constructor: 'x' }), [
    'limit must be an integer in 1..100',
    'constructor is not a parameter',
  ]);
  assert.deepEqual(problemsOf('sandbox_create', { networkMode: 'open' }), [
    'networkMode must be one of none,egress,allowlist',
  ]);
  assert.deepEqual(problemsOf('sandbox_create', { allow: ['ok.example', 3] }), [
    'allow[1] must be a string',
  ]);
  assert.deepEqual(problemsOf('sandbox_create', { allow: 'x' }), [
    'allow must be an array of at most 64 items',
  ]);
});

test('formatExec caps each stream in bytes on a character boundary and reports every cut', () => {
  const clean = formatExec({ exitCode: 0, stdout: 'hi\n', stderr: '', durationMs: 4 });
  assert.deepEqual(clean, {
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 4,
    truncated: { stdout: false, stderr: false },
    stdout: 'hi\n',
    stderr: '',
  });
  const wide = `a${'é'.repeat(MAX_OUTPUT_BYTES)}`;
  const cut = formatExec({ exitCode: 1, stdout: 'ok', stderr: wide });
  assert.equal(Buffer.byteLength(cut.stderr), MAX_OUTPUT_BYTES - 1);
  assert.ok(wide.startsWith(cut.stderr));
  assert.deepEqual(cut.truncated, { stdout: false, stderr: true });
  assert.equal(cut.notice, `stderr truncated to ${MAX_OUTPUT_BYTES} bytes`);
  const fromServer = formatExec({
    exitCode: null,
    signal: 'SIGKILL',
    timedOut: true,
    stdout: 'x',
    stderr: 'y',
    truncated: { stdout: true, stderr: true },
  });
  assert.deepEqual(fromServer.truncated, { stdout: true, stderr: true });
  assert.equal(fromServer.notice, `stdout and stderr truncated to ${MAX_OUTPUT_BYTES} bytes`);
  assert.equal(fromServer.timedOut, true);
  assert.equal(fromServer.signal, 'SIGKILL');
});

test('callTool goes through the sdk to a real server; refusals come back as tool errors', async () => {
  const srv = await bootServer();
  const client = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.admin, retryDelayMs: 5 });
  try {
    assert.deepEqual(await callTool(client, 'sandbox_list', { limit: 5 }), {
      content: [{ type: 'text', text: '{"sandboxes":[],"cursor":null,"complete":true}' }],
    });
    const exec = await callTool(client, 'sandbox_exec', { sandboxId: 'sbx-none', command: 'ls' });
    assert.equal(exec.isError, true);
    assert.match(exec.content[0].text, /^E_NOT_FOUND: /);
    const destroy = await callTool(client, 'sandbox_destroy', { sandboxId: 'sbx-none' });
    assert.equal(destroy.isError, true);
    assert.match(destroy.content[0].text, /^E_NOT_FOUND: /);
    const reader = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.read, retryDelayMs: 5 });
    const denied = await callTool(reader, 'sandbox_create', { name: 'nope' });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /^E_DENIED: /);
    await assert.rejects(
      callTool(client, 'sandbox_create', { allow: ['example.com'] }),
      (e) =>
        e instanceof ToolCallError && e.data.problems[0] === 'allow needs networkMode allowlist',
    );
    await assert.rejects(callTool(client, 'sandbox_shell', {}), ToolCallError);
    const audited = srv.auditEntries().filter((e) => e.action === 'api.sandbox.create');
    assert.deepEqual(
      audited.map((e) => e.data.outcome),
      ['E_DENIED'],
    );
  } finally {
    await srv.stop();
  }
  const gone = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.admin, retries: 0 });
  const lost = await callTool(gone, 'sandbox_list', {});
  assert.equal(lost.isError, true);
  assert.match(lost.content[0].text, /^E_UNAVAILABLE: GET \/v1\/sandboxes failed/);
});
