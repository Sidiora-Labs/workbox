import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createAuth } from './auth.js';
import { Metrics } from './metrics.js';

/**
 * REST + WebSocket harness surface (task 3.1), built on node:http (no framework dependency;
 * the route/validation behaviour is the spec contract). Every route returns the envelope
 * `{error:{code,message,details?,requestId}}` on failure; mutations audit-log and count metrics.
 *
 * The `manager` dependency is the core Manager (or any object with the same methods).
 */

/** Maximum accepted request body. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * @param {{manager: object, auth?: object, keys?: object[], audit?: object, log?: (obj: object) => void, ready?: () => boolean}} deps
 */
export function createServer(deps) {
  const manager = deps.manager;
  const auth = deps.auth ?? createAuth({ keys: deps.keys ?? [] });
  const audit = deps.audit ?? null;
  const log = deps.log ?? (() => {});
  const metrics = new Metrics()
    .describe('workbox_http_requests_total', 'HTTP requests by route and status')
    .describe('workbox_sandboxes', 'Sandboxes by state');
  let shuttingDown = false;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      sendError(req, res, e);
    });
  });
  server.on('upgrade', (req, socket, head) =>
    upgrade(req, socket, head).catch(() => socket.destroy()),
  );

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://workbox');
    const requestId = req.headers['x-request-id'] ?? randomUUID();
    req.requestId = requestId;
    req.res = res;
    res.setHeader('x-request-id', requestId);
    try {
      const out = await route(req, url);
      if (out === undefined) return;
      metrics.inc('workbox_http_requests_total', { route: url.pathname, status: '2xx' });
      log({ requestId, method: req.method, path: url.pathname, ms: Date.now() - started });
      sendJson(res, out.status ?? 200, out.body);
    } catch (e) {
      metrics.inc('workbox_http_requests_total', { route: url.pathname, status: 'error' });
      sendError(req, res, e);
    }
  }

  function needScope(req, scope) {
    const principal = auth.authenticate(req.headers.authorization);
    if (!principal) throw httpError(401, 'E_DENIED', 'missing or invalid bearer token');
    if (!auth.authorize(principal, scope))
      throw httpError(403, 'E_DENIED', `scope ${scope} required`);
    req.principal = principal;
    return principal;
  }

  function audited(req, action, data) {
    audit?.append?.({ actor: req.principal?.id ?? 'api', action, data });
  }

  async function route(req, url) {
    const p = url.pathname;
    const m = req.method ?? 'GET';
    if (p === '/healthz') return { body: { ok: true } };
    if (p === '/readyz') {
      const ready = !shuttingDown && (deps.ready ? deps.ready() : true);
      if (!ready) throw httpError(503, 'E_UNAVAILABLE', 'not ready');
      return { body: { ready: true } };
    }
    if (p === '/metrics') {
      needScope(req, 'read');
      refreshGauges();
      return sendText(req, metrics.render());
    }
    const sb = /^\/v1\/sandboxes(?:\/([^/]+))?(\/.*)?$/.exec(p);
    if (sb) return sandboxRoute(req, url, m, sb[1], sb[2] ?? '');
    if (p === '/v1/reconcile' && m === 'POST') {
      needScope(req, 'admin');
      const out = await manager.reconcile();
      audited(req, 'reconcile', out);
      return { body: out };
    }
    if (p === '/v1/asks' && m === 'GET') {
      needScope(req, 'read');
      return {
        body: {
          asks: manager.store.listAsks({
            status: url.searchParams.get('status') ?? 'all',
            limit: num(url, 'limit'),
          }),
        },
      };
    }
    const askAnswer = /^\/v1\/asks\/([^/]+)\/answer$/.exec(p);
    if (askAnswer && m === 'POST') {
      needScope(req, 'answer');
      const body = await readJson(req);
      requireFields(body, ['answer']);
      const answered = manager.answerAsk(askAnswer[1], {
        answer: body.answer,
        by: req.principal.id,
      });
      audited(req, 'ask.answer', { askId: askAnswer[1] });
      return { body: answered };
    }
    throw httpError(404, 'E_NOT_FOUND', `no route ${m} ${p}`);
  }

  async function sandboxCollection(req, url, m) {
    if (m === 'POST') {
      needScope(req, 'admin');
      const body = await readJson(req);
      const row = await manager.create(body ?? {});
      audited(req, 'sandbox.create', { sandboxId: row.id });
      return { status: 201, body: row };
    }
    if (m === 'GET') {
      needScope(req, 'read');
      return {
        body: manager.list({
          cursor: url.searchParams.get('cursor') ?? undefined,
          limit: num(url, 'limit'),
          includeDeleted: url.searchParams.get('includeDeleted') === '1',
        }),
      };
    }
    throw httpError(405, 'E_INVALID_PARAMS', `method ${m} not allowed here`);
  }

  async function sandboxItem(req, url, m, id, tail) {
    const key = `${m} ${tail}`;
    const routes = {
      'GET ': async () => {
        needScope(req, 'read');
        return { body: manager.inspect(id) };
      },
      'DELETE ': async () => {
        needScope(req, 'admin');
        const row = await manager.destroy(id);
        audited(req, 'sandbox.destroy', { sandboxId: id });
        return { body: row };
      },
      'POST /drain': async () => {
        needScope(req, 'admin');
        const body = await readJson(req).catch(() => ({}));
        return { body: manager.drain(id, body?.reason) };
      },
      'POST /exec': async () => {
        needScope(req, 'exec');
        const body = await readJson(req);
        requireFields(body, ['argv']);
        if (!Array.isArray(body.argv) || body.argv.length === 0)
          throw fieldError('argv', 'must be a non-empty array');
        const out = await manager.exec(id, body);
        audited(req, 'sandbox.exec', { sandboxId: id, argv: body.argv[0] });
        return { body: out };
      },
      'GET /files': async () => {
        needScope(req, 'read');
        const filePath = needQuery(url, 'path');
        const sub = url.searchParams.get('list') === '1' ? 'fs.list' : 'fs.read';
        return {
          body: await manager.request(id, sub, {
            path: filePath,
            offset: num(url, 'offset'),
            length: num(url, 'length'),
          }),
        };
      },
      'PUT /files': async () => {
        needScope(req, 'admin');
        const body = await readJson(req);
        requireFields(body, ['path', 'data']);
        const out = await manager.request(id, 'fs.write', {
          path: body.path,
          data: body.data,
          append: body.append,
          mode: body.mode,
          mkdirs: body.mkdirs,
        });
        audited(req, 'file.write', { sandboxId: id, path: body.path });
        return { body: out };
      },
      'POST /sessions': async () => {
        needScope(req, 'exec');
        const body = await readJson(req);
        requireFields(body, ['argv']);
        return { status: 201, body: await manager.request(id, 'session.start', body) };
      },
      'GET /sessions': async () => {
        needScope(req, 'read');
        return { body: await manager.request(id, 'session.list', {}) };
      },
      'GET /evidence': async () => {
        needScope(req, 'read');
        return {
          body: manager.store.listEvidence(id, {
            limit: num(url, 'limit'),
            cursor: url.searchParams.get('cursor') ?? undefined,
          }),
        };
      },
      'GET /artifacts': async () => {
        needScope(req, 'read');
        return {
          body: manager.store.listArtifacts(id, {
            limit: num(url, 'limit'),
            cursor: url.searchParams.get('cursor') ?? undefined,
          }),
        };
      },
      'GET /checkpoints': async () => {
        needScope(req, 'read');
        return { body: { checkpoints: manager.store.listCheckpoints(id) } };
      },
      'POST /checkpoints': async () => {
        needScope(req, 'admin');
        const body = await readJson(req).catch(() => ({}));
        return { status: 201, body: await managerCheckpoint(manager, id, body ?? {}) };
      },
      'GET /events': async () => {
        needScope(req, 'read');
        return {
          body: {
            events: manager.store.listEvents(id, {
              afterSeq: num(url, 'afterSeq') ?? 0,
              limit: num(url, 'limit'),
            }),
          },
        };
      },
    };
    const fn = routes[key];
    if (!fn) throw httpError(404, 'E_NOT_FOUND', `no route ${m} ${url.pathname}`);
    return fn();
  }

  async function sandboxRoute(req, url, m, id, tail) {
    if (!id) return sandboxCollection(req, url, m);
    return sandboxItem(req, url, m, id, tail);
  }

  async function upgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://workbox');
    const m = /^\/v1\/sandboxes\/([^/]+)\/sessions\/([^/]+)\/ws$/.exec(url.pathname);
    const token =
      req.headers.authorization ??
      (url.searchParams.get('token') ? `Bearer ${url.searchParams.get('token')}` : undefined);
    const principal = auth.authenticate(token);
    if (!m || !principal || !auth.authorize(principal, 'exec')) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const ws = new WsSocket(socket, head);
    attachWsSession(manager, m[1], m[2], ws).catch((e) =>
      ws.send(JSON.stringify({ type: 'error', message: e.message })),
    );
  }

  function refreshGauges() {
    try {
      const counts = {};
      for (const s of manager.list({ limit: 1000, includeDeleted: true }).items)
        counts[s.state] = (counts[s.state] ?? 0) + 1;
      for (const [state, n] of Object.entries(counts))
        metrics.set('workbox_sandboxes', n, { state });
    } catch {
      // gauges are best-effort
    }
  }

  function sendText(req, text) {
    const res = req.res;
    if (res) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    }
    return undefined;
  }

  return {
    server,
    metrics,
    auth,
    /** @param {number} port @param {string} [host] */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    /** Graceful shutdown. */
    close() {
      shuttingDown = true;
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function managerCheckpoint(manager, id, body) {
  const { checkpointCreate } = await import('@workbox/core').catch(() => ({}));
  if (checkpointCreate && manager.brokerContextFor && manager.supervisor)
    return checkpointCreate(manager.brokerContextFor(manager.supervisor(id)), body);
  throw httpError(501, 'E_UNSUPPORTED', 'checkpoint create unavailable');
}

async function attachWsSession(manager, sandboxId, sessionId, ws) {
  ws.send(JSON.stringify({ type: 'ready', sessionId }));
  const onEvent = (evt) => {
    if (evt.sandboxId !== sandboxId || evt.params?.sessionId !== sessionId) return;
    ws.send(JSON.stringify({ type: evt.method, params: evt.params }));
  };
  manager.on?.('event', onEvent);
  ws.onClose(() => manager.off?.('event', onEvent));
  ws.onMessage(async (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.type === 'input')
      await manager
        .request(sandboxId, 'session.input', { sessionId, data: msg.data, eof: msg.eof })
        .catch(() => undefined);
    if (msg.type === 'resize')
      await manager
        .request(sandboxId, 'session.resize', { sessionId, rows: msg.rows, cols: msg.cols })
        .catch(() => undefined);
  });
  await manager.request(sandboxId, 'session.attach', { sessionId, fromSeq: 0 });
}

/** Minimal RFC6455 server-side socket: text frames out, masked text/ping/close in. */
export class WsSocket {
  /** @param {import('node:net').Socket} socket @param {Buffer} [head] */
  constructor(socket, head) {
    this.socket = socket;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.msgFn = null;
    this.closeFn = null;
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this.closeFn?.());
    if (this.buf.length) this._drain();
  }

  /** @param {string} text */
  send(text) {
    const payload = Buffer.from(text);
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x81, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    if (!this.socket.destroyed) this.socket.write(Buffer.concat([header, payload]));
  }

  /** @param {(text: string) => void} fn */
  onMessage(fn) {
    this.msgFn = fn;
  }

  /** @param {() => void} fn */
  onClose(fn) {
    this.closeFn = fn;
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    this._drain();
  }

  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked)
        for (let i = 0; i < payload.length; i++) payload[i] ^= this.buf[maskOff + (i % 4)];
      this.buf = this.buf.subarray(off + len);
      if (opcode === 0x8) {
        this.socket.end();
        this.closeFn?.();
        return;
      }
      if (opcode === 0x9) {
        if (!this.socket.destroyed) this.socket.write(Buffer.from([0x8a, 0]));
      } else if (opcode === 0x1) this.msgFn?.(payload.toString('utf8'));
    }
  }
}

function httpError(status, code, message, details) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (details) e.details = details;
  return e;
}

function fieldError(field, problem) {
  return httpError(400, 'E_INVALID_PARAMS', `invalid field ${field}: ${problem}`, {
    errors: [{ path: field, problem }],
  });
}

function requireFields(body, fields) {
  if (!body || typeof body !== 'object') throw fieldError('$', 'JSON object body required');
  for (const f of fields) if (body[f] === undefined) throw fieldError(f, 'is required');
}

function needQuery(url, name) {
  const v = url.searchParams.get(name);
  if (!v) throw fieldError(name, 'query parameter is required');
  return v;
}

function num(url, name) {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw fieldError(name, 'must be a non-negative integer');
  return n;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw httpError(413, 'E_LIMIT', 'request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw fieldError('$', 'body is not valid JSON');
  }
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body ?? null)}\n`);
}

const STATUS_BY_CODE = {
  E_NOT_FOUND: 404,
  E_INVALID_PARAMS: 400,
  E_DENIED: 403,
  E_TIMEOUT: 504,
  E_CONFLICT: 409,
  E_STATE: 409,
};

function sendError(req, res, e) {
  const status = e.status ?? STATUS_BY_CODE[e.code] ?? 500;
  sendJson(res, status, {
    error: {
      code: e.code ?? 'E_INTERNAL',
      message: e.message ?? 'internal error',
      details: e.details ?? e.data,
      requestId: req.requestId ?? null,
    },
  });
}
