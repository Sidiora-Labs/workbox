import { Codes, ProtocolError } from '@workbox/protocol';

const STATUS = Object.freeze({
  [Codes.NOT_FOUND]: 404,
  [Codes.CONFLICT]: 409,
  [Codes.INVALID_PARAMS]: 400,
  [Codes.STATE]: 409,
  [Codes.DENIED]: 403,
  [Codes.UNAVAILABLE]: 503,
  [Codes.TIMEOUT]: 504,
  [Codes.LIMIT]: 429,
  [Codes.UNSUPPORTED]: 501,
  [Codes.QUARANTINED]: 423,
  [Codes.BUSY]: 409,
  [Codes.GAP]: 416,
  [Codes.UNKNOWN_METHOD]: 404,
  [Codes.CLOSED]: 503,
  [Codes.CANCELLED]: 499,
  [Codes.PARSE]: 400,
  [Codes.LINE_TOO_LONG]: 413,
  [Codes.INTERNAL]: 500,
});

/**
 * The host-side error type. Codes are the protocol codes so a WorkboxError crosses the wire
 * unchanged; `status` is the HTTP status the server answers with.
 */
export class WorkboxError extends Error {
  /**
   * @param {string} code one of protocol Codes
   * @param {string} message
   * @param {{data?: Record<string, unknown>, cause?: unknown}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'WorkboxError';
    this.code = code in STATUS ? code : Codes.INTERNAL;
    this.status = STATUS[this.code];
    if (opts.data !== undefined) this.data = opts.data;
  }

  /** @returns {{code: string, message: string, data?: Record<string, unknown>}} */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.data !== undefined) out.data = this.data;
    return out;
  }

  /** @returns {ProtocolError} the same failure in wire form */
  toProtocol() {
    return new ProtocolError(this.code, this.message, this.data);
  }

  /**
   * Normalise anything thrown into a WorkboxError without leaking stacks of foreign errors.
   * @param {unknown} e
   */
  static from(e) {
    if (e instanceof WorkboxError) return e;
    if (e instanceof ProtocolError) return new WorkboxError(e.code, e.message, { data: e.data });
    if (e && typeof e === 'object' && typeof e.code === 'string' && e.code in STATUS) {
      return new WorkboxError(e.code, String(e.message ?? e.code), { data: e.data });
    }
    const message = e instanceof Error ? e.message : String(e);
    return new WorkboxError(Codes.INTERNAL, message, { cause: e });
  }
}

/** @param {string} code */
export function httpStatusFor(code) {
  return STATUS[code] ?? 500;
}

const make = (code) => (message, data) =>
  new WorkboxError(code, message, data === undefined ? {} : { data });

/** Factories for the common failures. */
export const E = Object.freeze({
  notFound: make(Codes.NOT_FOUND),
  conflict: make(Codes.CONFLICT),
  invalid: make(Codes.INVALID_PARAMS),
  state: make(Codes.STATE),
  denied: make(Codes.DENIED),
  unavailable: make(Codes.UNAVAILABLE),
  timeout: make(Codes.TIMEOUT),
  limit: make(Codes.LIMIT),
  unsupported: make(Codes.UNSUPPORTED),
  quarantined: make(Codes.QUARANTINED),
  busy: make(Codes.BUSY),
  internal: make(Codes.INTERNAL),
});
