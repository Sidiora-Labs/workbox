import { AGENTS, agentSandboxInput, agentSessionParams } from '@workbox/sdk';

/**
 * The MCP tool surface: `sandbox_create`, `sandbox_list`, `sandbox_exec`, `sandbox_destroy`, and
 * `agent_run` / `agent_output`, which hand a task to Claude Code or Codex inside a sandbox. Every
 * call goes through the SDK. Arguments are checked against the tool's input schema before
 * anything is sent; output is capped and every cut is reported in `truncated`, never silent.
 */

/** Maximum bytes of stdout, and of stderr, returned to the model by one exec. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Longest exec deadline: under the 300 s response timeout of the `fetch` the SDK runs on. */
export const MAX_EXEC_TIMEOUT_MS = 240_000;

/** Longest wait of `agent_run` and `agent_output`, and the default of `agent_run`. */
export const MAX_AGENT_TIMEOUT_MS = MAX_EXEC_TIMEOUT_MS;

/** Grace past an `agent_output` deadline for the replay to reach output that already existed. */
const CATCH_UP_MS = 10_000;

const SANDBOX_ID = { type: 'string', minLength: 1, maxLength: 128 };
const ALLOW = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: 253 },
  maxItems: 64,
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** Frozen tool definitions (JSON Schema input), in the order `tools/list` returns them. */
export const TOOLS = deepFreeze([
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
        sandboxId: SANDBOX_ID,
        command: { type: 'string', minLength: 1, maxLength: 65_536 },
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_EXEC_TIMEOUT_MS },
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
      properties: { sandboxId: SANDBOX_ID },
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
        agent: { type: 'string', enum: Object.keys(AGENTS) },
        prompt: { type: 'string', minLength: 1, maxLength: 65_536 },
        sandboxId: SANDBOX_ID,
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
        timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_AGENT_TIMEOUT_MS },
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
        sandboxId: SANDBOX_ID,
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
        timeoutMs: { type: 'integer', minimum: 0, maximum: MAX_AGENT_TIMEOUT_MS },
      },
      required: ['sandboxId', 'sessionId'],
      additionalProperties: false,
    },
  },
]);

/** Tool names in definition order. */
export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));

/**
 * A `tools/call` refused before it runs: an unknown tool or arguments outside its input schema.
 * The server answers it with JSON-RPC error `code` (-32602, invalid params) and `data`.
 */
export class ToolCallError extends Error {
  /** @param {string} message @param {object} [data] */
  constructor(message, data) {
    super(message);
    this.name = 'ToolCallError';
    this.code = -32602;
    this.data = data;
  }
}

/**
 * Check a call against its tool's input schema.
 * @param {string} name @param {unknown} [args] omitted arguments are `{}`
 * @returns {Record<string, any>} the arguments
 * @throws {ToolCallError}
 */
export function checkArguments(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new ToolCallError(`unknown tool: ${name}`, { tool: name, tools: TOOL_NAMES });
  const value = args ?? {};
  if (typeof value !== 'object' || Array.isArray(value))
    throw new ToolCallError(`${name}: arguments must be an object`, { tool: name });
  const schema = tool.inputSchema;
  const problems = [];
  for (const key of schema.required ?? [])
    if (value[key] === undefined) problems.push(`${key} is required`);
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(schema.properties, key)) problems.push(`${key} is not a parameter`);
    else problems.push(...checkValue(key, schema.properties[key], item));
  }
  if (problems.length)
    throw new ToolCallError(`${name}: invalid arguments: ${problems.join('; ')}`, {
      tool: name,
      problems,
    });
  return value;
}

function checkValue(key, prop, item) {
  if (prop.type === 'integer') {
    if (Number.isInteger(item) && item >= prop.minimum && item <= prop.maximum) return [];
    return [`${key} must be an integer in ${prop.minimum}..${prop.maximum}`];
  }
  if (prop.type === 'array') {
    if (!Array.isArray(item) || item.length > prop.maxItems)
      return [`${key} must be an array of at most ${prop.maxItems} items`];
    return item.flatMap((entry, i) => checkValue(`${key}[${i}]`, prop.items, entry));
  }
  if (typeof item !== 'string') return [`${key} must be a string`];
  if (item.length < prop.minLength || item.length > prop.maxLength)
    return [`${key} must be ${prop.minLength}..${prop.maxLength} characters`];
  if (prop.enum && !prop.enum.includes(item)) return [`${key} must be one of ${prop.enum}`];
  if (prop.pattern && !new RegExp(prop.pattern).test(item))
    return [`${key} must match ${prop.pattern}`];
  return [];
}

function summary(row) {
  return { id: row.id, name: row.name, state: row.state, health: row.health, rootfs: row.rootfs };
}

function createInput(args) {
  if (args.allow && args.networkMode !== 'allowlist')
    throw new ToolCallError('sandbox_create: allow needs networkMode allowlist', {
      tool: 'sandbox_create',
      problems: ['allow needs networkMode allowlist'],
    });
  const network = args.networkMode && { mode: args.networkMode, allow: args.allow };
  return { name: args.name, rootfs: args.rootfs, profile: network ? { network } : undefined };
}

/**
 * What an `agent_run` call does, worked out before any request: the `createSandbox` input (null
 * when it reuses `sandboxId`), the headless session params and the wait. `secretRefs` defaults to
 * the agent's preferred credential and applies to both the new box's policy and the session.
 * @param {Record<string, any>} args checked `agent_run` arguments
 * @returns {{sandbox: object|null, session: object, timeoutMs: number}}
 * @throws {ToolCallError} for options that do not fit together
 */
export function agentRunPlan(args) {
  const problems = [];
  if (args.sandboxId !== undefined)
    for (const key of ['name', 'networkMode', 'allow'])
      if (args[key] !== undefined) problems.push(`${key} applies to a new sandbox, not sandboxId`);
  if (args.allow && (args.networkMode ?? 'allowlist') !== 'allowlist')
    problems.push('allow needs networkMode allowlist');
  if (problems.length)
    throw new ToolCallError(`agent_run: invalid arguments: ${problems.join('; ')}`, {
      tool: 'agent_run',
      problems,
    });
  const { ref, env } = AGENTS[args.agent].credentials[0];
  const secretRefs = args.secretRefs ?? [ref === env ? ref : `${ref}=${env}`];
  const sandbox =
    args.sandboxId === undefined
      ? agentSandboxInput(args.agent, {
          name: args.name,
          network: args.networkMode,
          allow: args.allow,
          secretRefs,
        })
      : null;
  return {
    sandbox,
    session: agentSessionParams(args.agent, { prompt: args.prompt, secretRefs }),
    timeoutMs: args.timeoutMs ?? MAX_AGENT_TIMEOUT_MS,
  };
}

const MISSING_SECRET = /secret (\S+) is not configured on the host|no secret provider configured/;

/** A session start refused for a host secret that is not there, said so with the way out. */
function missingSecret(e, agent, secretRefs) {
  const m = MISSING_SECRET.exec(e?.message ?? '');
  if (!m) return e;
  const refs = m[1] ? [m[1]] : secretRefs.map((r) => r.split('=')[0]);
  const what = refs.length > 1 ? `secrets ${refs.join(', ')} are` : `secret ${refs[0]} is`;
  const message =
    `${what} not configured on the Workbox host: add it to the host's secrets, or run ` +
    `agent_run with secretRefs [] and sign in inside the box with \`${AGENTS[agent].signIn}\``;
  return Object.assign(new Error(message), { code: e.code });
}

/**
 * The last MAX_OUTPUT_BYTES of a session's combined stdout and stderr, gathered chunk by chunk
 * without holding more than twice that. `truncated` is set by any cut here and by a replay that
 * did not start at the session's first chunk.
 */
export class OutputTail {
  #chunks = [];
  #bytes = 0;
  #cut = false;

  /** @param {number} [max] */
  constructor(max = MAX_OUTPUT_BYTES) {
    this.max = max;
    /** Sequence number of the last chunk, -1 before any. */
    this.lastSeq = -1;
  }

  /** @param {number} seq @param {Buffer} data */
  push(seq, data) {
    if (this.lastSeq < 0 && seq > 0) this.#cut = true;
    this.lastSeq = seq;
    this.#chunks.push(data);
    this.#bytes += data.length;
    if (this.#bytes > 2 * this.max) this.#compact();
  }

  #compact() {
    const all = Buffer.concat(this.#chunks);
    let start = Math.max(0, all.length - this.max);
    if (start > 0) this.#cut = true;
    while (start > 0 && start < all.length && (all[start] & 0xc0) === 0x80) start++;
    this.#chunks = [all.subarray(start)];
    this.#bytes = this.#chunks[0].length;
  }

  /** @returns {{output: string, truncated: boolean}} the tail, cut on a character boundary */
  result() {
    this.#compact();
    return { output: this.#chunks[0].toString('utf8'), truncated: this.#cut };
  }
}

/**
 * Follow a session from its first byte until it exits or `timeoutMs` passes; the session keeps
 * running either way. `seen` is the session as listed when the call began: past the deadline the
 * replay still runs up to the chunk it had reached (at most CATCH_UP_MS longer), so a 0 ms read
 * returns everything that already existed, and an exited session is read to its exit.
 * @returns {Promise<{exit: {code: number|null, signal: string|null}|null, output: string, truncated: boolean}>}
 */
async function follow(box, sessionId, timeoutMs, seen = { seq: 0, exited: false }) {
  const stream = box.attach(sessionId);
  const tail = new OutputTail();
  let exit = null;
  let due = false;
  const caughtUp = () => !seen.exited && tail.lastSeq >= seen.seq - 1;
  const timer = setTimeout(() => {
    due = true;
    if (caughtUp()) stream.close();
  }, timeoutMs);
  const cap = setTimeout(() => stream.close(), timeoutMs + CATCH_UP_MS);
  try {
    for await (const evt of stream) {
      if (evt.type === 'session.exit') exit = evt.params;
      else if (evt.type === 'session.output') {
        tail.push(evt.params.seq, Buffer.from(evt.params.data, 'base64'));
        if (due && caughtUp()) stream.close();
      }
    }
  } finally {
    clearTimeout(timer);
    clearTimeout(cap);
  }
  return { exit, ...tail.result() };
}

function agentResult(sandboxId, sessionId, { exit, output, truncated }) {
  return {
    sandboxId,
    sessionId,
    running: !exit,
    ...(exit ? { exitCode: exit.code, signal: exit.signal } : {}),
    output,
    truncated,
  };
}

const RUN = {
  async sandbox_create(client, args) {
    const sb = await client.createSandbox(createInput(args));
    return summary(sb.row);
  },
  async sandbox_list(client, args) {
    const page = await client.listSandboxes({ limit: args.limit ?? 20, cursor: args.cursor });
    return { sandboxes: page.items.map(summary), cursor: page.cursor, complete: page.complete };
  },
  async sandbox_exec(client, args) {
    const out = await client.sandbox(args.sandboxId).exec({
      argv: ['sh', '-c', args.command],
      timeoutMs: args.timeoutMs ?? 60_000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    return formatExec(out);
  },
  async sandbox_destroy(client, args) {
    const row = await client.sandbox(args.sandboxId).destroy();
    return { id: row.id, state: row.state };
  },
  async agent_run(client, args) {
    const plan = agentRunPlan(args);
    const box = plan.sandbox
      ? await client.createSandbox(plan.sandbox)
      : client.sandbox(args.sandboxId);
    let sessionId;
    try {
      ({ sessionId } = await box.startSession(plan.session));
    } catch (e) {
      if (plan.sandbox) await box.destroy().catch(() => undefined);
      throw missingSecret(e, args.agent, plan.session.secretRefs);
    }
    try {
      return agentResult(box.id, sessionId, await follow(box, sessionId, plan.timeoutMs));
    } catch (e) {
      const message = `session ${sessionId} in sandbox ${box.id} started, but reading it failed: ${e.message}`;
      throw Object.assign(new Error(message), { code: e.code });
    }
  },
  async agent_output(client, args) {
    const box = client.sandbox(args.sandboxId);
    const { sessions } = await box.listSessions();
    const s = sessions.find((row) => row.sessionId === args.sessionId);
    if (!s)
      throw Object.assign(
        new Error(`session ${args.sessionId} not found in sandbox ${args.sandboxId}`),
        { code: 'E_NOT_FOUND' },
      );
    const seen = { seq: s.seq ?? 0, exited: Boolean(s.exited) };
    const followed = await follow(box, args.sessionId, args.timeoutMs ?? 0, seen);
    return agentResult(args.sandboxId, args.sessionId, followed);
  },
};

/**
 * Run one tool call through the SDK. A failure of the call itself (an API error, a lost server)
 * comes back as a result with `isError`, so the model sees it; a call that does not fit the tool
 * list or a schema rejects with a ToolCallError instead.
 * @param {import('@workbox/sdk').WorkboxClient} client
 * @param {string} name @param {unknown} [args]
 * @returns {Promise<{content: {type: 'text', text: string}[], isError?: boolean}>}
 */
export async function callTool(client, name, args) {
  const checked = checkArguments(name, args);
  let result;
  try {
    result = await RUN[name](client, checked);
  } catch (e) {
    if (e instanceof ToolCallError) throw e;
    const text = e.code ? `${e.code}: ${e.message}` : `error: ${e.message}`;
    return { content: [{ type: 'text', text }], isError: true };
  }
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function capBytes(value, max) {
  const buf = Buffer.from(String(value ?? ''), 'utf8');
  if (buf.length <= max) return { text: buf.toString('utf8'), cut: false };
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { text: buf.subarray(0, end).toString('utf8'), cut: true };
}

/**
 * The model-facing view of an exec result: each stream at most MAX_OUTPUT_BYTES of UTF-8, cut on
 * a character boundary. `truncated` holds every cut, the server's and this one, and `notice`
 * spells it out whenever anything was cut.
 * @param {{exitCode?: number|null, signal?: string|null, timedOut?: boolean, durationMs?: number, truncated?: {stdout?: boolean, stderr?: boolean}, stdout?: string, stderr?: string}} out
 */
export function formatExec(out) {
  const stdout = capBytes(out.stdout, MAX_OUTPUT_BYTES);
  const stderr = capBytes(out.stderr, MAX_OUTPUT_BYTES);
  const truncated = {
    stdout: stdout.cut || Boolean(out.truncated?.stdout),
    stderr: stderr.cut || Boolean(out.truncated?.stderr),
  };
  const cut = ['stdout', 'stderr'].filter((s) => truncated[s]);
  return {
    exitCode: out.exitCode ?? null,
    signal: out.signal ?? null,
    timedOut: Boolean(out.timedOut),
    durationMs: out.durationMs ?? null,
    truncated,
    ...(cut.length
      ? { notice: `${cut.join(' and ')} truncated to ${MAX_OUTPUT_BYTES} bytes` }
      : {}),
    stdout: stdout.text,
    stderr: stderr.text,
  };
}
