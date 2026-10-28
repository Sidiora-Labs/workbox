import http from 'node:http';
import net from 'node:net';
import { E } from '../errors.js';

/**
 * The host forward proxy (req 5.2): HTTP CONNECT + absolute-URI, with a per-sandbox host
 * allowlist keyed by source address (the sandbox's slirp address). Denials answer 403 and are
 * audited through the `onDeny` callback. Egress mode uses `allowAll`.
 */

const HOST_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** Normalise an allowlist entry: hostname or `*.hostname`, lower-cased. @param {string} entry */
export function normalizeAllowEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > 253)
    throw E.invalid(`invalid allowlist entry ${String(entry)}`);
  const lower = entry.toLowerCase();
  const host = lower.startsWith('*.') ? lower.slice(2) : lower;
  if (!HOST_RE.test(host)) throw E.invalid(`invalid allowlist entry ${entry}`);
  return lower;
}

/** @param {string} host @param {string[]} allow */
export function hostAllowed(host, allow) {
  const h = String(host).toLowerCase();
  return allow.some((entry) =>
    entry.startsWith('*.') ? h === entry.slice(2) || h.endsWith(entry.slice(1)) : h === entry,
  );
}

/** Parse `host:port` (default port 443 for CONNECT). @param {string} target @param {number} [defPort] */
export function parseTarget(target, defPort = 443) {
  if (typeof target !== 'string' || target.length === 0) throw E.invalid('empty proxy target');
  const idx = target.lastIndexOf(':');
  const host = idx === -1 ? target : target.slice(0, idx);
  const port = idx === -1 ? defPort : Number(target.slice(idx + 1));
  if (!HOST_RE.test(host) && !net.isIP(host)) throw E.invalid(`invalid proxy host ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw E.invalid(`invalid proxy port in ${target}`);
  return { host, port };
}

/**
 * @param {{allowFor?: (sourceIp: string) => string[]|null, allowAll?: boolean, onDeny?: (info: object) => void, timeoutMs?: number}} [opts]
 * `allowFor` returns the allowlist for a source, or null when the source is unknown (deny).
 */
export function createProxy(opts = {}) {
  const allowFor = opts.allowFor ?? (() => []);
  const onDeny = opts.onDeny ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 30_000;

  function allowed(req, host) {
    if (opts.allowAll) return true;
    const src = req.socket.remoteAddress ?? '';
    const list = allowFor(src);
    if (!Array.isArray(list)) return false;
    return hostAllowed(host, list.map(normalizeAllowEntry));
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url);
      if (url.protocol !== 'http:') throw new Error('only http: absolute URIs');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('proxy requires an absolute http URI\n');
      return;
    }
    if (!allowed(req, url.hostname)) {
      onDeny({ host: url.hostname, source: req.socket.remoteAddress, method: req.method });
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('denied by workbox proxy policy\n');
      return;
    }
    const upstream = http.request(
      {
        host: url.hostname,
        port: Number(url.port || 80),
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers: { ...req.headers, host: url.host },
        timeout: timeoutMs,
        // A forward proxy connects directly; never chain through an ambient env proxy.
        agent: false,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    let t;
    try {
      t = parseTarget(req.url);
    } catch {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (!allowed(req, t.host)) {
      onDeny({ host: t.host, source: req.socket?.remoteAddress, method: 'CONNECT' });
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(t.port, t.host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.setTimeout(timeoutMs, () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return server;
}
