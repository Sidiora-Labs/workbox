/**
 * Error codes shared by every Workbox process. Codes are stable strings; messages are for humans.
 */
export const Codes = Object.freeze({
  PARSE: 'E_PARSE',
  LINE_TOO_LONG: 'E_LINE_TOO_LONG',
  TIMEOUT: 'E_TIMEOUT',
  CLOSED: 'E_CLOSED',
  CANCELLED: 'E_CANCELLED',
  UNKNOWN_METHOD: 'E_UNKNOWN_METHOD',
  INVALID_PARAMS: 'E_INVALID_PARAMS',
  INTERNAL: 'E_INTERNAL',
  DENIED: 'E_DENIED',
  NOT_FOUND: 'E_NOT_FOUND',
  CONFLICT: 'E_CONFLICT',
  GAP: 'E_GAP',
  UNSUPPORTED: 'E_UNSUPPORTED',
  QUARANTINED: 'E_QUARANTINED',
  BUSY: 'E_BUSY',
  LIMIT: 'E_LIMIT',
  STATE: 'E_STATE',
  UNAVAILABLE: 'E_UNAVAILABLE',
});

const KNOWN = new Set(Object.values(Codes));

export class ProtocolError extends Error {
  /**
   * @param {string} code one of Codes
   * @param {string} message
   * @param {Record<string, unknown>} [data] machine-readable detail, must be JSON-serialisable
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'ProtocolError';
    this.code = KNOWN.has(code) ? code : Codes.INTERNAL;
    if (data !== undefined) this.data = data;
  }

  /** @returns {{code: string, message: string, data?: Record<string, unknown>}} */
  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.data !== undefined) out.data = this.data;
    return out;
  }

  /** @param {{code?: string, message?: string, data?: Record<string, unknown>}} e */
  static from(e) {
    if (e instanceof ProtocolError) return e;
    if (e && typeof e === 'object' && typeof e.code === 'string' && KNOWN.has(e.code)) {
      return new ProtocolError(e.code, String(e.message ?? e.code), e.data);
    }
    return new ProtocolError(Codes.INTERNAL, e && e.message ? String(e.message) : 'internal error');
  }
}

/** @param {unknown} e */
export function isProtocolError(e) {
  return e instanceof ProtocolError;
}
