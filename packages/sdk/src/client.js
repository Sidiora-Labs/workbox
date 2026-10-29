import { WorkboxApiError } from './errors.js';

/**
 * JavaScript client for the Workbox REST and WebSocket API (task 3.2), built on the `fetch` and
 * `WebSocket` globals only. Idempotent calls (GET, DELETE, drain, reconcile, a file write that
 * does not append, an upload from bytes, mkdir, a session wait, stop or resize, and create, which
 * always carries an idempotency key) retry with jittered exponential backoff on 5xx, 429 and
 * transport failures; every other call, an upload from a stream included, is sent exactly once.
 * Every method takes an AbortSignal, which also cuts a pending backoff short.
 */

/**
 * @typedef {object} CallOptions
 * @property {AbortSignal} [signal] aborts the request, its retries and any backoff between them
 */

/**
 * @typedef {object} ClientOptions
 * @property {string} baseUrl e.g. `http://127.0.0.1:8790`
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
 * @property {Uint8Array|string|ReadableStream|AsyncIterable<Uint8Array|string>} [bytes] raw
 *   request body, sent as `application/octet-stream` instead of `body`
 */

/**
 * @typedef {CallOptions & {stream?: boolean}} DownloadOptions `stream: true` resolves to the
 *   response body as a web ReadableStream instead of a Buffer
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
  'GET /v1/sandboxes/:id/files': ['Sandbox#readFile', 'Sandbox#listFiles', 'Sandbox#statFile'],
  'PUT /v1/sandboxes/:id/files': ['Sandbox#writeFile'],
  'DELETE /v1/sandboxes/:id/files': ['Sandbox#removeFile'],
  'POST /v1/sandboxes/:id/files/mkdir': ['Sandbox#mkdir'],
  'GET /v1/sandboxes/:id/files/raw': ['Sandbox#download'],
  'PUT /v1/sandboxes/:id/files/raw': ['Sandbox#upload'],
  'GET /v1/sandboxes/:id/sessions': ['Sandbox#listSessions'],
  'POST /v1/sandboxes/:id/sessions': ['Sandbox#startSession'],
  'GET /v1/sandboxes/:id/sessions/:sessionId': ['SandboxSession#info'],
  'DELETE /v1/sandboxes/:id/sessions/:sessionId': ['SandboxSession#remove'],
  'GET /v1/sandboxes/:id/sessions/:sessionId/output': ['SandboxSession#output'],
  'POST /v1/sandboxes/:id/sessions/:sessionId/wait': ['SandboxSession#wait'],
  'POST /v1/sandboxes/:id/sessions/:sessionId/input': ['SandboxSession#input'],
  'POST /v1/sandboxes/:id/sessions/:sessionId/signal': ['SandboxSession#signal'],
  'POST /v1/sandboxes/:id/sessions/:sessionId/stop': ['SandboxSession#stop'],
  'POST /v1/sandboxes/:id/sessions/:sessionId/resize': ['SandboxSession#resize'],
  'GET /v1/sandboxes/:id/sessions/:sessionId/ws': ['Sandbox#attach'],
  'GET /v1/sandboxes/:id/evidence': ['Sandbox#listEvidence'],
  'GET /v1/sandboxes/:id/artifacts': ['Sandbox#listArtifacts'],
  'GET /v1/sandboxes/:id/artifacts/:sha256': ['Sandbox#downloadArtifact'],
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
    const { text, type } = await this.#call(method, path, opts, async (res) => ({
      text: await res.text(),
      type: res.headers.get('content-type') ?? '',
    }));
    if (!text) return null;
    return type.includes('json') ? JSON.parse(text) : text;
  }

  /**
   * One API call whose response body is bytes (the raw file and artifact routes): a Buffer, or
   * with `stream` the body as a web ReadableStream. A buffered read is part of the attempt, so
   * a body cut short is retried like any transport failure; a stream is handed over unread.
   * @param {string} method @param {string} path @param {RequestOptions & {stream?: boolean}} [opts]
   * @returns {Promise<Buffer|ReadableStream<Uint8Array>>}
   */
  requestBytes(method, path, opts = {}) {
    return this.#call(method, path, opts, async (res) => {
      if (opts.stream) return res.body ?? emptyStream();
      return Buffer.from(await res.arrayBuffer());
    });
  }

  async #call(method, path, opts, read) {
    const idempotent = opts.idempotent ?? IDEMPOTENT_METHODS.has(method);
    const attempts = idempotent ? this.retries + 1 : 1;
    const target = `${path}${qs(opts.query)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#send(method, target, opts, read);
      } catch (e) {
        if (opts.signal?.aborted || !e?.retryable || attempt + 1 >= attempts) throw e;
      }
      await sleep(retryDelay(attempt, this.retryDelayMs, this.maxRetryDelayMs), opts.signal);
    }
  }

  async #send(method, target, opts, read) {
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const init = { method, headers, signal: opts.signal };
    if (opts.bytes !== undefined) {
      headers['content-type'] = 'application/octet-stream';
      init.body = isBytes(opts.bytes) ? Buffer.from(opts.bytes) : bodyStream(opts.bytes);
      if (!isBytes(opts.bytes)) init.duplex = 'half';
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    let out;
    try {
      res = await fetch(`${this.baseUrl}${target}`, init);
      if (res.ok) out = await read(res);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw WorkboxApiError.transport(e, `${method} ${target.split('?')[0]}`);
    }
    if (!res.ok) throw await WorkboxApiError.fromResponse(res);
    return out;
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
   * @param {string} filePath @param {CallOptions} [opts]
   * @returns {Promise<{size: number, mode: number, isFile: boolean, isDir: boolean, mtimeMs: number, [k: string]: unknown}>}
   */
  statFile(filePath, opts = {}) {
    const query = { path: filePath, stat: '1' };
    return this.client.request('GET', `${this.path}/files`, { query, signal: opts.signal });
  }

  /**
   * Remove a file or an empty directory; `recursive` removes a tree.
   * @param {string} filePath @param {CallOptions & {recursive?: boolean}} [opts]
   * @returns {Promise<{path: string, removed: boolean}>}
   */
  removeFile(filePath, opts = {}) {
    const query = { path: filePath, recursive: opts.recursive ? '1' : undefined };
    return this.client.request('DELETE', `${this.path}/files`, { query, signal: opts.signal });
  }

  /**
   * Create a directory, with its parents unless `parents` is false.
   * @param {string} dir @param {CallOptions & {parents?: boolean, mode?: number}} [opts]
   * @returns {Promise<{path: string, created: boolean}>}
   */
  mkdir(dir, opts = {}) {
    return this.client.request('POST', `${this.path}/files/mkdir`, {
      body: { path: dir, parents: opts.parents, mode: opts.mode },
      signal: opts.signal,
      idempotent: true,
    });
  }

  /**
   * A file's bytes, of any size: a Buffer, or with `stream: true` a web ReadableStream.
   * @param {string} filePath @param {DownloadOptions} [opts]
   * @returns {Promise<Buffer|ReadableStream<Uint8Array>>}
   */
  download(filePath, opts = {}) {
    return this.client.requestBytes('GET', `${this.path}/files/raw`, {
      query: { path: filePath },
      signal: opts.signal,
      stream: opts.stream,
    });
  }

  /**
   * Replace a file with bytes (a string is UTF-8) or a stream (a web ReadableStream, a Node
   * readable or any async iterable of chunks). Bytes are retried; a stream is sent once.
   * @param {string} filePath
   * @param {Uint8Array|string|ReadableStream|AsyncIterable<Uint8Array|string>} data
   * @param {CallOptions & {mode?: number, mkdirs?: boolean}} [opts]
   * @returns {Promise<{path: string, bytes: number}>}
   */
  upload(filePath, data, opts = {}) {
    const query = {
      path: filePath,
      mode: opts.mode === undefined ? undefined : opts.mode.toString(8),
      mkdirs: opts.mkdirs ? '1' : undefined,
    };
    return this.client.request('PUT', `${this.path}/files/raw`, {
      query,
      bytes: data,
      signal: opts.signal,
      idempotent: isBytes(data),
    });
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

  /**
   * A handle on one session for plain HTTP control (no request is made).
   * @param {string} sessionId @returns {SandboxSession}
   */
  session(sessionId) {
    return new SandboxSession(this, sessionId);
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

  /**
   * The bytes of an artifact this sandbox holds: a Buffer, or with `stream: true` a stream.
   * @param {string} sha256 @param {DownloadOptions} [opts]
   * @returns {Promise<Buffer|ReadableStream<Uint8Array>>}
   */
  downloadArtifact(sha256, opts = {}) {
    return this.client.requestBytes('GET', `${this.path}/artifacts/${enc(sha256)}`, {
      signal: opts.signal,
      stream: opts.stream,
    });
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
 * One session of a sandbox, controlled over plain HTTP: read its output, wait for it, give it
 * input, signal, stop, resize and forget it.
 */
export class SandboxSession {
  /** @param {Sandbox} sandbox @param {string} sessionId */
  constructor(sandbox, sessionId) {
    this.sandbox = sandbox;
    this.client = sandbox.client;
    this.id = sessionId;
    this.path = `${sandbox.path}/sessions/${enc(sessionId)}`;
  }

  /**
   * The session with its exit status (`exited` is `{code, signal, at}` or null).
   * @param {CallOptions} [opts] @returns {Promise<{sessionId: string, exited: object|null, [k: string]: unknown}>}
   */
  info(opts = {}) {
    return this.client.request('GET', this.path, opts);
  }

  /**
   * Retained output from `fromSeq` (default 0), at most `maxBytes` (default 1 MiB, at most
   * 4 MiB) of it. Read again from `nextSeq` while `truncated` is true. With `encoding: 'text'`
   * each chunk's `data` is UTF-8 text instead of base64.
   * @param {CallOptions & {fromSeq?: number, maxBytes?: number, encoding?: 'base64'|'text'}} [opts]
   * @returns {Promise<{sessionId: string, chunks: {seq: number, stream: string, data: string}[], nextSeq: number, gap: object|null, truncated: boolean, exited: object|null}>}
   */
  output(opts = {}) {
    const query = { fromSeq: opts.fromSeq, maxBytes: opts.maxBytes, encoding: opts.encoding };
    return this.client.request('GET', `${this.path}/output`, { query, signal: opts.signal });
  }

  /**
   * Wait up to `timeoutMs` (default 30000, at most 300000) for the session to exit; resolves at
   * once if it already has. `exited` is null when the time ran out first.
   * @param {CallOptions & {timeoutMs?: number}} [opts]
   * @returns {Promise<{sessionId: string, exited: {code: number|null, signal: string|null, at: number}|null}>}
   */
  wait(opts = {}) {
    return this.client.request('POST', `${this.path}/wait`, {
      body: opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs },
      signal: opts.signal,
      idempotent: true,
    });
  }

  /**
   * Write to the session's stdin (a string is UTF-8); `eof` closes it. Sent once.
   * @param {Uint8Array|string|undefined} data @param {CallOptions & {eof?: boolean}} [opts]
   * @returns {Promise<{sessionId: string, bytes: number, eof: boolean}>}
   */
  input(data, opts = {}) {
    const body = { eof: opts.eof };
    if (data !== undefined) body.data = Buffer.from(data).toString('base64');
    return this.client.request('POST', `${this.path}/input`, { body, signal: opts.signal });
  }

  /**
   * Send a signal to the session's process group. Sent once.
   * @param {string} name e.g. `SIGTERM` @param {CallOptions} [opts]
   * @returns {Promise<{sessionId: string, signal: string}>}
   */
  signal(name, opts = {}) {
    return this.client.request('POST', `${this.path}/signal`, {
      body: { signal: name },
      signal: opts.signal,
    });
  }

  /**
   * SIGTERM, then SIGKILL after `graceMs`; resolves with the exit.
   * @param {CallOptions & {graceMs?: number}} [opts]
   * @returns {Promise<{sessionId: string, exited: object, escalated: boolean}>}
   */
  stop(opts = {}) {
    return this.client.request('POST', `${this.path}/stop`, {
      body: opts.graceMs === undefined ? {} : { graceMs: opts.graceMs },
      signal: opts.signal,
      idempotent: true,
    });
  }

  /**
   * Resize a PTY session.
   * @param {number} rows @param {number} cols @param {CallOptions} [opts]
   * @returns {Promise<{sessionId: string, rows: number, cols: number}>}
   */
  resize(rows, cols, opts = {}) {
    return this.client.request('POST', `${this.path}/resize`, {
      body: { rows, cols },
      signal: opts.signal,
      idempotent: true,
    });
  }

  /**
   * Forget an exited session (409 E_STATE while it runs).
   * @param {CallOptions} [opts] @returns {Promise<{sessionId: string, removed: boolean}>}
   */
  remove(opts = {}) {
    return this.client.request('DELETE', this.path, opts);
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

function isBytes(data) {
  return typeof data === 'string' || data instanceof Uint8Array || data instanceof ArrayBuffer;
}

/** A web ReadableStream over a stream or async iterable of chunks (strings are UTF-8). */
function bodyStream(source) {
  if (source instanceof globalThis.ReadableStream) return source;
  const it = source[Symbol.asyncIterator]();
  return new globalThis.ReadableStream({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(typeof value === 'string' ? Buffer.from(value) : value);
    },
    async cancel(reason) {
      await it.return?.(reason);
    },
  });
}

function emptyStream() {
  return new globalThis.ReadableStream({
    start(controller) {
      controller.close();
    },
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
