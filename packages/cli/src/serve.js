import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { E, WebhookDispatcher } from '@workbox/core';
import { createAuth, createServer } from '@workbox/server';
import { parseOpts } from './commands.js';

/** Top-level keys a serve config file may hold. */
const SERVE_KEYS = new Set(['host', 'port', 'serverNames', 'keys', 'tls']);

/** Keys of the serve config file's `tls` object. */
const TLS_KEYS = new Set(['certFile', 'keyFile']);

/** Full access for the single key WORKBOX_TOKEN defines. */
const ALL_SCOPES = Object.freeze(['admin', 'read', 'exec', 'answer']);

/**
 * Read a serve config file: `{"keys": [{id, tokenSha256|token, scopes}], "host"?, "port"?,
 * "serverNames"?, "tls"?: {certFile, keyFile}}`. Unreadable JSON, unknown keys, wrong types and
 * unusable keys fail closed. Relative TLS file paths are resolved against the config file's
 * directory.
 * @param {string} file
 * @returns {{host?: string, port?: number, serverNames: string[], keys: object[], tls?: {certFile: string, keyFile: string}}}
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
  const tlsPart = tlsEntry(doc.tls, path.dirname(file), problems);
  if (problems.length)
    throw E.invalid(`invalid serve config ${file}: ${problems.join('; ')}`, { file, problems });
  return { host: doc.host, port: doc.port, serverNames: names, keys, ...tlsPart };
}

/** `{tls}` with the file paths resolved against `dir`, or `{}` when absent or invalid. */
function tlsEntry(tls, dir, problems) {
  if (tls === undefined) return {};
  if (tls === null || typeof tls !== 'object' || Array.isArray(tls)) {
    problems.push('tls must be an object with certFile and keyFile');
    return {};
  }
  const before = problems.length;
  for (const k of Object.keys(tls)) if (!TLS_KEYS.has(k)) problems.push(`unknown key tls.${k}`);
  for (const k of TLS_KEYS)
    if (typeof tls[k] !== 'string' || tls[k] === '')
      problems.push(`tls.${k} must be a non-empty path`);
  if (problems.length > before) return {};
  const files = {
    certFile: path.resolve(dir, tls.certFile),
    keyFile: path.resolve(dir, tls.keyFile),
  };
  return { tls: files };
}

/** The PEM certificate chain and key a TLS server presents. */
function readTlsFiles(files) {
  const read = (what, file) => {
    try {
      return fs.readFileSync(file);
    } catch (e) {
      throw E.invalid(`cannot read the TLS ${what} ${file}: ${e.message}`, { file });
    }
  };
  return { cert: read('certificate', files.certFile), key: read('key', files.keyFile) };
}

/** True for an address only this host can reach. @param {string} address */
function isLoopback(address) {
  const v4 = address.replace(/^::ffff:/i, '');
  if (net.isIPv4(v4)) return v4.startsWith('127.');
  return address === '::1';
}

/** The certificate and key files from the flags, else the config file; both or neither. */
function tlsFilesOf(flags, file) {
  const certFile = flags['tls-cert'] ?? file.tls?.certFile;
  const keyFile = flags['tls-key'] ?? file.tls?.keyFile;
  if (certFile === undefined && keyFile === undefined) return null;
  if (typeof certFile !== 'string' || typeof keyFile !== 'string')
    throw E.invalid('TLS needs both a certificate (--tls-cert) and a key (--tls-key)');
  return { certFile, keyFile };
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
 * `workbox serve [--config file] [--port n] [--host h] [--tls-cert f --tls-key f]`: the REST and
 * WebSocket server over the local engine until SIGTERM, SIGINT or `opts.signal` aborts, then a
 * graceful close. Sandboxes are detached from this process and keep running. The listen address
 * comes from the flags, then WORKBOX_PORT, then the config file, then 127.0.0.1:8790; the keys
 * are the config file's plus those from the environment, and the stored keys of the engine's
 * store (`workbox key`). With a certificate and key (flags first, then the config file's `tls`)
 * it serves HTTPS and WSS, and SIGHUP re-reads both files; a reload that fails keeps the old
 * certificate. Listening beyond loopback without TLS warns on stderr. Webhook deliveries run
 * while it serves: the dispatcher follows the engine config's `webhooks`, wakes on every event
 * the Manager logs, starts once the server listens and stops after the server has closed.
 * @param {{engine: object, out: NodeJS.WritableStream, err?: NodeJS.WritableStream}} ctx
 * @param {string[]} argv
 * @param {{env?: NodeJS.ProcessEnv, signal?: AbortSignal}} [opts]
 */
export async function serveCommand(ctx, argv, opts = {}) {
  if (!ctx.engine) throw E.invalid('workbox serve runs the local engine and takes no --server');
  const env = opts.env ?? process.env;
  const err = ctx.err ?? process.stderr;
  const flags = parseOpts(argv, new Set(['config', 'port', 'host', 'tls-cert', 'tls-key'])).opts;
  const file = flags.config ? loadServeConfig(flags.config) : { serverNames: [], keys: [] };
  const port = Number(flags.port ?? env.WORKBOX_PORT ?? file.port ?? 8790);
  const host = flags.host ?? file.host ?? '127.0.0.1';
  const tlsFiles = tlsFilesOf(flags, file);
  const manager = ctx.engine.manager;
  const webhooks = new WebhookDispatcher({
    store: ctx.engine.store,
    config: ctx.engine.config?.webhooks,
    logger: ctx.engine.logger,
  });
  const app = createServer({
    manager,
    auth: createAuth({ keys: [...file.keys, ...envKeys(env)], store: ctx.engine.store }),
    audit: ctx.engine.audit,
    serverNames: file.serverNames,
    webhooks,
    ...(tlsFiles ? { tls: readTlsFiles(tlsFiles) } : {}),
  });
  const onLogged = () => webhooks.notify();
  const addr = await app.listen(port, host);
  manager.on('logged', onLogged);
  webhooks.start();
  const scheme = tlsFiles ? 'https' : 'http';
  ctx.out.write(`workbox server listening on ${scheme}://${addr.address}:${addr.port}\n`);
  if (!tlsFiles && !isLoopback(addr.address))
    err.write(
      `workbox serve: warning: listening on ${addr.address} without TLS; tokens and data cross the network in clear text (use --tls-cert and --tls-key, or a TLS proxy)\n`,
    );
  const reload = () => {
    try {
      app.reloadTls(readTlsFiles(tlsFiles));
      ctx.out.write('workbox server reloaded its TLS certificate\n');
    } catch (e) {
      err.write(`workbox serve: TLS reload failed, keeping the old certificate: ${e.message}\n`);
    }
  };
  await new Promise((resolve, reject) => {
    const stop = () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      process.off('SIGHUP', reload);
      opts.signal?.removeEventListener('abort', stop);
      app
        .close()
        .then(() => webhooks.stop())
        .finally(() => manager.off('logged', onLogged))
        .then(resolve, reject);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    if (tlsFiles) process.on('SIGHUP', reload);
    if (opts.signal?.aborted) stop();
    else opts.signal?.addEventListener('abort', stop);
  });
}
