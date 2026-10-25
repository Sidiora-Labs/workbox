/**
 * Wire envelopes. Every line on the wire is exactly one of these.
 *   request:  { t: 'req', id, m, p }
 *   response: { t: 'res', id, ok: true, r } | { t: 'res', id, ok: false, e: { code, message, data? } }
 *   event:    { t: 'evt', m, p }
 */

/** @param {unknown} x */
function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * @param {string} id
 * @param {string} method
 * @param {unknown} params
 */
export function request(id, method, params) {
  return { t: 'req', id, m: method, p: params === undefined ? {} : params };
}

/**
 * @param {string} id
 * @param {unknown} result
 */
export function ok(id, result) {
  return { t: 'res', id, ok: true, r: result === undefined ? null : result };
}

/**
 * @param {string} id
 * @param {{code: string, message: string, data?: unknown}} error
 */
export function fail(id, error) {
  const e = { code: error.code, message: error.message };
  if (error.data !== undefined) e.data = error.data;
  return { t: 'res', id, ok: false, e };
}

/**
 * @param {string} method
 * @param {unknown} params
 */
export function event(method, params) {
  return { t: 'evt', m: method, p: params === undefined ? {} : params };
}

/** @param {unknown} x */
export function isRequest(x) {
  return (
    isPlainObject(x) &&
    x.t === 'req' &&
    typeof x.id === 'string' &&
    typeof x.m === 'string' &&
    x.m.length > 0
  );
}

/** @param {unknown} x */
export function isResponse(x) {
  if (!isPlainObject(x) || x.t !== 'res' || typeof x.id !== 'string') return false;
  if (x.ok === true) return true;
  return (
    x.ok === false &&
    isPlainObject(x.e) &&
    typeof x.e.code === 'string' &&
    typeof x.e.message === 'string'
  );
}

/** @param {unknown} x */
export function isEvent(x) {
  return isPlainObject(x) && x.t === 'evt' && typeof x.m === 'string' && x.m.length > 0;
}

/**
 * @param {unknown} x
 * @returns {'req'|'res'|'evt'|null}
 */
export function kindOf(x) {
  if (isRequest(x)) return 'req';
  if (isResponse(x)) return 'res';
  if (isEvent(x)) return 'evt';
  return null;
}
