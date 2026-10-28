import { WorkboxApiError } from './errors.js';

/**
 * JavaScript client for the Workbox API (task 3.2). Idempotent calls retry with jitter on
 * 5xx/network errors; every method accepts an AbortSignal.
 */
export class WorkboxClient {
  /**
   * @param {{baseUrl: string, token: string, fetch?: typeof fetch, retries?: number, retryDelayMs?: number}} opts
   */
  constructor(opts) {
    if (!opts?.baseUrl) throw new Error('baseUrl is required');
    this.baseUrl = String(opts.baseUrl).replace(/\/$/, '');
    this.token = opts.token ?? '';
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 100;
  }

  /**
   * @param {string} method @param {string} path
   * @param {{body?: unknown, signal?: AbortSignal, idempotent?: boolean}} [opts]
   */
  async request(method, path, opts = {}) {
    const idempotent = opts.idempotent ?? (method === 'GET' || method === 'DELETE');
    let last;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const res = await this.fetch(`${this.baseUrl}${path}`, {
          method,
          signal: opts.signal,
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        if (res.ok) {
          const text = await res.text();
          return text ? JSON.parse(text) : null;
        }
        throw await WorkboxApiError.fromResponse(res);
      } catch (e) {
        last = e;
        const retryable = e instanceof WorkboxApiError ? e.retryable : e?.name !== 'AbortError';
        if (!idempotent || !retryable || attempt === this.retries) break;
        await new Promise((r) => {
          setTimeout(r, this.retryDelayMs * 2 ** attempt + Math.random() * this.retryDelayMs);
        });
      }
    }
    throw last;
  }

  /** @param {object} [input] @param {{signal?: AbortSignal}} [opts] */
  async createSandbox(input = {}, opts = {}) {
    const row = await this.request('POST', '/v1/sandboxes', {
      body: input,
      signal: opts.signal,
      idempotent: Boolean(input.idempotencyKey),
    });
    return new Sandbox(this, row.id, row);
  }

  /** @param {{cursor?: string, limit?: number}} [opts] */
  listSandboxes(opts = {}) {
    const q = qs({ cursor: opts.cursor, limit: opts.limit });
    return this.request('GET', `/v1/sandboxes${q}`);
  }

  /** @param {string} id */
  sandbox(id) {
    return new Sandbox(this, id);
  }

  reconcile() {
    return this.request('POST', '/v1/reconcile', { body: {}, idempotent: true });
  }

  /** @param {{status?: string}} [opts] */
  listAsks(opts = {}) {
    return this.request('GET', `/v1/asks${qs({ status: opts.status })}`);
  }

  /** @param {string} askId @param {unknown} answer */
  answerAsk(askId, answer) {
    return this.request('POST', `/v1/asks/${askId}/answer`, { body: { answer } });
  }

  health() {
    return this.request('GET', '/healthz');
  }
}

/** A handle on one sandbox. */
export class Sandbox {
  /** @param {WorkboxClient} client @param {string} id @param {object} [row] */
  constructor(client, id, row) {
    this.client = client;
    this.id = id;
    this.row = row ?? null;
  }

  inspect() {
    return this.client.request('GET', `/v1/sandboxes/${this.id}`);
  }

  destroy() {
    return this.client.request('DELETE', `/v1/sandboxes/${this.id}`);
  }

  /** @param {string} [reason] */
  drain(reason) {
    return this.client.request('POST', `/v1/sandboxes/${this.id}/drain`, {
      body: { reason },
      idempotent: true,
    });
  }

  /** @param {object} opts exec options ({argv, timeoutMs, ...}) */
  exec(opts) {
    return this.client.request('POST', `/v1/sandboxes/${this.id}/exec`, {
      body: opts,
      signal: opts?.signal,
    });
  }

  /** @param {string} filePath @param {{offset?: number, length?: number}} [opts] */
  readFile(filePath, opts = {}) {
    return this.client.request(
      'GET',
      `/v1/sandboxes/${this.id}/files${qs({ path: filePath, offset: opts.offset, length: opts.length })}`,
    );
  }

  /** @param {string} dir */
  listFiles(dir) {
    return this.client.request(
      'GET',
      `/v1/sandboxes/${this.id}/files${qs({ path: dir, list: '1' })}`,
    );
  }

  /** @param {string} filePath @param {string} dataBase64 @param {object} [opts] */
  writeFile(filePath, dataBase64, opts = {}) {
    return this.client.request('PUT', `/v1/sandboxes/${this.id}/files`, {
      body: { path: filePath, data: dataBase64, ...opts },
    });
  }

  /** @param {object} opts session.start params */
  startSession(opts) {
    return this.client.request('POST', `/v1/sandboxes/${this.id}/sessions`, { body: opts });
  }

  listSessions() {
    return this.client.request('GET', `/v1/sandboxes/${this.id}/sessions`);
  }

  /**
   * Stream a session over WebSocket as an async iterator of events.
   * @param {string} sessionId @param {{signal?: AbortSignal, WebSocketImpl?: typeof WebSocket}} [opts]
   */
  async *sessionEvents(sessionId, opts = {}) {
    const WS = opts.WebSocketImpl ?? globalThis.WebSocket;
    const url = `${this.client.baseUrl.replace(/^http/, 'ws')}/v1/sandboxes/${this.id}/sessions/${sessionId}/ws?token=${encodeURIComponent(this.client.token)}`;
    const ws = new WS(url);
    const queue = [];
    let wake = null;
    let done = false;
    ws.addEventListener('message', (ev) => {
      queue.push(JSON.parse(String(ev.data)));
      wake?.();
    });
    ws.addEventListener('close', () => {
      done = true;
      wake?.();
    });
    opts.signal?.addEventListener('abort', () => ws.close());
    try {
      for (;;) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (done) return;
        await new Promise((r) => {
          wake = r;
        });
      }
    } finally {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  listEvidence() {
    return this.client.request('GET', `/v1/sandboxes/${this.id}/evidence`);
  }

  listArtifacts() {
    return this.client.request('GET', `/v1/sandboxes/${this.id}/artifacts`);
  }

  listCheckpoints() {
    return this.client.request('GET', `/v1/sandboxes/${this.id}/checkpoints`);
  }

  /** @param {object} [opts] */
  createCheckpoint(opts = {}) {
    return this.client.request('POST', `/v1/sandboxes/${this.id}/checkpoints`, { body: opts });
  }

  listEvents() {
    return this.client.request('GET', `/v1/sandboxes/${this.id}/events`);
  }
}

function qs(obj) {
  const parts = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null);
  return parts.length
    ? `?${new URLSearchParams(Object.fromEntries(parts.map(([k, v]) => [k, String(v)]))).toString()}`
    : '';
}
