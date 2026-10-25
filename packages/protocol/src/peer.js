import { EventEmitter, once } from 'node:events';
import { LineDecoder, encodeFrame, DEFAULT_MAX_LINE_BYTES } from './ndjson.js';
import {
  request as mkRequest,
  ok as mkOk,
  fail as mkFail,
  event as mkEvent,
  kindOf,
} from './envelope.js';
import { ProtocolError, Codes } from './errors.js';
import { newId } from './ids.js';

export const CANCEL_METHOD = '$cancel';
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @typedef {object} HandlerContext
 * @property {string} id request id
 * @property {string} method
 * @property {AbortSignal} signal aborted when the requester cancels or the peer closes
 * @property {Peer} peer
 */

/**
 * A symmetric request/response/event endpoint over one duplex byte stream.
 * Both sides may send requests; replies are matched by id. Events are fire-and-forget.
 *
 * Emits: 'event' (method, params), 'close' (error|undefined), 'handlerError' (error, method),
 * 'protocolError' (error).
 */
export class Peer extends EventEmitter {
  /**
   * @param {import('node:stream').Duplex} stream
   * @param {{name?: string, maxLineBytes?: number, defaultTimeoutMs?: number}} [opts]
   */
  constructor(stream, opts = {}) {
    super();
    this.name = opts.name ?? 'peer';
    this.stream = stream;
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.decoder = new LineDecoder({ maxLineBytes: opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES });
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout|null, method: string}>} */
    this.pending = new Map();
    /** @type {Map<string, (params: unknown, ctx: HandlerContext) => unknown>} */
    this.handlers = new Map();
    /** @type {Map<string, AbortController>} */
    this.inflight = new Map();
    this.closed = false;
    this.closeError = undefined;
    /** @type {Promise<void>} */
    this.drain = Promise.resolve();
    this.stats = { sent: 0, received: 0, bytesOut: 0, bytesIn: 0 };

    stream.on('data', (chunk) => this._onData(chunk));
    stream.on('error', (err) => this._close(err));
    stream.on('close', () => this._close());
    stream.on('end', () => this._close());
  }

  /**
   * Register a request handler. The handler's return value becomes the result; a thrown
   * ProtocolError becomes an error response with its code; any other throw becomes E_INTERNAL.
   * @param {string} method
   * @param {(params: any, ctx: HandlerContext) => unknown} fn
   */
  handle(method, fn) {
    this.handlers.set(method, fn);
    return this;
  }

  /** @param {string} method */
  unhandle(method) {
    this.handlers.delete(method);
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   * @returns {Promise<any>}
   */
  request(method, params, opts = {}) {
    if (this.closed)
      return Promise.reject(new ProtocolError(Codes.CLOSED, `${this.name} is closed`));
    const id = newId();
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null, method };
      const finish = (fn, value) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      entry.resolve = (v) => finish(resolve, v);
      entry.reject = (e) => finish(reject, e);
      const onAbort = () => {
        this._send(mkEvent(CANCEL_METHOD, { id })).catch(() => {});
        entry.reject(new ProtocolError(Codes.CANCELLED, `${method} cancelled`));
      };
      if (opts.signal) {
        if (opts.signal.aborted) return onAbort();
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this._send(mkEvent(CANCEL_METHOD, { id })).catch(() => {});
          entry.reject(
            new ProtocolError(Codes.TIMEOUT, `${method} timed out after ${timeoutMs} ms`, {
              method,
              timeoutMs,
            }),
          );
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this._send(mkRequest(id, method, params)).catch((e) => entry.reject(ProtocolError.from(e)));
    });
  }

  /**
   * Send an event. Resolves once the bytes are handed to the stream (after any backpressure).
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    if (this.closed)
      return Promise.reject(new ProtocolError(Codes.CLOSED, `${this.name} is closed`));
    return this._send(mkEvent(method, params));
  }

  /** @param {Error} [err] */
  close(err) {
    this._close(err);
    if (!this.stream.destroyed) this.stream.destroy();
  }

  /** Resolves when the peer has closed. */
  whenClosed() {
    if (this.closed) return Promise.resolve(this.closeError);
    return once(this, 'close').then(([e]) => e);
  }

  // ── internals ──

  /** @param {object} obj */
  _send(obj) {
    const buf = encodeFrame(obj);
    const run = async () => {
      if (this.closed || this.stream.destroyed)
        throw new ProtocolError(Codes.CLOSED, `${this.name} is closed`);
      this.stats.sent++;
      this.stats.bytesOut += buf.length;
      const ok = this.stream.write(buf);
      if (!ok) {
        await Promise.race([once(this.stream, 'drain'), once(this, 'close')]);
      }
    };
    const p = this.drain.then(run, run);
    this.drain = p.catch(() => {});
    return p;
  }

  /** @param {Buffer} chunk */
  _onData(chunk) {
    this.stats.bytesIn += chunk.length;
    let msgs;
    try {
      msgs = this.decoder.feed(chunk);
    } catch (e) {
      this.emit('protocolError', e);
      this.close(e);
      return;
    }
    for (const msg of msgs) {
      this.stats.received++;
      this._dispatch(msg);
    }
  }

  /** @param {unknown} msg */
  _dispatch(msg) {
    switch (kindOf(msg)) {
      case 'req':
        return this._onRequest(msg);
      case 'res':
        return this._onResponse(msg);
      case 'evt':
        if (msg.m === CANCEL_METHOD) {
          const ac = this.inflight.get(msg.p && msg.p.id);
          if (ac) ac.abort();
          return;
        }
        this.emit('event', msg.m, msg.p);
        return;
      default:
        this.emit(
          'protocolError',
          new ProtocolError(Codes.PARSE, 'malformed envelope', { received: summarize(msg) }),
        );
    }
  }

  async _onRequest(msg) {
    const fn = this.handlers.get(msg.m);
    if (!fn) {
      await this._safeSend(
        mkFail(
          msg.id,
          new ProtocolError(Codes.UNKNOWN_METHOD, `unknown method ${msg.m}`, { method: msg.m }),
        ),
      );
      return;
    }
    const ac = new AbortController();
    this.inflight.set(msg.id, ac);
    try {
      const result = await fn(msg.p, { id: msg.id, method: msg.m, signal: ac.signal, peer: this });
      if (!ac.signal.aborted) await this._safeSend(mkOk(msg.id, result));
    } catch (e) {
      const pe = ProtocolError.from(e);
      if (pe.code === Codes.INTERNAL) this.emit('handlerError', e, msg.m);
      if (!ac.signal.aborted) await this._safeSend(mkFail(msg.id, pe));
    } finally {
      this.inflight.delete(msg.id);
    }
  }

  _onResponse(msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.ok) entry.resolve(msg.r);
    else entry.reject(new ProtocolError(msg.e.code, msg.e.message, msg.e.data));
  }

  _safeSend(obj) {
    return this._send(obj).catch(() => {});
  }

  /** @param {Error} [err] */
  _close(err) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    const reason = new ProtocolError(
      Codes.CLOSED,
      err ? `${this.name} closed: ${err.message}` : `${this.name} closed`,
    );
    for (const entry of this.pending.values()) entry.reject(reason);
    this.pending.clear();
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.emit('close', err);
  }
}

function summarize(x) {
  try {
    const s = JSON.stringify(x);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  } catch {
    return String(x);
  }
}
