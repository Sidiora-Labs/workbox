import net from 'node:net';
import { once } from 'node:events';
import { Peer, ProtocolError, Codes, PROTOCOL_VERSION } from '@workbox/protocol';

/** Default runner socket inside the sandbox. */
export const DEFAULT_SOCKET = process.env.WORKBOX_SOCKET ?? '/run/workbox/runner.sock';
/** Shared outbox directory inside the sandbox. */
export const OUTBOX_DIR = process.env.WORKBOX_OUTBOX ?? '/run/workbox/outbox';
/** Shared inbox directory inside the sandbox. */
export const INBOX_DIR = process.env.WORKBOX_INBOX ?? '/run/workbox/inbox';

/**
 * NDJSON client to the runner socket. `broker.*` calls are relayed by the runner to the host.
 */
export class WbClient {
  /** @param {{socketPath?: string, peer?: import('@workbox/protocol').Peer, timeoutMs?: number}} [opts] */
  constructor(opts = {}) {
    this.socketPath = opts.socketPath ?? DEFAULT_SOCKET;
    this.peer = opts.peer ?? null;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.helloInfo = null;
    this.connecting = null;
  }

  /**
   * Connect and say hello as a local client. Concurrent callers share one connection, so a
   * command that fans out requests never leaks a second socket that keeps the process alive.
   */
  async connect() {
    if (this.peer) return this.helloInfo ?? { ok: true };
    this.connecting ??= this._open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async _open() {
    const socket = net.connect(this.socketPath);
    try {
      await once(socket, 'connect');
    } catch (e) {
      throw new ProtocolError(
        Codes.UNAVAILABLE,
        `cannot reach the workbox runner at ${this.socketPath}: ${e.message}`,
        { socketPath: this.socketPath },
      );
    }
    const peer = new Peer(socket, { name: 'wb' });
    try {
      this.helloInfo = await peer.request(
        'runner.hello',
        { protocol: PROTOCOL_VERSION, role: 'local' },
        { timeoutMs: 10_000 },
      );
    } catch (e) {
      peer.close();
      throw e;
    }
    this.peer = peer;
    return this.helloInfo;
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [opts]
   */
  async request(method, params = {}, opts = {}) {
    if (!this.peer) await this.connect();
    return this.peer.request(method, params, {
      timeoutMs: opts.timeoutMs ?? this.timeoutMs,
      signal: opts.signal,
    });
  }

  /** Subscribe to runner events (session output/exit). @param {(method: string, params: object) => void} fn */
  onEvent(fn) {
    const peer = this.peer;
    if (!peer) throw new ProtocolError(Codes.CLOSED, 'wb client is not connected');
    peer.on('event', fn);
    // Bound to the peer it subscribed on: safe to call twice and after close().
    return () => peer.off('event', fn);
  }

  close() {
    this.peer?.close();
    this.peer = null;
  }
}
