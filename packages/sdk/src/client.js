import { WorkboxApiError } from './errors.js';

/**
 * JavaScript client for the Workbox REST and WebSocket API (task 3.2), built on the `fetch` and
 * `WebSocket` globals only. Idempotent calls (GET, DELETE, drain, reconcile, a file write that
 * does not append, and create, which always carries an idempotency key) retry with jittered
 * exponential backoff on 5xx, 429 and transport failures; every other call is sent exactly once.
 * Every method takes an AbortSignal, which also cuts a pending backoff short.
 */

/**
 * @typedef {object} CallOptions
 * @property {AbortSignal} [signal] aborts the request, its retries and any backoff between them
 */

/**
 * @typedef {object} ClientOptions
 * @property {string} baseUrl e.g. `http://127.0.0.1:8790`, or `https://host:8790` for a TLS server
 * @property {string} [token] bearer token of a scoped key
 * @property {number} [retries] retries after the first attempt of an idempotent call (default 2)
 * @property {number} [retryDelayMs] base backoff (default 100); retry n waits about base*2^n
 * @property {number} [maxRetryDelayMs] backoff cap (default 5000)
 */

/** @typedef {{items: object[], cursor: string|null, complete: boolean}} Page */

/**
 * @typedef {object} RequestOptions
 * @property {unknown} [body] JSON request body
 * @property {Record<string, string|number|boolean|undefined|null>} [query] query parameters
 * @property {AbortSignal} [signal]
 * @property {boolean} [idempotent] safe to resend (default: GET and DELETE)
 */

/** Every server route and the SDK methods that call it (`Class#method`). */
export const ROUTES = Object.freeze({
  'GET /healthz': ['WorkboxClient#health'],
  'GET /readyz': ['WorkboxClient#ready'],
  'GET /metrics': ['WorkboxClient#metrics'],
  'GET /v1/sandboxes': ['WorkboxClient#listSandboxes'],
  'POST /v1/sandboxes': ['WorkboxClient#createSandbox'],
  'GET /v1/sandboxes/:id': ['Sandbox#inspect'],
  'DELETE /v1/sandboxes/:id': ['Sandbox#destroy'],
  'POST /v1/sandboxes/:id/drain': ['Sandbox#drain'],
  'POST /v1/sandboxes/:id/exec': ['Sandbox#exec'],
  'GET /v1/sandboxes/:id/files': ['Sandbox#readFile', 'Sandbox#listFiles'],
  'PUT /v1/sandboxes/:id/files': ['Sandbox#writeFile'],
  'GET /v1/sandboxes/:id/sessions': ['Sandbox#listSessions'],
  'POST /v1/sandboxes/:id/sessions': ['Sandbox#startSession'],
  'GET /v1/sandboxes/:id/sessions/:sessionId/ws': ['Sandbox#attach'],
  'GET /v1/sandboxes/:id/evidence': ['Sandbox#listEvidence'],
  'GET /v1/sandboxes/:id/artifacts': ['Sandbox#listArtifacts'],
  'GET /v1/sandboxes/:id/checkpoints': ['Sandbox#listCheckpoints'],
  'POST /v1/sandboxes/:id/checkpoints': ['Sandbox#createCheckpoint'],
  'GET /v1/sandboxes/:id/events': ['Sandbox#listEvents', 'Sandbox#events'],
  'POST /v1/reconcile': ['WorkboxClient#reconcile'],
  'GET /v1/asks': ['WorkboxClient#listAsks'],
  'POST /v1/asks/:askId/answer': ['WorkboxClient#answerAsk'],
});

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'DELETE']);

export class WorkboxClient {
  /** @param {ClientOptions} opts */
  constructor(opts) {
    if (!opts?.baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    this.token = opts.token ?? '';
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 100;
    this.maxRetryDelayMs = opts.maxRetryDelayMs ?? 5000;
  }

  /**
   * One API call. Resolves to the parsed JSON body (text for non-JSON responses, null when
   * empty); rejects with a WorkboxApiError, or with the signal's reason once aborted.
   * @param {string} method @param {string} path @param {RequestOptions} [opts]
   * @returns {Promise<any>}
   */
  async request(method, path, opts = {}) {
    const idempotent = opts.idempotent ?? IDEMPOTENT_METHODS.has(method);
    const attempts = idempotent ? this.retries + 1 : 1;
    const target = `${path}${qs(opts.query)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send(method, target, opts);
      } catch (e) {
        if (opts.signal?.aborted || !e?.retryable || attempt + 1 >= attempts) throw e;
      }
      await sleep(retryDelay(attempt, this.retryDelayMs, this.maxRetryDelayMs), opts.signal);
    }
  }

  async #send(method, target, opts) {
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    let res;
    let text;
    try {
      res = await fetch(`${this.baseUrl}${target}`, {
        method,
        headers,
        signal: opts.signal,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      if (res.ok) text = await res.text();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw WorkboxApiError.transport(e, `${method} ${target.split('?')[0]}`);
    }
    if (!res.ok) throw await WorkboxApiError.fromResponse(res);
    if (!text) return null;
    return (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
  }

  /** Liveness. @param {CallOptions} [opts] @returns {Promise<{ok: boolean}>} */
  health(opts = {}) {
    return this.request('GET', '/healthz', opts);
  }

  /**
   * Readiness; a server that is not ready (or shutting down) rejects with status 503 at once.
   * @param {CallOptions} [opts] @returns {Promise<{ready: boolean}>}
   */
  ready(opts = {}) {
    return this.request('GET', '/readyz', { signal: opts.signal, idempotent: false });
  }

  /** Prometheus exposition text. @param {CallOptions} [opts] @returns {Promise<string>} */
  metrics(opts = {}) {
    return this.request('GET', '/metrics', opts);
  }

  /**
   * One inventory page; pass the returned `cursor` back until `complete` is true.
   * @param {CallOptions & {cursor?: string, limit?: number, includeDeleted?: boolean}} [opts]
   * @returns {Promise<Page>}
   */
  listSandboxes(opts = {}) {
    const { cursor, limit } = opts;
    const query = { cursor, limit, includeDeleted: opts.includeDeleted ? '1' : undefined };
    return this.request('GET', '/v1/sandboxes', { query, signal: opts.signal });
  }

  /**
   * Create and launch a sandbox. The request always carries an idempotency key (the caller's, or
   * a fresh UUID), so a retry after a lost response returns the same sandbox instead of a second.
   * @param {{name?: string, rootfs?: string, runtime?: string, profile?: object, labels?: Record<string, string>, idempotencyKey?: string, secretRefs?: string[], fromCheckpoint?: string}} [input]
   * @param {CallOptions} [opts]
   * @returns {Promise<Sandbox>}
   */
  async createSandbox(input = {}, opts = {}) {
    const body = { ...input, idempotencyKey: input.idempotencyKey ?? crypto.randomUUID() };
    const row = await this.request('POST', '/v1/sandboxes', {
      body,
      signal: opts.signal,
      idempotent: true,
    });
    return new Sandbox(this, row.id, row);
  }

  /** A handle on an existing sandbox (no request is made). @param {string} id @returns {Sandbox} */
  sandbox(id) {
    return new Sandbox(this, id);
  }

  /**
   * Rediscover every sandbox from store and cgroups (req 2 ac_3).
   * @param {CallOptions} [opts]
   * @returns {Promise<{attached: string[], absent: string[], suspect: string[], quarantined: string[]}>}
   */
  reconcile(opts = {}) {
    return this.request('POST', '/v1/reconcile', { signal: opts.signal, idempotent: true });
  }

  /**
   * @param {CallOptions & {status?: 'open'|'answered'|'expired'|'all', sandboxId?: string, limit?: number}} [opts]
   * @returns {Promise<{asks: object[]}>}
   */
  listAsks(opts = {}) {
    const query = { status: opts.status, sandboxId: opts.sandboxId, limit: opts.limit };
    return this.request('GET', '/v1/asks', { query, signal: opts.signal });
  }

  /**
   * Answer an open ask (sent once: a second answer is a 409).
   * @param {string} askId @param {unknown} answer @param {CallOptions} [opts]
   * @returns {Promise<object>}
   */
  answerAsk(askId, answer, opts = {}) {
    return this.request('POST', `/v1/asks/${enc(askId)}/answer`, {
      body: { answer },
      signal: opts.signal,
    });
  }
}

/** A handle on one sandbox. */
export class Sandbox {
  /** @param {WorkboxClient} client @param {string} id @param {object} [row] */
  constructor(client, id, row) {
    this.client = client;
    this.id = id;
    this.row = row ?? null;
    this.path = `/v1/sandboxes/${enc(id)}`;
  }

  /**
   * Desired state, observed health and last observation time, reported apart.
   * @param {CallOptions} [opts] @returns {Promise<object>}
   */
  inspect(opts = {}) {
    return this.client.request('GET', this.path, opts);
  }

  /** @param {CallOptions} [opts] @returns {Promise<object>} the DELETED row */
  destroy(opts = {}) {
    return this.client.request('DELETE', this.path, opts);
  }

  /** @param {string} [reason] @param {CallOptions} [opts] @returns {Promise<object>} */
  drain(reason, opts = {}) {
    return this.client.request('POST', `${this.path}/drain`, {
      body: reason === undefined ? {} : { reason },
      signal: opts.signal,
      idempotent: true,
    });
  }

  /**
   * Run a command to completion (sent once, never retried).
   * @param {{argv: string[], cwd?: string, env?: Record<string, string>, input?: string, name?: string, uid?: number, gid?: number, timeoutMs?: number, graceMs?: number, maxOutputBytes?: number}} params
   * @param {CallOptions} [opts]
   * @returns {Promise<{stdout: string, stderr: string, exitCode: number|null, [k: string]: unknown}>}
   */
  exec(params, opts = {}) {
    return this.client.request('POST', `${this.path}/exec`, { body: params, signal: opts.signal });
  }

  /**
   * @param {string} filePath @param {CallOptions & {offset?: number, length?: number}} [opts]
   * @returns {Promise<{data: string, eof: boolean, [k: string]: unknown}>} `data` is base64
   */
  readFile(filePath, opts = {}) {
    const query = { path: filePath, offset: opts.offset, length: opts.length };
    return this.client.request('GET', `${this.path}/files`, { query, signal: opts.signal });
  }

  /**
   * @param {string} dir @param {CallOptions} [opts]
   * @returns {Promise<{entries: {name: string, type: string}[]}>}
   */
  listFiles(dir, opts = {}) {
    const query = { path: dir, list: '1' };
    return this.client.request('GET', `${this.path}/files`, { query, signal: opts.signal });
  }

  /**
   * Write bytes (a string is written as UTF-8). Retried only when it does not append.
   * @param {string} filePath @param {Uint8Array|string} data
   * @param {CallOptions & {append?: boolean, mode?: number, mkdirs?: boolean}} [opts]
   * @returns {Promise<{bytes: number, [k: string]: unknown}>}
   */
  writeFile(filePath, data, opts = {}) {
    const { signal, ...rest } = opts;
    return this.client.request('PUT', `${this.path}/files`, {
      body: { ...rest, path: filePath, data: Buffer.from(data).toString('base64') },
      signal,
      idempotent: !rest.append,
    });
  }

  /** @param {CallOptions} [opts] @returns {Promise<{sessions: object[]}>} */
  listSessions(opts = {}) {
    return this.client.request('GET', `${this.path}/sessions`, opts);
  }

  /**
   * Start a durable session; stream it with `attach(sessionId)`.
   * @param {{argv: string[], cwd?: string, env?: Record<string, string>, name?: string, pty?: boolean, rows?: number, cols?: number, [k: string]: unknown}} params
   * @param {CallOptions} [opts]
   * @returns {Promise<{sessionId: string, [k: string]: unknown}>}
   */
  startSession(params, opts = {}) {
    return this.client.request('POST', `${this.path}/sessions`, {
      body: params,
      signal: opts.signal,
    });
  }

  /**
   * Attach to a session over the WebSocket route. The stream replays the session from its first
   * byte and is an async iterator of its events (`{type: 'session.output'|'session.exit'|..., params}`)
   * that ends after `session.exit`; it also sends input, resizes and signals.
   * @param {string} sessionId @param {CallOptions} [opts]
   * @returns {SessionStream}
   */
  attach(sessionId, opts = {}) {
    const base = this.client.baseUrl.replace(/^http/, 'ws');
    const url = `${base}${this.path}/sessions/${enc(sessionId)}/ws${qs({ token: this.client.token || undefined })}`;
    return new SessionStream(url, opts);
  }

  /** @param {CallOptions & {cursor?: string, limit?: number}} [opts] @returns {Promise<Page>} */
  listEvidence(opts = {}) {
    const query = { cursor: opts.cursor, limit: opts.limit };
    return this.client.request('GET', `${this.path}/evidence`, { query, signal: opts.signal });
  }

  /** @param {CallOptions & {cursor?: string, limit?: number}} [opts] @returns {Promise<Page>} */
  listArtifacts(opts = {}) {
    const query = { cursor: opts.cursor, limit: opts.limit };
    return this.client.request('GET', `${this.path}/artifacts`, { query, signal: opts.signal });
  }

  /** @param {CallOptions} [opts] @returns {Promise<{checkpoints: object[]}>} */
  listCheckpoints(opts = {}) {
    return this.client.request('GET', `${this.path}/checkpoints`, opts);
  }

  /**
   * Checkpoint the sandbox's upper layer (sent once, never retried).
   * @param {{name?: string, summary?: string, paths?: string[]}} [params] @param {CallOptions} [opts]
   * @returns {Promise<{id: string, [k: string]: unknown}>}
   */
  createCheckpoint(params = {}, opts = {}) {
    return this.client.request('POST', `${this.path}/checkpoints`, {
      body: params,
      signal: opts.signal,
    });
  }

  /**
   * One page of events with `seq` greater than `afterSeq`.
   * @param {CallOptions & {afterSeq?: number, limit?: number}} [opts]
   * @returns {Promise<{events: {seq: number, type: string, payload: unknown, at: number, [k: string]: unknown}[]}>}
   */
  listEvents(opts = {}) {
    const query = { afterSeq: opts.afterSeq, limit: opts.limit };
    return this.client.request('GET', `${this.path}/events`, { query, signal: opts.signal });
  }

  /**
   * Every event after `afterSeq` as an async iterator. The server's events route is paged
   * polling, not a push stream: this pages with `afterSeq` until a page comes back empty; with
   * `follow` it keeps polling every `intervalMs` (default 1000) until the signal aborts.
   * @param {CallOptions & {afterSeq?: number, limit?: number, follow?: boolean, intervalMs?: number}} [opts]
   * @returns {AsyncGenerator<{seq: number, type: string, payload: unknown, at: number, [k: string]: unknown}>}
   */
  async *events(opts = {}) {
    let afterSeq = opts.afterSeq ?? 0;
    for (;;) {
      const { events } = await this.listEvents({
        afterSeq,
        limit: opts.limit,
        signal: opts.signal,
      });
      for (const evt of events) {
        afterSeq = evt.seq;
        yield evt;
      }
      if (events.length) continue;
      if (!opts.follow) return;
      await sleep(opts.intervalMs ?? 1000, opts.signal);
    }
  }
}

/**
 * A live session WebSocket. Iterate it for events; `input`, `resize` and `sendSignal` queue until
 * the server's `ready` handshake. An `error` message, an abort or a connection lost before
 * `session.exit` makes the iterator throw.
 */
export class SessionStream {
  #ws;
  #queue = [];
  #outbox = [];
  #ready = false;
  #closed = false;
  #failure = null;
  #wake = null;
  #signal;
  #onAbort;

  /** @param {string} url ws(s) URL of the session route @param {CallOptions} [opts] */
  constructor(url, opts = {}) {
    this.#signal = opts.signal;
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
    this.#ws.addEventListener('error', () =>
      this.#fail(
        new WorkboxApiError({
          status: 0,
          code: 'E_UNAVAILABLE',
          message: 'session websocket failed',
        }),
      ),
    );
    this.#ws.addEventListener('close', (ev) => {
      if (!this.#closed && ev.code !== 1000)
        this.#fail(
          new WorkboxApiError({
            status: 0,
            code: 'E_UNAVAILABLE',
            message: `session websocket closed (${ev.code})`,
          }),
        );
      this.#closed = true;
      this.#poke();
    });
    this.#onAbort = () => {
      this.#queue.length = 0;
      this.#fail(this.#signal.reason);
      this.close();
    };
    if (this.#signal?.aborted) this.#onAbort();
    else this.#signal?.addEventListener('abort', this.#onAbort, { once: true });
  }

  /** Send stdin bytes (a string is UTF-8). @param {Uint8Array|string} data @param {{eof?: boolean}} [opts] */
  input(data, opts = {}) {
    this.#send({ type: 'input', data: Buffer.from(data).toString('base64'), eof: opts.eof });
  }

  /** @param {number} rows @param {number} cols */
  resize(rows, cols) {
    this.#send({ type: 'resize', rows, cols });
  }

  /** Deliver a signal to the session's process. @param {string} name e.g. `SIGTERM` */
  sendSignal(name) {
    this.#send({ type: 'signal', signal: name });
  }

  /** Detach (the session keeps running in the sandbox). */
  close() {
    this.#closed = true;
    this.#signal?.removeEventListener('abort', this.#onAbort);
    try {
      this.#ws.close(1000);
    } catch {
      // already closing
    }
    this.#poke();
  }

  /** @returns {AsyncGenerator<{type: string, params?: any, code?: string, message?: string}>} */
  async *[Symbol.asyncIterator]() {
    try {
      for (;;) {
        if (this.#queue.length) {
          const msg = this.#queue.shift();
          yield msg;
          if (msg.type === 'session.exit') return;
          continue;
        }
        if (this.#failure) throw this.#failure;
        if (this.#closed) return;
        await new Promise((resolve) => {
          this.#wake = resolve;
        });
      }
    } finally {
      this.close();
    }
  }

  #onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.type === 'ready') {
      this.#ready = true;
      for (const out of this.#outbox.splice(0)) this.#ws.send(out);
      return;
    }
    if (msg?.type === 'error') {
      this.#fail(
        new WorkboxApiError({
          status: 0,
          code: msg.code ?? 'E_INTERNAL',
          message: msg.message ?? 'session error',
          retryable: false,
        }),
      );
      return;
    }
    this.#queue.push(msg);
    this.#poke();
  }

  #send(msg) {
    const text = JSON.stringify(msg);
    if (this.#ready) this.#ws.send(text);
    else this.#outbox.push(text);
  }

  #fail(e) {
    this.#failure ??= e;
    this.#poke();
  }

  #poke() {
    const wake = this.#wake;
    this.#wake = null;
    wake?.();
  }
}

/**
 * Backoff before retry `attempt` (0-based): half of base*2^attempt fixed, half random, capped.
 * @param {number} attempt @param {number} baseMs @param {number} maxMs
 * @param {() => number} [random] uniform [0, 1)
 * @returns {number}
 */
export function retryDelay(attempt, baseMs, maxMs, random = Math.random) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function qs(obj = {}) {
  const parts = Object.entries(obj).filter(([, val]) => val !== undefined && val !== null);
  if (!parts.length) return '';
  return `?${new URLSearchParams(parts.map(([k, val]) => [k, String(val)])).toString()}`;
}

function enc(segment) {
  return encodeURIComponent(segment);
}
