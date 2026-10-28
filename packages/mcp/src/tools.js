/**
 * The MCP tool surface: exactly `sandbox_create`, `sandbox_list`, `sandbox_exec`,
 * `sandbox_destroy` — and nothing else (req 6 ac_4). Every call goes through the SDK. Arguments
 * are checked against the tool's input schema before anything is sent; exec output is capped per
 * stream and every cut is reported in `truncated`, never silent.
 */

/** Maximum bytes of stdout, and of stderr, returned to the model by one exec. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** Longest exec deadline: under the 300 s response timeout of the `fetch` the SDK runs on. */
export const MAX_EXEC_TIMEOUT_MS = 240_000;

const SANDBOX_ID = { type: 'string', minLength: 1, maxLength: 128 };

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
