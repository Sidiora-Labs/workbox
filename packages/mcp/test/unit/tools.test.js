import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENTS, WorkboxClient, agentSandboxInput, agentSessionParams } from '@workbox/sdk';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import {
  MAX_AGENT_TIMEOUT_MS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  OutputTail,
  TOOLS,
  TOOL_NAMES,
  ToolCallError,
  agentRunPlan,
  callTool,
  checkArguments,
  formatExec,
} from '../../src/tools.js';

const ID = { type: 'string', minLength: 1, maxLength: 128 };
const ALLOW = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 253 },
  maxItems: 64,
};

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
        allow: ALLOW,
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
  {
    name: 'agent_run',
    description:
      'Hand a task to Claude Code or Codex in a sandbox and wait up to timeoutMs for it. ' +
      'Returns the session id, exit code and the last 64 KiB of output.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['claude', 'codex'] },
        prompt: { type: 'string', minLength: 1, maxLength: 65_536 },
        sandboxId: ID,
        name: { type: 'string', minLength: 1, maxLength: 64 },
        networkMode: { type: 'string', enum: ['allowlist', 'egress', 'none'] },
        allow: ALLOW,
        secretRefs: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            pattern: '^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z_][A-Za-z0-9_]*)?$',
          },
          maxItems: 8,
        },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 240_000 },
      },
      required: ['agent', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'agent_output',
    description:
      "Read an agent session's output from the start, waiting up to timeoutMs for it to exit. " +
      'Returns the same shape as agent_run.',
    inputSchema: {
      type: 'object',
      properties: {
        sandboxId: ID,
        sessionId: ID,
        timeoutMs: { type: 'integer', minimum: 0, maximum: 240_000 },
      },
      required: ['sandboxId', 'sessionId'],
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

test('exactly the sandbox and agent tools, verbatim and frozen all the way down', () => {
  assert.deepEqual(TOOLS, EXPECTED);
  assert.deepEqual(
    [...TOOL_NAMES],
    [
      'sandbox_create',
      'sandbox_list',
      'sandbox_exec',
      'sandbox_destroy',
      'agent_run',
      'agent_output',
    ],
  );
  assert.ok(frozenThroughout(TOOLS));
  assert.ok(Object.isFrozen(TOOL_NAMES));
  assert.equal(MAX_OUTPUT_BYTES, 65_536);
  assert.equal(MAX_EXEC_TIMEOUT_MS, 240_000);
  assert.equal(MAX_AGENT_TIMEOUT_MS, 240_000);
  assert.deepEqual(TOOLS[4].inputSchema.properties.agent.enum, Object.keys(AGENTS));
  for (const tool of TOOLS) assert.ok(tool.description.length <= 160, tool.name);
});

test('the agent tools check their arguments before any request', () => {
  assert.deepEqual(problemsOf('agent_run', {}), ['agent is required', 'prompt is required']);
  assert.deepEqual(problemsOf('agent_run', { agent: 'gemini', prompt: '' }), [
    'agent must be one of claude,codex',
    'prompt must be 1..65536 characters',
  ]);
  assert.deepEqual(
    problemsOf('agent_run', {
      agent: 'claude',
      prompt: 'p',
      networkMode: 'open',
      secretRefs: ['OK', 'OK=ENV_NAME', '1BAD', 'A=b-c', ''],
      timeoutMs: 0,
    }),
    [
      'networkMode must be one of allowlist,egress,none',
      'secretRefs[2] must match ^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z_][A-Za-z0-9_]*)?$',
      'secretRefs[3] must match ^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z_][A-Za-z0-9_]*)?$',
      'secretRefs[4] must be 1..128 characters',
      'timeoutMs must be an integer in 1..240000',
    ],
  );
  assert.deepEqual(
    problemsOf('agent_run', { agent: 'codex', prompt: 'p', secretRefs: Array(9).fill('A') }),
    ['secretRefs must be an array of at most 8 items'],
  );
  assert.deepEqual(
    problemsOf('agent_run', { agent: 'codex', prompt: 'p', timeoutMs: 240_001, cwd: '/' }),
    ['timeoutMs must be an integer in 1..240000', 'cwd is not a parameter'],
  );
  assert.deepEqual(problemsOf('agent_output', { sandboxId: 's' }), ['sessionId is required']);
  assert.deepEqual(
    problemsOf('agent_output', { sandboxId: 's', sessionId: 'x', timeoutMs: 0 }),
    [],
  );
  assert.deepEqual(problemsOf('agent_output', { sandboxId: 's', sessionId: 'x', timeoutMs: -1 }), [
    'timeoutMs must be an integer in 0..240000',
  ]);
});

test('agentRunPlan: a new box and a headless session from the sdk recipes, with defaults', () => {
  const claude = agentRunPlan({ agent: 'claude', prompt: 'fix the bug' });
  assert.deepEqual(claude, {
    sandbox: agentSandboxInput('claude', { secretRefs: ['ANTHROPIC_API_KEY'] }),
    session: agentSessionParams('claude', {
      prompt: 'fix the bug',
      secretRefs: ['ANTHROPIC_API_KEY'],
    }),
    timeoutMs: 240_000,
  });
  assert.equal(claude.sandbox.rootfs, 'agents');
  assert.equal(claude.sandbox.profile.network.mode, 'allowlist');
  assert.ok(claude.sandbox.profile.network.allow.includes('@anthropic'));
  assert.equal(claude.session.cwd, '/workspace');
  assert.equal(claude.session.pty, false);
  assert.equal(claude.session.argv.at(-1), 'fix the bug');

  const codex = agentRunPlan({
    agent: 'codex',
    prompt: 'p',
    name: 'box',
    networkMode: 'allowlist',
    allow: ['example.com'],
    timeoutMs: 5000,
  });
  assert.deepEqual(codex.sandbox.secretRefs, ['OPENAI_API_KEY=CODEX_API_KEY']);
  assert.deepEqual(codex.session.secretRefs, ['OPENAI_API_KEY=CODEX_API_KEY']);
  assert.equal(codex.sandbox.name, 'box');
  assert.ok(codex.sandbox.profile.network.allow.includes('example.com'));
  assert.ok(codex.sandbox.profile.network.allow.includes('@openai'));
  assert.equal(codex.timeoutMs, 5000);

  const offline = agentRunPlan({
    agent: 'claude',
    prompt: 'p',
    networkMode: 'none',
    secretRefs: [],
  });
  assert.deepEqual(offline.sandbox.profile, { network: { mode: 'none' } });
  assert.deepEqual(offline.sandbox.secretRefs, []);
  assert.deepEqual(offline.session.secretRefs, []);

  const reuse = agentRunPlan({ agent: 'claude', prompt: 'p', sandboxId: 'sbx-1' });
  assert.equal(reuse.sandbox, null);
  assert.deepEqual(reuse.session.secretRefs, ['ANTHROPIC_API_KEY']);

  assert.throws(
    () =>
      agentRunPlan({
        agent: 'claude',
        prompt: 'p',
        sandboxId: 'sbx-1',
        name: 'n',
        networkMode: 'none',
      }),
    (e) =>
      e instanceof ToolCallError &&
      e.code === -32602 &&
      e.data.tool === 'agent_run' &&
      e.data.problems.join('|') ===
        'name applies to a new sandbox, not sandboxId|' +
          'networkMode applies to a new sandbox, not sandboxId',
  );
  assert.throws(
    () => agentRunPlan({ agent: 'claude', prompt: 'p', networkMode: 'egress', allow: ['x.io'] }),
    (e) => e instanceof ToolCallError && e.data.problems[0] === 'allow needs networkMode allowlist',
  );
});

test('OutputTail keeps the last 64 KiB on a character boundary and reports every cut', () => {
  const small = new OutputTail();
  assert.deepEqual(small.result(), { output: '', truncated: false });
  small.push(0, Buffer.from('out '));
  small.push(1, Buffer.from('and err\n'));
  assert.equal(small.lastSeq, 1);
  assert.deepEqual(small.result(), { output: 'out and err\n', truncated: false });

  const exact = new OutputTail();
  exact.push(0, Buffer.alloc(MAX_OUTPUT_BYTES, 'x'));
  assert.deepEqual(exact.result(), { output: 'x'.repeat(MAX_OUTPUT_BYTES), truncated: false });

  const wide = new OutputTail();
  wide.push(0, Buffer.from('head'));
  for (let i = 1; i <= 100; i++) wide.push(i, Buffer.from('é'.repeat(1000)));
  wide.push(101, Buffer.from('END'));
  const { output, truncated } = wide.result();
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(output) <= MAX_OUTPUT_BYTES);
  assert.ok(Buffer.byteLength(output) >= MAX_OUTPUT_BYTES - 1);
  assert.ok(output.endsWith(`${'é'.repeat(10)}END`));
  assert.match(output, /^é+END$/, 'the tail starts on a whole character');
  assert.equal(wide.lastSeq, 101);

  const odd = new OutputTail(8);
  odd.push(0, Buffer.from('aé€bcdefg'));
  assert.deepEqual(odd.result(), { output: 'bcdefg', truncated: true });

  const evicted = new OutputTail();
  evicted.push(7, Buffer.from('later'));
  assert.deepEqual(evicted.result(), { output: 'later', truncated: true });
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

test('the agent tools against a real server: unknown boxes are tool errors, refusals send nothing', async () => {
  const srv = await bootServer();
  const client = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.admin, retryDelayMs: 5 });
  try {
    const run = await callTool(client, 'agent_run', {
      agent: 'claude',
      prompt: 'p',
      sandboxId: 'sbx-none',
      secretRefs: [],
    });
    assert.equal(run.isError, true);
    assert.match(run.content[0].text, /^E_NOT_FOUND: /);
    const out = await callTool(client, 'agent_output', { sandboxId: 'sbx-none', sessionId: 's' });
    assert.equal(out.isError, true);
    assert.match(out.content[0].text, /^E_NOT_FOUND: /);
    await assert.rejects(
      callTool(client, 'agent_run', {
        agent: 'claude',
        prompt: 'p',
        sandboxId: 'sbx-none',
        networkMode: 'none',
      }),
      (e) =>
        e instanceof ToolCallError &&
        e.data.problems[0] === 'networkMode applies to a new sandbox, not sandboxId',
    );
    await assert.rejects(callTool(client, 'agent_run', { agent: 'codex' }), ToolCallError);
    assert.deepEqual(
      srv
        .auditEntries()
        .filter((e) => e.action.startsWith('api.'))
        .map((e) => [e.action, e.data.outcome]),
      [['api.session.start', 'E_NOT_FOUND']],
    );
  } finally {
    await srv.stop();
  }
});
