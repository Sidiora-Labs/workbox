import { createInterface } from 'node:readline';
import { TOOLS, ToolCallError, callTool } from './tools.js';

/**
 * A stdio MCP server (JSON-RPC 2.0, one message per line) exposing exactly the sandbox and agent
 * tools of TOOLS. Handles `initialize`, `ping`, `tools/list` and `tools/call`; notifications get no reply.
 */

/** Server version reported in `initialize`. */
export const VERSION = '0.1.0-dev';

/** MCP protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/** JSON-RPC error codes. */
export const ErrorCodes = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
});

/**
 * Answer one parsed JSON-RPC message.
 * @param {unknown} msg
 * @param {import('@workbox/sdk').WorkboxClient} client
 * @returns {Promise<object|null>} the response, or null for a notification or a response
 */
export async function handleMessage(msg, client) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg))
    return fail(null, ErrorCodes.INVALID_REQUEST, 'a message must be a JSON-RPC object');
  const id = msg.id ?? null;
  if (typeof msg.method !== 'string') {
    if ('result' in msg || 'error' in msg) return null;
    return fail(id, ErrorCodes.INVALID_REQUEST, 'a request needs a method');
  }
  if (msg.id === undefined) return null;
  try {
    return ok(id, await dispatch(msg.method, msg.params ?? {}, client));
  } catch (e) {
    if (e instanceof ToolCallError) return fail(id, e.code, e.message, e.data);
    if (e instanceof MethodNotFound) return fail(id, ErrorCodes.METHOD_NOT_FOUND, e.message);
    return fail(id, ErrorCodes.INTERNAL, e.message);
  }
}

class MethodNotFound extends Error {}

function dispatch(method, params, client) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'workbox', version: VERSION },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      if (typeof params.name !== 'string')
        throw new ToolCallError('tools/call requires params.name');
      return callTool(client, params.name, params.arguments);
    default:
      throw new MethodNotFound(`method not found: ${method}`);
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/**
 * Serve MCP over newline-delimited JSON-RPC. Requests are handled concurrently, so a long exec
 * does not hold up a `ping` or a `tools/list`; each reply is one line.
 * @param {{client: import('@workbox/sdk').WorkboxClient, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} opts
 * @returns {Promise<void>} resolves once the input has ended and every reply is written
 */
export function runStdio(opts) {
  const input = opts.input ?? process.stdin;
  const out = opts.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  const write = (reply) => {
    if (reply && out.writable !== false) out.write(`${JSON.stringify(reply)}\n`);
  };
  out.on?.('error', () => rl.close());
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      write(fail(null, ErrorCodes.PARSE, 'parse error'));
      return;
    }
    const job = handleMessage(msg, opts.client)
      .then(write)
      .catch((e) => process.stderr.write(`workbox-mcp: reply failed: ${e.message}\n`));
    pending.add(job);
    job.finally(() => pending.delete(job));
  });
  return new Promise((resolve) => {
    rl.once('close', () => {
      Promise.allSettled([...pending]).then(() => resolve());
    });
  });
}
