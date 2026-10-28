import fs from 'node:fs';
import { E } from '@workbox/core';
import { createAuth, createServer } from '@workbox/server';
import { parseOpts } from './commands.js';

/** Top-level keys a serve config file may hold. */
const SERVE_KEYS = new Set(['host', 'port', 'serverNames', 'keys']);

/** Full access for the single key WORKBOX_TOKEN defines. */
const ALL_SCOPES = Object.freeze(['admin', 'read', 'exec', 'answer']);

/**
 * Read a serve config file: `{"keys": [{id, tokenSha256|token, scopes}], "host"?, "port"?,
 * "serverNames"?}`. Unreadable JSON, unknown keys, wrong types and unusable keys fail closed.
 * @param {string} file
 * @returns {{host?: string, port?: number, serverNames: string[], keys: object[]}}
 */
export function loadServeConfig(file) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw E.invalid(`serve config ${file} is not readable JSON: ${e.message}`, { file });
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc))
    throw E.invalid(`serve config ${file} must contain a JSON object`, { file });
  const problems = Object.keys(doc)
    .filter((k) => !SERVE_KEYS.has(k))
    .map((k) => `unknown key ${k}`);
  if (doc.host !== undefined && (typeof doc.host !== 'string' || doc.host === ''))
    problems.push('host must be a non-empty string');
  if (doc.port !== undefined && !(Number.isInteger(doc.port) && doc.port >= 0 && doc.port <= 65535))
    problems.push('port must be an integer >= 0 and <= 65535');
  const names = doc.serverNames ?? [];
  if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || n === ''))
    problems.push('serverNames must be an array of host names');
  const keys = doc.keys ?? [];
  if (!Array.isArray(keys)) problems.push('keys must be an array of scoped keys');
  else
    try {
      createAuth({ keys });
    } catch (e) {
      problems.push(e.message);
    }
  if (problems.length)
    throw E.invalid(`invalid serve config ${file}: ${problems.join('; ')}`, { file, problems });
  return { host: doc.host, port: doc.port, serverNames: names, keys };
}

/** Keys from the environment: WORKBOX_TOKEN as one full-access key, else WORKBOX_API_KEYS. */
function envKeys(env) {
  if (env.WORKBOX_TOKEN) return [{ id: 'env', token: env.WORKBOX_TOKEN, scopes: ALL_SCOPES }];
  try {
    return env.WORKBOX_API_KEYS ? JSON.parse(env.WORKBOX_API_KEYS) : [];
  } catch {
    return [];
  }
}

/**
 * `workbox serve [--config file] [--port n] [--host h]`: the REST and WebSocket server over the
 * local engine until SIGTERM, SIGINT or `opts.signal` aborts, then a graceful close. Sandboxes are
 * detached from this process and keep running. The listen address comes from the flags, then
 * WORKBOX_PORT, then the config file, then 127.0.0.1:8790; the keys are the config file's plus
 * those from the environment.
 * @param {{engine: object, out: NodeJS.WritableStream}} ctx
 * @param {string[]} argv
 * @param {{env?: NodeJS.ProcessEnv, signal?: AbortSignal}} [opts]
 */
export async function serveCommand(ctx, argv, opts = {}) {
  if (!ctx.engine) throw E.invalid('workbox serve runs the local engine and takes no --server');
  const env = opts.env ?? process.env;
  const flags = parseOpts(argv, new Set(['config', 'port', 'host'])).opts;
  const file = flags.config ? loadServeConfig(flags.config) : { serverNames: [], keys: [] };
  const port = Number(flags.port ?? env.WORKBOX_PORT ?? file.port ?? 8790);
  const host = flags.host ?? file.host ?? '127.0.0.1';
  const app = createServer({
    manager: ctx.engine.manager,
    keys: [...file.keys, ...envKeys(env)],
    audit: ctx.engine.audit,
    serverNames: file.serverNames,
  });
  const addr = await app.listen(port, host);
  ctx.out.write(`workbox server listening on http://${addr.address}:${addr.port}\n`);
  await new Promise((resolve, reject) => {
    const stop = () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      opts.signal?.removeEventListener('abort', stop);
      app.close().then(resolve, reject);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener('abort', stop);
  });
}
