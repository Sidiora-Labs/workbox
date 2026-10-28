/**
 * Error thrown for every non-2xx API response, for transport failures (`status` 0) and for an
 * `error` message on a session WebSocket.
 */
export class WorkboxApiError extends Error {
  /**
   * @param {{status: number, code: string, message: string, details?: unknown, requestId?: string|null, retryable?: boolean, cause?: unknown}} info
   *   `retryable` defaults to true for transport failures, 5xx and 429
   */
  constructor(info) {
    super(info.message, info.cause === undefined ? undefined : { cause: info.cause });
    this.name = 'WorkboxApiError';
    this.status = info.status;
    this.code = info.code;
    this.details = info.details;
    this.requestId = info.requestId ?? null;
    this.retryable =
      info.retryable ?? (info.status === 0 || info.status >= 500 || info.status === 429);
  }

  /** @param {Response} res @returns {Promise<WorkboxApiError>} */
  static async fromResponse(res) {
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error body
    }
    const err = body?.error ?? {};
    return new WorkboxApiError({
      status: res.status,
      code: err.code ?? 'E_INTERNAL',
      message: err.message ?? `HTTP ${res.status}`,
      details: err.details,
      requestId: err.requestId ?? res.headers.get('x-request-id'),
    });
  }

  /**
   * A request that never produced an HTTP response (refused, reset, dropped mid-body).
   * @param {unknown} cause the fetch failure @param {string} what e.g. `GET /v1/sandboxes`
   * @returns {WorkboxApiError}
   */
  static transport(cause, what) {
    const reason =
      /** @type {any} */ (cause)?.cause?.message ?? /** @type {any} */ (cause)?.message;
    return new WorkboxApiError({
      status: 0,
      code: 'E_UNAVAILABLE',
      message: `${what} failed: ${reason ?? 'network error'}`,
      cause,
    });
  }
}
