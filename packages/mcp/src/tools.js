/**
 * The MCP tool surface: exactly `sandbox_create`, `sandbox_list`, `sandbox_exec`,
 * `sandbox_destroy` — and nothing else (req 6.4).
 */

/** Frozen tool definitions (JSON Schema input). */
export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'sandbox_create',
    description: 'Create an isolated sandbox and wait until it is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        rootfs: { type: 'string' },
        networkMode: { type: 'string', enum: ['none', 'egress', 'allowlist'] },
      },
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'sandbox_list',
    description: 'List sandboxes with their state and health.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'sandbox_exec',
    description:
      'Run a shell command to completion inside a sandbox and return its bounded output.',
    inputSchema: {
      type: 'object',
      properties: {
        sandboxId: { type: 'string' },
        command: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 3600000 },
      },
      required: ['sandboxId', 'command'],
      additionalProperties: false,
    },
  }),
  Object.freeze({
    name: 'sandbox_destroy',
    description: 'Destroy a sandbox and delete its writable layer.',
    inputSchema: {
      type: 'object',
      properties: { sandboxId: { type: 'string' } },
      required: ['sandboxId'],
      additionalProperties: false,
    },
  }),
]);

/** Tool names in definition order. */
export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));

/** Maximum bytes of exec output returned to the model. */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/**
 * Execute one tool call against an SDK-shaped client.
 * @param {{createSandbox: Function, listSandboxes: Function, sandbox: Function}} client
 * @param {string} name @param {object} [args]
 * @returns {Promise<{content: {type: 'text', text: string}[], isError?: boolean}>}
 */
export async function callTool(client, name, args = {}) {
  try {
    switch (name) {
      case 'sandbox_create': {
        const profile = args.networkMode ? { network: { mode: args.networkMode } } : undefined;
        const sb = await client.createSandbox({ name: args.name, rootfs: args.rootfs, profile });
        return text(JSON.stringify({ id: sb.id, ...(sb.row ?? {}) }));
      }
      case 'sandbox_list': {
        const list = await client.listSandboxes({ limit: args.limit ?? 20 });
        return text(
          JSON.stringify(
            list.items?.map((s) => ({
              id: s.id,
              name: s.name,
              state: s.state,
              health: s.health,
            })) ?? list,
          ),
        );
      }
      case 'sandbox_exec': {
        const out = await client.sandbox(args.sandboxId).exec({
          argv: ['sh', '-lc', String(args.command ?? '')],
          timeoutMs: args.timeoutMs ?? 60_000,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        });
        return text(formatExec(out));
      }
      case 'sandbox_destroy': {
        const row = await client.sandbox(args.sandboxId).destroy();
        return text(JSON.stringify({ id: args.sandboxId, state: row?.state ?? 'DELETED' }));
      }
      default:
        return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true };
  }
}

/** @param {object} out exec result */
export function formatExec(out) {
  const stdout = String(out.stdout ?? '').slice(0, MAX_OUTPUT_BYTES);
  const stderr = String(out.stderr ?? '').slice(0, MAX_OUTPUT_BYTES);
  return JSON.stringify({
    exitCode: out.exitCode ?? null,
    signal: out.signal ?? null,
    timedOut: Boolean(out.timedOut),
    truncated: out.truncated ?? { stdout: false, stderr: false },
    stdout,
    stderr,
  });
}

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}
