import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.js';

/**
 * A stdio MCP server (JSON-RPC 2.0, newline-delimited) exposing exactly the four sandbox tools.
 * Handles `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
 */

/** @param {object} msg parsed JSON-RPC message @param {object} client SDK client */
export async function handleMessage(msg, client) {
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return null;
  const id = msg.id ?? null;
  switch (msg.method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'workbox', version: '0.1.0-dev' },
      });
    case 'notifications/initialized':
      return null;
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      if (typeof name !== 'string') return fail(id, -32602, 'tools/call requires params.name');
      return ok(id, await callTool(client, name, args));
    }
    default:
      return id === null ? null : fail(id, -32601, `method not found: ${msg.method}`);
  }
}

function ok(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function fail(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Run the stdio loop.
 * @param {{client: object, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} opts
 */
export function runStdio(opts) {
  const rl = createInterface({ input: opts.input ?? process.stdin, crlfDelay: Infinity });
  const out = opts.output ?? process.stdout;
  let chain = Promise.resolve();
  rl.on('line', (line) => {
    chain = chain.then(async () => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        out.write(`${JSON.stringify(fail(null, -32700, 'parse error'))}\n`);
        return;
      }
      const reply = await handleMessage(msg, opts.client);
      if (reply) out.write(`${JSON.stringify(reply)}\n`);
    });
  });
  return rl;
}
