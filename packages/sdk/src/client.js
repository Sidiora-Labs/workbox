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
  'GET /v1/sandboxes/:id/events/ws': ['Sandbox#events'],
  'GET /v1/events': ['WorkboxClient#listEvents'],
  'GET /v1/events/ws': ['WorkboxClient#events'],
  'POST /v1/reconcile': ['WorkboxClient#reconcile'],
  'GET /v1/asks': ['WorkboxClient#listAsks'],
  'POST /v1/asks/:askId/answer': ['WorkboxClient#answerAsk'],
  'GET /v1/whoami': ['WorkboxClient#whoami'],
  'POST /v1/keys': ['WorkboxClient#createKey'],
  'GET /v1/keys': ['WorkboxClient#listKeys'],
  'DELETE /v1/keys/:keyId': ['WorkboxClient#revokeKey'],
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

  /**
   * One page of events across the sandboxes this key can see, in `seq` order. With `waitMs`
   * (at most 60000) and nothing after `afterSeq` yet, the server holds the request until a
   * matching event is logged or the time is up. Pass `nextSeq` back as `afterSeq`.
   * @param {CallOptions & EventsOptions & {limit?: number, waitMs?: number}} [opts]
   * @returns {Promise<{events: EventRow[], nextSeq: number}>}
   */
  listEvents(opts = {}) {
    return this.request('GET', '/v1/events', {
      query: eventsQueryOf(opts, { sandboxId: opts.sandboxId }),
      signal: opts.signal,
    });
  }

  /**
   * Events across the sandboxes this key can see, pushed over a WebSocket: those after
   * `afterSeq` first when it is given, then live ones as they are logged. After a dropped
   * connection it reconnects with backoff and resumes after the last event it yielded, so none is
   * missed or repeated. Iterate until `close()` or the signal aborts (which throws its reason).
   * @param {CallOptions & EventsOptions} [opts]
   * @returns {EventStream}
   */
  events(opts = {}) {
    return new EventStream(this, '/v1/events', opts);
  }

  /**
   * The key this client authenticates with: its id, scopes, binding, source and expiry.
   * @param {CallOptions} [opts]
   * @returns {Promise<{id: string, scopes: string[], binding: {labels?: Record<string, string>, sandboxIds?: string[]}|null, source: 'config'|'store', expiresAt: number|null}>}
   */
  whoami(opts = {}) {
    return this.request('GET', '/v1/whoami', opts);
  }

  /**
   * Mint a stored key (sent once, never retried). `labels` and `sandboxIds` bind it to the
   * sandboxes it may see; the returned `token` is shown only in this response.
   * @param {{name: string, scopes: string[], labels?: Record<string, string>, sandboxIds?: string[], ttlSeconds?: number}} input
   * @param {CallOptions} [opts]
   * @returns {Promise<{id: string, name: string, token: string, scopes: string[], binding: object|null, createdAt: number, expiresAt: number|null}>}
   */
  createKey(input, opts = {}) {
    return this.request('POST', '/v1/keys', { body: input, signal: opts.signal });
  }

  /**
   * Stored keys, without tokens or digests.
   * @param {CallOptions} [opts]
   * @returns {Promise<{keys: object[]}>}
   */
  listKeys(opts = {}) {
    return this.request('GET', '/v1/keys', opts);
  }

  /**
   * Revoke a stored key; it stops working at once. Revoking twice returns the same row.
   * @param {string} keyId @param {CallOptions} [opts]
   * @returns {Promise<object>} the revoked key
   */
  revokeKey(keyId, opts = {}) {
    return this.request('DELETE', `/v1/keys/${enc(keyId)}`, opts);
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
   * One page of this sandbox's events with `seq` greater than `afterSeq`. With `waitMs` (at most
   * 60000) and nothing newer yet, the server holds the request until one is logged.
   * @param {CallOptions & {afterSeq?: number, limit?: number, types?: string[], waitMs?: number}} [opts]
   * @returns {Promise<{events: EventRow[], nextSeq: number}>}
   */
  listEvents(opts = {}) {
    return this.client.request('GET', `${this.path}/events`, {
      query: eventsQueryOf(opts),
      signal: opts.signal,
    });
  }

  /**
   * This sandbox's events after `afterSeq` (default 0) as an async iterator. Without `follow` it
   * pages the events route until a page comes back empty. With `follow` it streams over the
   * events WebSocket: the stored events first, then live ones as they are logged, reconnecting
   * after a drop without missing or repeating one, until the signal aborts.
   * @param {CallOptions & {afterSeq?: number, limit?: number, types?: string[], follow?: boolean}} [opts]
   * @returns {AsyncIterable<EventRow>}
   */
  events(opts = {}) {
    if (opts.follow)
      return new EventStream(this.client, `${this.path}/events`, {
        afterSeq: opts.afterSeq ?? 0,
        types: opts.types,
        signal: opts.signal,
      });
    return this.#pages(opts);
  }

  async *#pages(opts) {
    let afterSeq = opts.afterSeq ?? 0;
    for (;;) {
      const { events } = await this.listEvents({
        afterSeq,
        limit: opts.limit,
        types: opts.types,
        signal: opts.signal,
      });
      for (const evt of events) {
        afterSeq = evt.seq;
        yield evt;
      }
      if (!events.length) return;
    }
  }
}

/**
 * @typedef {{seq: number, sandboxId: string, type: string, source: string, payload: unknown, causation: string|null, at: number}} EventRow
 */

/**
 * @typedef {object} EventsOptions
 * @property {number} [afterSeq] start after this seq; without it a stream is live only
 * @property {string[]} [types] exact types or `prefix.*` patterns
 * @property {string} [sandboxId] one sandbox only
 */

/**
 * Events pushed over an events WebSocket (`<route>/ws`), as an async iterator. It reconnects with
 * jittered backoff after a drop and resumes after the last event it yielded, or after the point
 * where the stream turned live. A refused upgrade is explained by the REST route: an error that
 * would not succeed on retry (401, 403, 404, 400) is thrown; anything else is retried.
 */
export class EventStream {
  #client;
  #route;
  #types;
  #sandboxId;
  #signal;
  #resume;
  #attempt = 0;
  #closed = false;
  #conn = null;

  /**
   * @param {WorkboxClient} client
   * @param {string} route the REST events route; the WebSocket is `${route}/ws`
   * @param {CallOptions & EventsOptions} [opts]
   */
  constructor(client, route, opts = {}) {
    this.#client = client;
    this.#route = route;
    this.#types = opts.types;
    this.#sandboxId = opts.sandboxId;
    this.#signal = opts.signal;
    this.#resume = opts.afterSeq;
  }

  /** The seq a reconnect resumes after: the last event yielded, or where the stream went live. */
  get lastSeq() {
    return this.#resume;
  }

  /** Stop the stream; the iteration ends. */
  close() {
    this.#closed = true;
    this.#conn?.close();
  }

  /** @returns {AsyncGenerator<EventRow>} */
  async *[Symbol.asyncIterator]() {
    const signal = this.#signal;
    const onAbort = () => this.close();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal?.aborted) throw signal.reason;
        if (this.#closed) return;
        const conn = this.#connect();
        while (!this.#closed) {
          const msg = conn.queue.shift();
          if (!msg && conn.ended) break;
          if (!msg) await conn.next();
          const event = msg ? this.#advance(msg) : null;
          if (event) yield event;
        }
        conn.close();
        if (signal?.aborted) throw signal.reason;
        if (this.#closed) return;
        if (!conn.opened) await this.#explainRefusal();
        await sleep(
          retryDelay(this.#attempt++, this.#client.retryDelayMs, this.#client.maxRetryDelayMs),
          signal,
        );
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.close();
    }
  }

  /** Take a frame. Returns the event to yield, or null; any progress resets the backoff. */
  #advance(msg) {
    if (msg.type === 'live' && Number.isInteger(msg.seq)) {
      this.#resume = Math.max(this.#resume ?? 0, msg.seq);
      this.#attempt = 0;
      return null;
    }
    if (msg.type !== 'event' || !Number.isInteger(msg.event?.seq)) return null;
    if (this.#resume !== undefined && msg.event.seq <= this.#resume) return null;
    this.#resume = msg.event.seq;
    this.#attempt = 0;
    return msg.event;
  }

  #connect() {
    const base = this.#client.baseUrl.replace(/^http/, 'ws');
    const query = {
      ...eventsQueryOf(
        { afterSeq: this.#resume, types: this.#types },
        { sandboxId: this.#sandboxId },
      ),
      token: this.#client.token || undefined,
    };
    const ws = new WebSocket(`${base}${this.#route}/ws${qs(query)}`);
    let wake = null;
    const poke = () => {
      const fn = wake;
      wake = null;
      fn?.();
    };
    const conn = {
      queue: [],
      opened: false,
      ended: false,
      next: () =>
        new Promise((resolve) => {
          wake = resolve;
        }),
      close() {
        conn.ended = true;
        try {
          ws.close(1000);
        } catch {
          // already closing
        }
        poke();
      },
    };
    ws.addEventListener('open', () => {
      conn.opened = true;
    });
    ws.addEventListener('message', (ev) => {
      const msg = objectFrame(String(ev.data));
      if (!msg) return;
      conn.queue.push(msg);
      poke();
    });
    const end = () => {
      conn.ended = true;
      poke();
    };
    ws.addEventListener('error', end);
    ws.addEventListener('close', end);
    this.#conn = conn;
    return conn;
  }

  /** After a refused upgrade, ask the REST route why; throw what a retry would not fix. */
  async #explainRefusal() {
    try {
      await this.#client.request('GET', this.#route, {
        query: eventsQueryOf(
          { afterSeq: this.#resume ?? 0, limit: 1, types: this.#types },
          { sandboxId: this.#sandboxId },
        ),
        signal: this.#signal,
      });
    } catch (e) {
      if (this.#signal?.aborted || !e?.retryable) throw e;
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

/** A frame that is a JSON object, or null for anything else. */
function objectFrame(text) {
  try {
    const msg = JSON.parse(text);
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

function eventsQueryOf(opts, extra = {}) {
  return {
    afterSeq: opts.afterSeq,
    limit: opts.limit,
    types: opts.types?.length ? opts.types.join(',') : undefined,
    waitMs: opts.waitMs,
    ...extra,
  };
}

function qs(obj = {}) {
  const parts = Object.entries(obj).filter(([, val]) => val !== undefined && val !== null);
  if (!parts.length) return '';
  return `?${new URLSearchParams(parts.map(([k, val]) => [k, String(val)])).toString()}`;
}

function enc(segment) {
  return encodeURIComponent(segment);
}
