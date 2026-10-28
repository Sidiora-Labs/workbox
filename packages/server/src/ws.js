import { createHash } from 'node:crypto';

/** RFC 6455 handshake GUID. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Defaults: ping every 30 s, drop a consumer with 1 MiB unsent, refuse frames over 1 MiB. */
export const WS_DEFAULTS = Object.freeze({
  heartbeatMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
  maxFrameBytes: 1024 * 1024,
});

/** @param {string} key the client's Sec-WebSocket-Key */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
}

/**
 * Answer an upgrade request with a plain HTTP status and close the socket (no upgrade happens).
 * @param {import('node:net').Socket} socket @param {number} status @param {string} reason
 */
export function rejectUpgrade(socket, status, reason) {
  const body = JSON.stringify({ error: { code: 'E_DENIED', message: reason } });
  socket.end(
    `HTTP/1.1 ${status} ${reason.replace(/[\r\n]/g, ' ')}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

/**
 * Minimal RFC 6455 server-side socket: text frames out; masked text, ping, pong and close in.
 * A heartbeat pings the client and drops it after a missed pong; a consumer whose unsent bytes
 * exceed `maxBufferedBytes` is dropped instead of buffering without bound.
 */
export class WsSocket {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} [head]
   * @param {{heartbeatMs?: number, maxBufferedBytes?: number, maxFrameBytes?: number}} [opts]
   */
  constructor(socket, head, opts = {}) {
    this.socket = socket;
    this.opts = { ...WS_DEFAULTS, ...opts };
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.msgFn = null;
    this.closeFns = [];
    this.closed = false;
    this.dropped = false;
    this.awaitingPong = false;
    socket.setNoDelay?.(true);
    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    this.timer = setInterval(() => this._beat(), this.opts.heartbeatMs);
    this.timer.unref?.();
    if (this.buf.length) this._drain();
  }

  /** @param {string} text */
  send(text) {
    if (this.closed) return false;
    if (this.socket.writableLength > this.opts.maxBufferedBytes) {
      this.dropped = true;
      this.terminate();
      return false;
    }
    this.socket.write(frame(0x1, Buffer.from(text)));
    return true;
  }

  /** @param {(text: string) => void} fn */
  onMessage(fn) {
    this.msgFn = fn;
  }

  /** @param {() => void} fn */
  onClose(fn) {
    if (this.closed) fn();
    else this.closeFns.push(fn);
  }

  /** Close cleanly with a status code. @param {number} [code] */
  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.end(frame(0x8, payload));
    this._closed();
  }

  /** Drop the connection without a closing handshake. */
  terminate() {
    this.socket.destroy();
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const fn of this.closeFns.splice(0)) fn();
  }

  _beat() {
    if (this.awaitingPong) {
      this.terminate();
      return;
    }
    this.awaitingPong = true;
    if (!this.socket.destroyed) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    this._drain();
  }

  _drain() {
    while (!this.closed) {
      const f = parseFrame(this.buf);
      if (!f) return;
      if (f.len > this.opts.maxFrameBytes || !f.masked) {
        this.close(f.masked ? 1009 : 1002);
        return;
      }
      if (this.buf.length < f.off + f.len) return;
      const payload = unmask(this.buf.subarray(f.off, f.off + f.len), f.mask);
      this.buf = this.buf.subarray(f.off + f.len);
      this._frame(f.opcode, payload);
    }
  }

  _frame(opcode, payload) {
    if (opcode === 0x8) this.close();
    else if (opcode === 0x9) this.socket.write(frame(0xa, payload));
    else if (opcode === 0xa) this.awaitingPong = false;
    else if (opcode === 0x1) this.msgFn?.(payload.toString('utf8'));
  }
}

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  if (!masked) return { opcode, masked, len, off, mask: null };
  if (buf.length < off + 4) return null;
  return { opcode, masked, len, off: off + 4, mask: buf.subarray(off, off + 4) };
}

function unmask(data, mask) {
  const out = Buffer.from(data);
  if (mask) for (let i = 0; i < out.length; i++) out[i] ^= mask[i % 4];
  return out;
}
