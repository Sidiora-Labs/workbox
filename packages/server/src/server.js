import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import {
  DEFAULT_MAX_LINE_BYTES,
  Methods,
  SESSION_READ_MAX_BYTES,
  v,
  validate,
} from '@workbox/protocol';
import {
  DEFAULTS,
  E,
  Redactor,
  artifactPath,
  checkpointCreate,
  createLogger,
  httpStatusFor,
  publicAsk,
} from '@workbox/core';
import {
  createAuth,
  createStoredKey,
  browserGuard,
  FLEET_ROUTES,
  KEY_CREATE_SCHEMA,
  SCOPE_MATRIX,
} from './auth.js';
import { createLabels, isBound, requireUnbound, sandboxVisible } from './access.js';
import { WEBHOOK_CREATE_SCHEMA, WEBHOOK_UPDATE_SCHEMA, webhookHandlers } from './webhooks.js';
import { Metrics } from './metrics.js';
import { addressKey, createFailureLimiter } from './ratelimit.js';
import { EventHub, eventsQuery, pollEvents, streamEvents } from './streams.js';
import { WsSocket, acceptKey, rejectUpgrade } from './ws.js';

/**
 * REST + WebSocket harness surface (task 3.1), built on node:http, or node:https when given a
 * certificate (no framework dependency; the route/validation behaviour is the spec contract).
 * Every request passes the H15 browser guard, then the failed-authentication limit for its
 * address, then bearer auth against the scope matrix, then its body schema. Failures return the
 * envelope `{error:{code,message,details?,requestId}}`; every mutating request is audited.
 *
 * The `manager` dependency is the core Manager.
 */

/** Maximum accepted request body: the protocol's frame cap. */
export const MAX_BODY_BYTES = DEFAULT_MAX_LINE_BYTES;

/** Bytes moved per runner call when a file streams in or out: the runner's `fs.read` cap. */
export const FILE_CHUNK_BYTES = 4 * 1024 * 1024;

/** Default cap of one raw file upload (1 GiB). */
export const DEFAULT_MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

/** How long a session wait blocks by default. */
export const DEFAULT_WAIT_MS = 30_000;

/** The longest one session wait may block. */
export const MAX_WAIT_MS = 300_000;

const RAW_UPLOAD = 'PUT /v1/sandboxes/:id/files/raw';

const str = (o = {}) => v.optional(v.string(o));
const int = (o = {}) => v.optional(v.integer(o));

/** JSON schemas of every route that takes a body (protocol `v` schemas). */
export const BODY_SCHEMAS = Object.freeze({
  'POST /v1/sandboxes': v.object({
    name: str({ min: 1, max: 64 }),
    rootfs: str({ min: 1, max: 128 }),
    runtime: str({ min: 1, max: 128 }),
    profile: v.optional(v.record(v.any())),
    labels: v.optional(v.record(v.string({ max: 256 }))),
    idempotencyKey: str({ min: 1, max: 256 }),
    secretRefs: v.optional(v.array(v.string({ min: 1, max: 128 }), { max: 64 })),
    fromCheckpoint: str({ min: 1, max: 128 }),
  }),
  'POST /v1/sandboxes/:id/drain': v.object({ reason: str({ max: 1024 }) }),
  'POST /v1/sandboxes/:id/exec': v.object(
    {
      argv: v.array(v.string({ min: 1, max: 65_536 }), { min: 1, max: 4096 }),
      cwd: str({ min: 1, max: 4096 }),
      env: v.optional(v.record(v.string())),
      input: str(),
      name: str({ min: 1, max: 128 }),
      uid: int({ min: 0, max: 65_535 }),
      gid: int({ min: 0, max: 65_535 }),
      timeoutMs: int({ min: 1, max: 86_400_000 }),
      graceMs: int({ min: 0, max: 600_000 }),
      maxOutputBytes: int({ min: 0, max: 64 * 1024 * 1024 }),
    },
    { required: ['argv'] },
  ),
  'PUT /v1/sandboxes/:id/files': Methods['fs.write'].params,
  'POST /v1/sandboxes/:id/files/mkdir': v.object(
    {
      path: v.string({ min: 1, max: 4096 }),
      parents: v.optional(v.boolean()),
      mode: int({ min: 0, max: 0o7777 }),
    },
    { required: ['path'] },
  ),
  'POST /v1/sandboxes/:id/sessions': Methods['session.start'].params,
  'POST /v1/sandboxes/:id/sessions/:sessionId/wait': v.object({
    timeoutMs: int({ min: 0, max: MAX_WAIT_MS }),
  }),
  'POST /v1/sandboxes/:id/sessions/:sessionId/input': v.object({
    data: Methods['session.input'].params.props.data,
    text: str({ max: 4 * 1024 * 1024 }),
    eof: v.optional(v.boolean()),
  }),
  'POST /v1/sandboxes/:id/sessions/:sessionId/signal': v.object(
    { signal: Methods['session.signal'].params.props.signal },
    { required: ['signal'] },
  ),
  'POST /v1/sandboxes/:id/sessions/:sessionId/stop': v.object({
    graceMs: int({ min: 0, max: 600_000 }),
  }),
  'POST /v1/sandboxes/:id/sessions/:sessionId/resize': v.object(
    {
      rows: Methods['session.resize'].params.props.rows,
      cols: Methods['session.resize'].params.props.cols,
    },
    { required: ['rows', 'cols'] },
  ),
  'POST /v1/sandboxes/:id/checkpoints': Methods['broker.checkpoint.create'].params,
  'POST /v1/asks/:askId/answer': v.object({ answer: v.any() }, { required: ['answer'] }),
  'POST /v1/keys': KEY_CREATE_SCHEMA,
  'POST /v1/webhooks': WEBHOOK_CREATE_SCHEMA,
  'PATCH /v1/webhooks/:webhookId': WEBHOOK_UPDATE_SCHEMA,
});

/** Audit action of every mutating route. */
const MUTATIONS = Object.freeze({
  'POST /v1/sandboxes': 'sandbox.create',
  'DELETE /v1/sandboxes/:id': 'sandbox.destroy',
  'POST /v1/sandboxes/:id/drain': 'sandbox.drain',
  'POST /v1/sandboxes/:id/exec': 'sandbox.exec',
  'PUT /v1/sandboxes/:id/files': 'file.write',
  'DELETE /v1/sandboxes/:id/files': 'file.remove',
  'POST /v1/sandboxes/:id/files/mkdir': 'file.mkdir',
  [RAW_UPLOAD]: 'file.upload',
  'POST /v1/sandboxes/:id/sessions': 'session.start',
  'DELETE /v1/sandboxes/:id/sessions/:sessionId': 'session.remove',
  'POST /v1/sandboxes/:id/sessions/:sessionId/wait': 'session.wait',
  'POST /v1/sandboxes/:id/sessions/:sessionId/input': 'session.input',
  'POST /v1/sandboxes/:id/sessions/:sessionId/signal': 'session.signal',
  'POST /v1/sandboxes/:id/sessions/:sessionId/stop': 'session.stop',
  'POST /v1/sandboxes/:id/sessions/:sessionId/resize': 'session.resize',
  'POST /v1/sandboxes/:id/checkpoints': 'checkpoint.create',
  'POST /v1/reconcile': 'reconcile',
  'POST /v1/asks/:askId/answer': 'ask.answer',
  'POST /v1/keys': 'key.create',
  'DELETE /v1/keys/:keyId': 'key.revoke',
  'POST /v1/webhooks': 'webhook.create',
  'PATCH /v1/webhooks/:webhookId': 'webhook.update',
  'DELETE /v1/webhooks/:webhookId': 'webhook.delete',
  'POST /v1/webhooks/:webhookId/rotate-secret': 'webhook.rotate',
  'POST /v1/webhooks/:webhookId/test': 'webhook.test',
  'POST /v1/webhooks/:webhookId/deliveries/:deliveryId/retry': 'webhook.retry',
});

const ROUTES = Object.keys(SCOPE_MATRIX).map((key) => {
  const [method, template] = key.split(' ');
  return { key, method, parts: template.split('/') };
});

/**
 * Resolve a request to its route template.
 * @param {string} method @param {string} pathname
 * @returns {{key: string|null, params: Record<string, string>}|null} null when no route has this
 *   path; `key` null when the path exists under another method
 */
export function matchRoute(method, pathname) {
  const parts = pathname.split('/');
  let pathExists = false;
  for (const r of ROUTES) {
    const params = matchParts(r.parts, parts);
    if (!params) continue;
    if (r.method === method) return { key: r.key, params };
    pathExists = true;
  }
  return pathExists ? { key: null, params: {} } : null;
}

function matchParts(template, parts) {
  if (template.length !== parts.length) return null;
  const params = {};
  for (let i = 0; i < template.length; i++) {
    if (!template[i].startsWith(':')) {
      if (template[i] !== parts[i]) return null;
      continue;
    }
    if (!parts[i]) return null;
    try {
      params[template[i].slice(1)] = decodeURIComponent(parts[i]);
    } catch {
      return null;
    }
  }
  return params;
}

/**
 * @param {object} deps
 * @param {object} deps.manager the core Manager
 * @param {object} [deps.auth] a createAuth() result (else built from keys/keysFile and the
 *   manager's store, so keys minted through `POST /v1/keys` authenticate)
 * @param {object[]} [deps.keys] scoped keys
 * @param {string} [deps.keysFile] JSON file with scoped keys
 * @param {{append: (entry: object) => unknown}} [deps.audit] the core Audit
 * @param {import('@workbox/core').Logger} [deps.logger] structured JSON logger (default: one
 *   that redacts API key tokens)
 * @param {string[]} [deps.serverNames] Host names accepted besides localhost, 127.0.0.1 and ::1
 * @param {() => boolean} [deps.ready] readiness probe
 * @param {{heartbeatMs?: number, maxBufferedBytes?: number, maxFrameBytes?: number}} [deps.ws]
 * @param {number} [deps.maxBodyBytes]
 * @param {{cert: string|Buffer, key: string|Buffer}} [deps.tls] PEM certificate chain and key:
 *   serve HTTPS and WSS instead of plain HTTP
 * @param {{max?: number, windowMs?: number, maxEntries?: number}} [deps.authFailures] failed
 *   authentications one address may make per window before it is answered 429 (default 20 per
 *   60 s)
 * @param {number} [deps.maxUploadBytes] cap of one raw file upload (default 1 GiB)
 * @param {{config: object, notify: () => void}} [deps.webhooks] the core WebhookDispatcher: its
 *   config is the target guard's policy and it is woken when a webhook or delivery changes
 *   (without one, the policy is the manager config's `webhooks` and deliveries wait for a
 *   dispatcher to start)
 */
export function createServer(deps) {
  const manager = deps.manager;
  const auth =
    deps.auth ??
    createAuth({ keys: deps.keys ?? [], keysFile: deps.keysFile, store: manager.store });
  const audit = deps.audit ?? null;
  const logger = deps.logger ?? createLogger({ component: 'server', redactor: new Redactor() });
  const serverNames = (deps.serverNames ?? []).map((n) => n.toLowerCase());
  const maxBody = deps.maxBodyBytes ?? MAX_BODY_BYTES;
  const failures = createFailureLimiter(deps.authFailures);
  const metrics = new Metrics()
    .describe('workbox_http_requests_total', 'HTTP requests by route, method and status')
    .describe('workbox_ws_connections_total', 'WebSocket connections accepted')
    .describe('workbox_ws_dropped_total', 'WebSocket consumers dropped for backpressure')
    .describe('workbox_sandboxes', 'Sandboxes by state');
  /** @type {Set<WsSocket>} */
  const sockets = new Set();
  let shuttingDown = false;
  const stopping = new AbortController();
  const hub = new EventHub(manager);

  const handlers = routeHandlers(
    manager,
    () => {
      refreshGauges();
      return metrics.render();
    },
    {
      maxUploadBytes: deps.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
      hub,
      stopping: stopping.signal,
      policy: () => deps.webhooks?.config ?? manager.config?.webhooks ?? DEFAULTS.webhooks,
      notify: () => deps.webhooks?.notify(),
    },
  );
  const wsRoutes = webSocketRoutes(manager, hub);

  const onRequest = (req, res) => {
    handle(req, res).catch(() => res.destroy());
  };
  const server = deps.tls
    ? withTls(deps.tls, (material) => https.createServer(material, onRequest))
    : http.createServer(onRequest);
  server.on('upgrade', (req, socket, head) => {
    upgrade(req, socket, head).catch((e) => rejectUpgrade(socket, errorStatus(e), e.message));
  });

  async function handle(req, res) {
    const ctx = {
      req,
      res,
      started: Date.now(),
      requestId: requestIdOf(req),
      key: null,
      principal: null,
    };
    ctx.params = {};
    const gone = new AbortController();
    res.once('close', () => gone.abort());
    ctx.signal = gone.signal;
    res.setHeader('x-request-id', ctx.requestId);
    let status = 500;
    try {
      const out = await dispatch(ctx);
      status = out.status ?? 200;
      ctx.extra = out.audit;
      if (out.stream) await sendStream(ctx, status, out);
      else if (out.text !== undefined) {
        res.writeHead(status, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        res.end(out.text);
      } else sendJson(res, status, out.body);
    } catch (e) {
      status = errorStatus(e);
      ctx.error = e;
      if (status === 413 || (ctx.key === RAW_UPLOAD && !req.complete)) {
        res.setHeader('connection', 'close');
        req.resume();
      }
      if (e.retryAfter) res.setHeader('retry-after', String(e.retryAfter));
      sendError(res, status, e, ctx.requestId);
    } finally {
      finish(ctx, status);
    }
  }

  /**
   * Send a streamed body after its head. A failure once the head is out cuts the connection, so
   * the client sees a body shorter than its content-length; the request is logged as an error.
   */
  async function sendStream(ctx, status, out) {
    ctx.res.writeHead(status, out.headers);
    try {
      await out.stream(ctx.res);
    } catch (e) {
      ctx.error = e;
      ctx.cut = true;
      ctx.res.destroy();
    }
  }

  async function dispatch(ctx) {
    const { req } = ctx;
    const refusal = browserGuard(req.headers, serverNames);
    if (refusal) throw httpError(403, 'E_DENIED', refusal);
    const url = new URL(req.url ?? '/', 'http://workbox');
    if (url.pathname === '/healthz') return { body: { ok: true } };
    if (url.pathname === '/readyz') return readiness();
    const match = matchRoute(req.method ?? 'GET', url.pathname);
    if (!match) throw httpError(404, 'E_NOT_FOUND', `no route ${req.method} ${url.pathname}`);
    if (!match.key)
      throw httpError(405, 'E_INVALID_PARAMS', `method ${req.method} not allowed here`);
    ctx.key = match.key;
    ctx.params = match.params;
    const retryAfter = failures.retryAfter(peer(req));
    if (retryAfter) throw limited(retryAfter);
    ctx.principal = auth.authenticate(req.headers.authorization);
    if (!ctx.principal) failures.fail(peer(req));
    requireScope(ctx.principal, SCOPE_MATRIX[match.key]);
    if (FLEET_ROUTES.includes(match.key)) requireUnbound(ctx.principal);
    if (match.params.id !== undefined) requireVisible(ctx.principal, match.params.id);
    const schema = BODY_SCHEMAS[match.key];
    const body = schema ? checked(schema, await readJson(req, maxBody)) : undefined;
    return handlers[match.key]({
      url,
      params: match.params,
      body,
      principal: ctx.principal,
      req,
      res: ctx.res,
      signal: ctx.signal,
    });
  }

  function readiness() {
    const ready = !shuttingDown && (deps.ready ? deps.ready() : true);
    if (!ready) throw httpError(503, 'E_UNAVAILABLE', 'not ready');
    return { body: { ready: true } };
  }

  function requireScope(principal, scope) {
    if (!principal) throw httpError(401, 'E_DENIED', 'missing or invalid bearer token');
    if (!auth.authorize(principal, scope))
      throw httpError(403, 'E_DENIED', `scope ${scope} required`);
  }

  /**
   * The one visibility check of every route with an `:id`: a sandbox a bound principal cannot
   * see answers as a missing one. Unbound principals see every sandbox; the route itself reports
   * one that does not exist.
   */
  function requireVisible(principal, id) {
    if (!isBound(principal)) return;
    if (!sandboxVisible(principal, manager.store.getSandbox(id))) throw sandboxNotFound(id);
  }

  function finish(ctx, status) {
    const { req } = ctx;
    const route = ctx.key ?? 'unmatched';
    metrics.inc('workbox_http_requests_total', {
      route,
      method: req.method ?? 'GET',
      status: String(status),
    });
    const record = {
      requestId: ctx.requestId,
      method: req.method,
      path: req.url?.split('?')[0],
      route,
      status,
      ms: Date.now() - ctx.started,
      principal: ctx.principal?.id ?? null,
    };
    if (status >= 500 || ctx.cut) logger.error('request', { ...record, err: ctx.error });
    else logger.info('request', record);
    if (req.method !== 'GET' && req.method !== 'HEAD') auditRequest(ctx, status);
  }

  function auditRequest(ctx, status) {
    const sandboxId = ctx.params.id ?? ctx.extra?.sandboxId;
    audit?.append({
      actor: ctx.principal ? `api:${ctx.principal.id}` : 'api:anonymous',
      action: `api.${MUTATIONS[ctx.key] ?? 'unrouted'}`,
      ...(sandboxId ? { sandboxId } : {}),
      data: {
        requestId: ctx.requestId,
        method: ctx.req.method,
        route: ctx.key,
        status,
        outcome: ctx.error ? (ctx.error.code ?? 'E_INTERNAL') : 'ok',
        ...ctx.params,
        ...(ctx.extra ?? {}),
      },
    });
  }

  async function upgrade(req, socket, head) {
    const refusal = browserGuard(req.headers, serverNames);
    if (refusal) return rejectUpgrade(socket, 403, refusal);
    const url = new URL(req.url ?? '/', 'http://workbox');
    const match = matchRoute('GET', url.pathname);
    const route = match?.key ? wsRoutes[match.key] : undefined;
    if (!route) return rejectUpgrade(socket, 404, 'no websocket route');
    const retryAfter = failures.retryAfter(peer(req));
    if (retryAfter) return refuseLimited(socket, limited(retryAfter));
    const queryToken = url.searchParams.get('token');
    const principal = auth.authenticate(
      req.headers.authorization ?? (queryToken ? `Bearer ${queryToken}` : undefined),
    );
    if (!principal) {
      failures.fail(peer(req));
      return rejectUpgrade(socket, 401, 'missing or invalid bearer token');
    }
    if (!auth.authorize(principal, SCOPE_MATRIX[match.key]))
      return rejectUpgrade(socket, 403, `scope ${SCOPE_MATRIX[match.key]} required`);
    if (match.params.id !== undefined) requireVisible(principal, match.params.id);
    if (shuttingDown) return rejectUpgrade(socket, 503, 'shutting down');
    const key = req.headers['sec-websocket-key'];
    if (!key) return rejectUpgrade(socket, 400, 'missing Sec-WebSocket-Key');
    const opened = route({ url, params: match.params, principal });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const ws = new WsSocket(socket, head, deps.ws);
    sockets.add(ws);
    metrics.inc('workbox_ws_connections_total');
    ws.onClose(() => {
      sockets.delete(ws);
      if (ws.dropped) metrics.inc('workbox_ws_dropped_total');
    });
    audit?.append({ actor: `api:${principal.id}`, ...opened.audit });
    return opened.open(ws);
  }

  function refreshGauges() {
    const counts = {};
    for (const s of manager.list({ limit: 1000, includeDeleted: true }).items)
      counts[s.state] = (counts[s.state] ?? 0) + 1;
    for (const [state, n] of Object.entries(counts)) metrics.set('workbox_sandboxes', n, { state });
  }

  return {
    server,
    metrics,
    auth,
    /**
     * Swap the TLS certificate and key. New connections get the new certificate; open ones keep
     * theirs. Invalid material throws E_INVALID_PARAMS and the old certificate stays in use.
     * @param {{cert: string|Buffer, key: string|Buffer}} material PEM certificate chain and key
     */
    reloadTls(material) {
      if (!deps.tls) throw E.invalid('this server was not started with TLS');
      withTls(material, (pem) => server.setSecureContext(pem));
    },
    /** @param {number} port @param {string} [host] */
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    /**
     * Graceful shutdown: readiness fails, WebSocket clients get a 1001 close, idle connections
     * close, in-flight requests finish; stragglers are cut after `timeoutMs`.
     * @param {{timeoutMs?: number}} [opts]
     */
    close(opts = {}) {
      shuttingDown = true;
      stopping.abort();
      for (const ws of sockets) ws.close(1001);
      return new Promise((resolve) => {
        const timer = setTimeout(() => server.closeAllConnections(), opts.timeoutMs ?? 10_000);
        timer.unref();
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      });
    },
  };
}

/**
 * The WebSocket routes. Each runs after the upgrade passed the browser guard, the failed-auth
 * limit, authentication, the route's scope and the visibility of its `:id`; it checks its own
 * parameters and returns the audit entry and the function that serves the open socket.
 */
function webSocketRoutes(manager, hub) {
  const events = (url, principal, id) => {
    const { afterSeq, types, sandboxId = id } = eventsQuery(url, { fleet: id === undefined });
    const wanted = { afterSeq, types, sandboxId, principal };
    const data = { afterSeq: afterSeq ?? null, types: types ?? null, sandboxId: sandboxId ?? null };
    return {
      audit: { action: 'api.events.stream', ...(id === undefined ? {} : { sandboxId: id }), data },
      open: (ws) => streamEvents(hub, ws, wanted),
    };
  };
  return {
    'GET /v1/sandboxes/:id/sessions/:sessionId/ws': ({ params }) => {
      manager.get(params.id);
      return {
        audit: {
          action: 'api.session.attach',
          sandboxId: params.id,
          data: { sessionId: params.sessionId },
        },
        open: (ws) => attachWsSession(manager, params.id, params.sessionId, ws),
      };
    },
    'GET /v1/events/ws': ({ url, principal }) => events(url, principal),
    'GET /v1/sandboxes/:id/events/ws': ({ url, params, principal }) => {
      manager.get(params.id);
      return events(url, principal, params.id);
    },
  };
}

function routeHandlers(manager, renderMetrics, opts) {
  const upgradeOnly = () => {
    throw httpError(426, 'E_INVALID_PARAMS', 'this route requires a WebSocket upgrade');
  };
  const poll = (wanted, principal, signal) =>
    pollEvents(
      opts.hub,
      { ...wanted, principal },
      { signal: AbortSignal.any([signal, opts.stopping]) },
    );
  const page = (url) => ({ limit: num(url, 'limit'), cursor: query(url, 'cursor') });
  const known = (id) => {
    manager.get(id);
    return id;
  };
  return {
    'GET /metrics': () => ({ text: renderMetrics() }),
    'GET /v1/sandboxes': ({ url, principal }) => ({
      body: manager.list({
        ...page(url),
        includeDeleted: query(url, 'includeDeleted') === '1',
        binding: principal.binding,
      }),
    }),
    'POST /v1/sandboxes': async ({ body, principal }) => {
      const input = boundCreate(manager.store, principal, body);
      const row = await manager.create(input);
      if (!sandboxVisible(principal, row)) throw idempotencyTaken(input.idempotencyKey);
      return { status: 201, body: row, audit: { sandboxId: row.id } };
    },
    'GET /v1/sandboxes/:id': ({ params }) => ({ body: manager.inspect(params.id) }),
    'DELETE /v1/sandboxes/:id': async ({ params }) => ({ body: await manager.destroy(params.id) }),
    'POST /v1/sandboxes/:id/drain': async ({ params, body }) => ({
      body: await manager.drain(params.id, body.reason),
    }),
    'POST /v1/sandboxes/:id/exec': async ({ params, body }) => {
      const out = await manager.exec(params.id, body);
      return { body: out, audit: { argv0: body.argv[0], exitCode: out.exitCode } };
    },
    'GET /v1/sandboxes/:id/files': async ({ params, url }) => {
      const filePath = needQuery(url, 'path');
      if (query(url, 'list') === '1')
        return { body: await manager.request(params.id, 'fs.list', { path: filePath }) };
      if (query(url, 'stat') === '1')
        return { body: await manager.request(params.id, 'fs.stat', { path: filePath }) };
      return {
        body: await manager.request(params.id, 'fs.read', {
          path: filePath,
          offset: num(url, 'offset'),
          length: num(url, 'length'),
        }),
      };
    },
    'PUT /v1/sandboxes/:id/files': async ({ params, body }) => ({
      body: await manager.request(params.id, 'fs.write', body),
      audit: { path: body.path },
    }),
    'DELETE /v1/sandboxes/:id/files': async ({ params, url }) => {
      const filePath = needQuery(url, 'path');
      const recursive = query(url, 'recursive') === '1';
      return {
        body: await manager.request(params.id, 'fs.remove', { path: filePath, recursive }),
        audit: { path: filePath },
      };
    },
    'POST /v1/sandboxes/:id/files/mkdir': async ({ params, body }) => ({
      body: await makeDirectory(manager, params.id, body),
      audit: { path: body.path },
    }),
    'GET /v1/sandboxes/:id/files/raw': async ({ params, url }) => {
      const file = await openSandboxFile(manager, params.id, needQuery(url, 'path'));
      return {
        headers: { 'content-type': 'application/octet-stream', 'content-length': file.size },
        stream: (res) => pipeline(file.chunks, res),
      };
    },
    [RAW_UPLOAD]: async ({ params, url, req }) => {
      const filePath = needQuery(url, 'path');
      const max = opts.maxUploadBytes;
      if (Number(req.headers['content-length'] ?? 0) > max) throw uploadTooLarge(max);
      const out = await writeSandboxFile(manager, params.id, filePath, requestBody(req), {
        mode: octalQuery(url, 'mode'),
        mkdirs: query(url, 'mkdirs') === '1',
        maxBytes: max,
      });
      return { body: out, audit: { path: filePath, bytes: out.bytes } };
    },
    'GET /v1/sandboxes/:id/sessions': async ({ params }) => ({
      body: await manager.sessions(params.id),
    }),
    'POST /v1/sandboxes/:id/sessions': async ({ params, body }) => {
      const started = await manager.request(params.id, 'session.start', body);
      return { status: 201, body: started, audit: { sessionId: started.sessionId } };
    },
    'GET /v1/sandboxes/:id/sessions/:sessionId': async ({ params }) => ({
      body: await getSession(manager, params.id, params.sessionId),
    }),
    'DELETE /v1/sandboxes/:id/sessions/:sessionId': async ({ params }) => ({
      body: await removeSession(manager, params.id, params.sessionId),
    }),
    'GET /v1/sandboxes/:id/sessions/:sessionId/output': async ({ params, url }) => {
      const encoding = query(url, 'encoding') ?? 'base64';
      if (encoding !== 'base64' && encoding !== 'text')
        throw invalid([{ path: 'query.encoding', message: 'must be text or base64' }]);
      const maxBytes = num(url, 'maxBytes');
      if (maxBytes !== undefined && (maxBytes < 1 || maxBytes > SESSION_READ_MAX_BYTES))
        throw invalid([
          { path: 'query.maxBytes', message: `must be from 1 to ${SESSION_READ_MAX_BYTES}` },
        ]);
      const out = await readSessionOutput(manager, params.id, {
        sessionId: params.sessionId,
        fromSeq: num(url, 'fromSeq'),
        maxBytes,
      });
      return { body: encoding === 'text' ? { ...out, chunks: textChunks(out.chunks) } : out };
    },
    'POST /v1/sandboxes/:id/sessions/:sessionId/wait': async ({ params, body, res }) => {
      const gone = new AbortController();
      const onClose = () => gone.abort();
      res.once('close', onClose);
      try {
        const exited = await waitForSessionExit(manager, params.id, params.sessionId, {
          timeoutMs: body.timeoutMs,
          signal: gone.signal,
        });
        return { body: { sessionId: params.sessionId, exited } };
      } finally {
        res.off('close', onClose);
      }
    },
    'POST /v1/sandboxes/:id/sessions/:sessionId/input': async ({ params, body }) => {
      if (body.data !== undefined && body.text !== undefined)
        throw invalid([{ path: '$.text', message: 'give data or text, not both' }]);
      const data = body.text === undefined ? body.data : Buffer.from(body.text).toString('base64');
      return {
        body: await manager.request(params.id, 'session.input', {
          sessionId: params.sessionId,
          data,
          eof: body.eof,
        }),
      };
    },
    'POST /v1/sandboxes/:id/sessions/:sessionId/signal': async ({ params, body }) => ({
      body: await manager.request(params.id, 'session.signal', {
        sessionId: params.sessionId,
        signal: body.signal,
      }),
      audit: { signal: body.signal },
    }),
    'POST /v1/sandboxes/:id/sessions/:sessionId/stop': async ({ params, body }) => ({
      body: await manager.request(
        params.id,
        'session.stop',
        { sessionId: params.sessionId, graceMs: body.graceMs },
        { timeoutMs: (body.graceMs ?? 0) + 30_000 },
      ),
    }),
    'POST /v1/sandboxes/:id/sessions/:sessionId/resize': async ({ params, body }) => ({
      body: await manager.request(params.id, 'session.resize', {
        sessionId: params.sessionId,
        rows: body.rows,
        cols: body.cols,
      }),
    }),
    'GET /v1/sandboxes/:id/sessions/:sessionId/ws': upgradeOnly,
    'GET /v1/sandboxes/:id/evidence': ({ params, url }) => ({
      body: manager.store.listEvidence(known(params.id), page(url)),
    }),
    'GET /v1/sandboxes/:id/artifacts': ({ params, url }) => ({
      body: manager.store.listArtifacts(known(params.id), page(url)),
    }),
    'GET /v1/sandboxes/:id/artifacts/:sha256': async ({ params }) => {
      const file = await artifactFile(manager, known(params.id), params.sha256);
      return {
        headers: { 'content-type': 'application/octet-stream', 'content-length': file.size },
        stream: (res) => pipeline(fs.createReadStream(file.path), res),
      };
    },
    'GET /v1/sandboxes/:id/checkpoints': ({ params }) => ({
      body: { checkpoints: manager.store.listCheckpoints(known(params.id)) },
    }),
    'POST /v1/sandboxes/:id/checkpoints': async ({ params, body }) => {
      const sup = manager.supervisor(params.id);
      const out = await checkpointCreate(manager.brokerContextFor(sup), body);
      return { status: 201, body: out, audit: { checkpointId: out.id } };
    },
    'GET /v1/sandboxes/:id/events': async ({ params, url, signal }) => {
      const wanted = { ...eventsQuery(url), sandboxId: known(params.id) };
      return { body: await poll(wanted, null, signal) };
    },
    'GET /v1/sandboxes/:id/events/ws': upgradeOnly,
    'GET /v1/events': async ({ url, principal, signal }) => ({
      body: await poll(eventsQuery(url, { fleet: true }), principal, signal),
    }),
    'GET /v1/events/ws': upgradeOnly,
    'POST /v1/reconcile': async () => ({ body: await manager.reconcile() }),
    'GET /v1/asks': ({ url, principal }) => {
      manager.store.expireAsks();
      const rows = manager.store.listAsks({
        status: query(url, 'status') ?? 'all',
        sandboxId: query(url, 'sandboxId'),
        limit: num(url, 'limit'),
        binding: principal.binding,
      });
      return { body: { asks: rows.map(publicAsk) } };
    },
    'POST /v1/asks/:askId/answer': ({ params, body, principal }) => {
      if (isBound(principal)) {
        const ask = manager.store.getAsk(params.askId);
        if (!ask || !sandboxVisible(principal, manager.store.getSandbox(ask.sandboxId)))
          throw E.notFound(`ask ${params.askId} not found`, { askId: params.askId });
      }
      return {
        body: manager.answerAsk(params.askId, { answer: body.answer, by: principal.id }),
        audit: { askId: params.askId },
      };
    },
    'GET /v1/whoami': ({ principal }) => ({
      body: {
        id: principal.id,
        scopes: principal.scopes,
        binding: principal.binding ?? null,
        source: principal.source ?? 'config',
        expiresAt: principal.expiresAt ?? null,
      },
    }),
    'POST /v1/keys': ({ body, principal }) => {
      const key = createStoredKey(manager.store, body, principal.id);
      return {
        status: 201,
        body: key,
        audit: { keyId: key.id, name: key.name, scopes: key.scopes, binding: key.binding },
      };
    },
    'GET /v1/keys': () => ({ body: { keys: manager.store.listApiKeys() } }),
    'DELETE /v1/keys/:keyId': ({ params }) => ({ body: manager.store.revokeApiKey(params.keyId) }),
    ...webhookHandlers(manager.store, { policy: opts.policy, notify: opts.notify, page }),
  };
}

/**
 * The create input a principal may send. A bound principal gets its binding labels forced on
 * (see createLabels); it cannot replay another sandbox's idempotency key or restore a checkpoint
 * of a sandbox it cannot see.
 */
function boundCreate(store, principal, body) {
  if (!isBound(principal)) return body;
  const input = { ...body, labels: createLabels(principal, body.labels) };
  if (input.idempotencyKey) {
    const existing = store.getSandboxByIdempotencyKey(input.idempotencyKey);
    if (existing && !sandboxVisible(principal, existing))
      throw idempotencyTaken(input.idempotencyKey);
  }
  if (input.fromCheckpoint) {
    const cp = store.getCheckpoint(input.fromCheckpoint);
    if (!cp || !sandboxVisible(principal, store.getSandbox(cp.sandboxId)))
      throw E.notFound(`checkpoint ${input.fromCheckpoint} not found`, {
        checkpointId: input.fromCheckpoint,
      });
  }
  return input;
}

function sandboxNotFound(id) {
  return E.notFound(`sandbox ${id} not found`, { id });
}

function idempotencyTaken(idempotencyKey) {
  return E.conflict('idempotency key already used by another sandbox', { idempotencyKey });
}

async function attachWsSession(manager, sandboxId, sessionId, ws) {
  const onEvent = (evt) => {
    if (evt.sandboxId !== sandboxId || evt.params?.sessionId !== sessionId) return;
    ws.send(JSON.stringify({ type: evt.method, params: evt.params }));
  };
  manager.on('event', onEvent);
  ws.onClose(() => manager.off('event', onEvent));
  ws.onMessage((text) => {
    const call = wsCall(text, sessionId);
    if (!call) return;
    manager.request(sandboxId, call.method, call.params).catch((e) => {
      ws.send(JSON.stringify({ type: 'error', code: e.code ?? 'E_INTERNAL', message: e.message }));
    });
  });
  ws.send(JSON.stringify({ type: 'ready', sessionId }));
  try {
    await manager.request(sandboxId, 'session.attach', { sessionId, fromSeq: 0 });
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', code: e.code ?? 'E_INTERNAL', message: e.message }));
    ws.close(1011);
  }
}

/** Client WebSocket messages and the runner call each one maps to. */
function wsCall(text, sessionId) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (msg?.type === 'input')
    return { method: 'session.input', params: { sessionId, data: msg.data, eof: msg.eof } };
  if (msg?.type === 'resize')
    return { method: 'session.resize', params: { sessionId, rows: msg.rows, cols: msg.cols } };
  if (msg?.type === 'signal')
    return { method: 'session.signal', params: { sessionId, signal: msg.signal } };
  return null;
}

/** Hand `{cert, key}` to `use`; a missing or unusable certificate or key is E_INVALID_PARAMS. */
function withTls(material, use) {
  if (!material?.cert || !material?.key) throw E.invalid('TLS needs a certificate and a key');
  try {
    return use({ cert: material.cert, key: material.key });
  } catch (e) {
    throw E.invalid(`invalid TLS certificate or key: ${e.message}`);
  }
}

/** The address a request's failed authentications are counted under. */
function peer(req) {
  return addressKey(req.socket.remoteAddress);
}

function limited(retryAfter) {
  const e = httpError(429, 'E_LIMIT', 'too many failed authentications from this address', {
    retryAfterSeconds: retryAfter,
  });
  e.retryAfter = retryAfter;
  return e;
}

function refuseLimited(socket, e) {
  const body = JSON.stringify({ error: { code: e.code, message: e.message, details: e.details } });
  socket.end(
    `HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: ${e.retryAfter}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/**
 * One session of a sandbox with its exit status: the runner's record while the control channel
 * is up, the store's otherwise. `exited` is `{code, signal, at}` or null either way.
 * @param {object} manager the core Manager @param {string} id @param {string} sessionId
 * @returns {Promise<{sessionId: string, exited: {code: number|null, signal: string|null, at: number}|null, source: 'runner'|'store', [k: string]: unknown}>}
 */
export async function getSession(manager, id, sessionId) {
  const { source, sessions } = await manager.sessions(id);
  const row = sessions.find((s) => s.sessionId === sessionId);
  if (!row) throw httpError(404, 'E_NOT_FOUND', `session ${sessionId} not found`, { sessionId });
  return source === 'runner' ? { ...row, source } : { ...storedSession(row), source };
}

/**
 * A store session row in the runner's shape: the exit columns become `exited`.
 * @param {{exitedAt?: number|null, exitCode?: number|null, exitSignal?: string|null, [k: string]: unknown}} row
 */
export function storedSession(row) {
  const { exitedAt, exitCode, exitSignal, ...rest } = row;
  const exited =
    exitedAt === null || exitedAt === undefined
      ? null
      : { code: exitCode ?? null, signal: exitSignal ?? null, at: exitedAt };
  return { ...rest, exited };
}

/**
 * Resolve once the session exits (with `{code, signal, at}`), or with null when `timeoutMs`
 * passes or `signal` aborts first. The current status is read after subscribing, so an exit
 * that already happened, or happens meanwhile, is never missed; the timeout runs from then.
 * Every listener and timer is gone once it settles.
 * @param {object} manager the core Manager @param {string} id @param {string} sessionId
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<{code: number|null, signal: string|null, at: number}|null>}
 */
export function waitForSessionExit(manager, id, sessionId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_MS;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      resolve(null);
      return;
    }
    let settled = false;
    let timer = null;
    const onEvent = (evt) => {
      if (evt.sandboxId !== id || evt.method !== 'session.exit') return;
      if (evt.params?.sessionId !== sessionId) return;
      const { code, signal, at } = evt.params;
      settle(resolve, { code, signal, at });
    };
    const onAbort = () => settle(resolve, null);
    function settle(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      manager.off('event', onEvent);
      opts.signal?.removeEventListener('abort', onAbort);
      fn(value);
    }
    manager.on('event', onEvent);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    getSession(manager, id, sessionId).then(
      (s) => {
        if (s.exited) settle(resolve, s.exited);
        else if (!settled) timer = setTimeout(() => settle(resolve, null), timeoutMs);
      },
      (e) => settle(reject, e),
    );
  });
}

/**
 * `session.read` on the sandbox's runner. A runner that predates the method answers 501
 * E_UNSUPPORTED: the sandbox has to be recreated to read output this way.
 * @param {object} manager @param {string} id
 * @param {{sessionId: string, fromSeq?: number, maxBytes?: number}} params
 * @returns {Promise<{sessionId: string, chunks: {seq: number, stream: string, data: string}[], nextSeq: number, gap: object|null, truncated: boolean, exited: object|null}>}
 */
export async function readSessionOutput(manager, id, params) {
  try {
    return await manager.request(id, 'session.read', params);
  } catch (e) {
    if (e?.code !== 'E_UNKNOWN_METHOD') throw e;
    throw httpError(
      501,
      'E_UNSUPPORTED',
      `sandbox ${id} runs a runner without session.read; recreate the sandbox to read session output`,
      { method: 'session.read' },
    );
  }
}

/**
 * Chunks with base64 `data` turned into UTF-8 text. Each stream decodes in order, so a character
 * split between two of its chunks is whole in the later one; a cut-off character at the very end
 * becomes U+FFFD.
 * @param {{seq: number, stream: string, data: string}[]} chunks
 */
export function textChunks(chunks) {
  const decoders = new Map();
  const out = chunks.map((c) => {
    if (!decoders.has(c.stream)) decoders.set(c.stream, new StringDecoder('utf8'));
    return { ...c, data: decoders.get(c.stream).write(Buffer.from(c.data, 'base64')) };
  });
  for (const [stream, decoder] of decoders) {
    const tail = decoder.end();
    if (tail) out.findLast((c) => c.stream === stream).data += tail;
  }
  return out;
}

/**
 * Forget an exited session in the runner and in the store. A session the runner no longer knows
 * (it was rebooted) but the store still lists is dropped from the store.
 * @param {object} manager @param {string} id @param {string} sessionId
 */
export async function removeSession(manager, id, sessionId) {
  try {
    await manager.request(id, 'session.remove', { sessionId });
  } catch (e) {
    if (e?.code !== 'E_NOT_FOUND' || !manager.store.removeSession(id, sessionId)) throw e;
    return { sessionId, removed: true };
  }
  manager.store.removeSession(id, sessionId);
  return { sessionId, removed: true };
}

/**
 * Stat a sandbox file and read it lazily in FILE_CHUNK_BYTES pieces. `chunks` yields exactly
 * `size` bytes, or throws once the file turns out shorter than its stat said.
 * @param {object} manager @param {string} id @param {string} filePath
 * @returns {Promise<{size: number, chunks: AsyncGenerator<Buffer>}>}
 */
export async function openSandboxFile(manager, id, filePath) {
  const st = await manager.request(id, 'fs.stat', { path: filePath });
  if (!st.isFile) throw invalid([{ path: 'query.path', message: `${filePath} is not a file` }]);
  const size = st.size;
  async function* chunks() {
    let offset = 0;
    while (offset < size) {
      const length = Math.min(FILE_CHUNK_BYTES, size - offset);
      const r = await manager.request(id, 'fs.read', { path: filePath, offset, length });
      const buf = Buffer.from(r.data, 'base64');
      if (buf.length === 0) break;
      offset += buf.length;
      yield buf;
    }
    if (offset < size)
      throw httpError(409, 'E_STATE', `${filePath} shrank to ${offset} bytes while it was read`);
  }
  return { size, chunks: chunks() };
}

/**
 * Write a byte source into a sandbox file through `fs.write` calls of at most FILE_CHUNK_BYTES:
 * the first replaces the file (with `mode` and `mkdirs`), the rest append. More than `maxBytes`
 * is a 413 E_LIMIT. On any failure the partly written file is removed.
 * @param {object} manager @param {string} id @param {string} filePath
 * @param {AsyncIterable<Uint8Array|string>} source
 * @param {{mode?: number, mkdirs?: boolean, maxBytes?: number}} [opts]
 * @returns {Promise<{path: string, bytes: number}>}
 */
export async function writeSandboxFile(manager, id, filePath, source, opts = {}) {
  const max = opts.maxBytes ?? Infinity;
  let pending = [];
  let pendingBytes = 0;
  let total = 0;
  let written = false;
  const put = async (buf) => {
    const first = written ? {} : { mode: opts.mode, mkdirs: opts.mkdirs };
    await manager.request(id, 'fs.write', {
      path: filePath,
      data: buf.toString('base64'),
      append: written,
      ...first,
    });
    written = true;
  };
  try {
    for await (const piece of source) {
      const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
      total += chunk.length;
      if (total > max) throw uploadTooLarge(max);
      pending.push(chunk);
      pendingBytes += chunk.length;
      while (pendingBytes >= FILE_CHUNK_BYTES) {
        const all = Buffer.concat(pending);
        await put(all.subarray(0, FILE_CHUNK_BYTES));
        const rest = all.subarray(FILE_CHUNK_BYTES);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    if (pendingBytes > 0 || !written) await put(Buffer.concat(pending));
  } catch (e) {
    if (written) await manager.request(id, 'fs.remove', { path: filePath }).catch(() => undefined);
    throw e;
  }
  return { path: filePath, bytes: total };
}

async function makeDirectory(manager, id, body) {
  if (body.parents === false) {
    const parent = path.posix.dirname(body.path);
    const st = await manager.request(id, 'fs.stat', { path: parent }).catch((e) => {
      if (e?.code !== 'E_NOT_FOUND') throw e;
      throw httpError(404, 'E_NOT_FOUND', `parent directory ${parent} does not exist`, { parent });
    });
    if (!st.isDir) throw invalid([{ path: '$.path', message: `${parent} is not a directory` }]);
  }
  return manager.request(id, 'fs.mkdir', { path: body.path, mode: body.mode });
}

async function artifactFile(manager, id, sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw invalid([{ path: 'params.sha256', message: 'must be 64 lowercase hex characters' }]);
  const missing = () => httpError(404, 'E_NOT_FOUND', `artifact ${sha256} not found`, { sha256 });
  if (!manager.store.hasArtifactRef(id, sha256)) throw missing();
  const file = artifactPath(manager.config.paths.artifacts, sha256);
  const st = await fs.promises.stat(file).catch(() => {
    throw missing();
  });
  return { path: file, size: st.size };
}

/** The request body as chunks, without destroying the request when reading stops early. */
async function* requestBody(req) {
  try {
    yield* req.iterator({ destroyOnReturn: false });
  } catch (e) {
    throw httpError(499, 'E_CANCELLED', `the upload was cut off: ${e.message}`);
  }
}

function uploadTooLarge(max) {
  return httpError(413, 'E_LIMIT', `upload exceeds ${max} bytes`, { maxBytes: max });
}

function requestIdOf(req) {
  const given = req.headers['x-request-id'];
  return typeof given === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(given) ? given : randomUUID();
}

function httpError(status, code, message, details) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  if (details) e.details = details;
  return e;
}

function invalid(errors) {
  const first = errors[0];
  return httpError(400, 'E_INVALID_PARAMS', `invalid ${first.path}: ${first.message}`, { errors });
}

function checked(schema, body) {
  const result = validate(schema, body);
  if (!result.ok) throw invalid(result.errors);
  return body;
}

function query(url, name) {
  return url.searchParams.get(name) ?? undefined;
}

function needQuery(url, name) {
  const value = url.searchParams.get(name);
  if (!value) throw invalid([{ path: `query.${name}`, message: 'is required' }]);
  return value;
}

function num(url, name) {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0)
    throw invalid([{ path: `query.${name}`, message: 'must be a non-negative integer' }]);
  return n;
}

function octalQuery(url, name) {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  if (!/^0?[0-7]{1,4}$/.test(value))
    throw invalid([{ path: `query.${name}`, message: 'must be an octal mode such as 644' }]);
  return Number.parseInt(value, 8);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => httpError(413, 'E_LIMIT', `request body exceeds ${limit} bytes`);
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      reject(tooLarge());
      return;
    }
    const chunks = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      total += chunk.length;
      if (total > limit) {
        over = true;
        chunks.length = 0;
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      if (over) return;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(invalid([{ path: '$', message: 'body is not valid JSON' }]));
      }
    });
  });
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(`${JSON.stringify(body ?? null)}\n`);
}

function errorStatus(e) {
  return e?.status ?? httpStatusFor(e?.code);
}

function sendError(res, status, e, requestId) {
  sendJson(res, status, {
    error: {
      code: e.code ?? 'E_INTERNAL',
      message: status >= 500 && !e.code ? 'internal error' : (e.message ?? 'internal error'),
      details: e.details ?? e.data,
      requestId,
    },
  });
}
