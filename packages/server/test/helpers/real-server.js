import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { createLogger } from '@workbox/core';
import { Manager } from '../../../core/src/sandbox/manager.js';
import { testEngine } from '../../../core/test/helpers/engine.js';
import { createServer } from '../../src/server.js';

// Localhost test traffic must never go through an ambient HTTP(S) proxy.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])
  delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

/** One bearer token per scope, plus the configured keys that carry them. */
export const TOKENS = Object.freeze({
  admin: 'admin-token',
  read: 'read-token',
  exec: 'exec-token',
  answer: 'answer-token',
});

export const KEYS = Object.freeze([
  { id: 'root', token: TOKENS.admin, scopes: ['admin'] },
  { id: 'observer', token: TOKENS.read, scopes: ['read'] },
  { id: 'harness', token: TOKENS.exec, scopes: ['exec', 'read'] },
  { id: 'human', token: TOKENS.answer, scopes: ['answer', 'read'] },
]);

/**
 * A real engine (store, audit, cgroups, rootfs, runtime), a real Manager over it and the server
 * listening on an ephemeral 127.0.0.1 port. Network setup is off: these tests are not about it.
 * @param {{server?: object}} [opts] extra createServer deps
 */
export async function bootServer(opts = {}) {
  const eng = await testEngine();
  const manager = new Manager({
    config: eng.config,
    store: eng.store,
    audit: eng.audit,
    cgroups: eng.cgroups,
    rootfs: eng.rootfs,
    runtime: eng.runtime,
    logger: eng.logger,
    enableNetwork: false,
  });
  const logs = [];
  const logger = createLogger({
    component: 'server',
    stream: { write: (line) => logs.push(JSON.parse(line)) },
  });
  const app = createServer({ manager, keys: KEYS, audit: eng.audit, logger, ...opts.server });
  const ids = new Set();
  manager.on('sandbox', (row) => ids.add(row.id));
  let port;
  try {
    ({ port } = await app.listen(0));
  } catch (e) {
    await eng.cleanup();
    throw e;
  }
  return {
    eng,
    manager,
    app,
    logs,
    port,
    base: `${opts.server?.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    auditEntries: () => auditEntries(eng.config.paths.audit),
    async stop() {
      await app.close({ timeoutMs: 2000 });
      for (const id of ids) await manager.destroy(id).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    },
  };
}

/** Every audit entry under dir, in order. @param {string} dir */
export function auditEntries(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l));
}

/**
 * One HTTP request over node:http with full control of the headers (Host included); over
 * node:https, trusting only `ca`, when `ca` is given. `peer` is the SHA-256 fingerprint of the
 * certificate the server presented.
 * @param {number} port
 * @param {{method?: string, path: string, token?: string, body?: unknown, raw?: string|Buffer, headers?: Record<string, string>, ca?: (string|Buffer)[]}} req
 * @returns {Promise<{status: number, headers: object, text: string, json: any, peer: string|null}>}
 */
export function call(port, req) {
  const payload =
    req.raw ?? (req.body === undefined ? undefined : Buffer.from(JSON.stringify(req.body)));
  const headers = { host: `127.0.0.1:${port}`, ...req.headers };
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  return new Promise((resolve, reject) => {
    const r = (req.ca ? https : http).request(
      {
        host: '127.0.0.1',
        port,
        method: req.method ?? 'GET',
        path: req.path,
        headers,
        agent: false,
        ...(req.ca ? { ca: req.ca } : {}),
      },
      (res) => {
        const peer = res.socket.getPeerCertificate?.().fingerprint256 ?? null;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON (metrics)
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json, peer });
        });
      },
    );
    r.on('error', reject);
    r.end(payload);
  });
}

/**
 * Send a raw WebSocket upgrade request and return the status line of the answer.
 * @param {number} port @param {string} target @param {Record<string, string>} [headers]
 */
export function rawUpgrade(port, target, headers = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let got = '';
    sock.on('data', (d) => {
      got += d;
      if (got.includes('\r\n')) {
        sock.destroy();
        resolve(got.split('\r\n')[0]);
      }
    });
    sock.on('error', reject);
    const lines = [
      `GET ${target} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, val]) => `${k}: ${val}`),
    ];
    sock.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
}
