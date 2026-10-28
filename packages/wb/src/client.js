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
  }

  /** Connect and say hello as a local client. */
  async connect() {
    if (this.peer) return this.helloInfo ?? { ok: true };
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
    this.peer = new Peer(socket, { name: 'wb' });
    this.helloInfo = await this.peer.request(
      'runner.hello',
      { protocol: PROTOCOL_VERSION, role: 'local' },
      { timeoutMs: 10_000 },
    );
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
    if (!this.peer) throw new ProtocolError(Codes.CLOSED, 'wb client is not connected');
    this.peer.on('event', fn);
    return () => this.peer.off('event', fn);
  }

  close() {
    this.peer?.close();
    this.peer = null;
  }
}
