/** Error thrown for every non-2xx API response and for transport failures. */
export class WorkboxApiError extends Error {
  /**
   * @param {{status: number, code: string, message: string, details?: unknown, requestId?: string|null}} info
   */
  constructor(info) {
    super(info.message);
    this.name = 'WorkboxApiError';
    this.status = info.status;
    this.code = info.code;
    this.details = info.details;
    this.requestId = info.requestId ?? null;
    this.retryable = info.status >= 500 || info.status === 429;
  }

  /** @param {Response} res */
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
}
