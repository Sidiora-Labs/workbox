export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * @typedef {object} Logger
 * @property {(msg: string, data?: object) => void} debug
 * @property {(msg: string, data?: object) => void} info
 * @property {(msg: string, data?: object) => void} warn
 * @property {(msg: string, data?: object) => void} error
 * @property {(component: string) => Logger} child
 * @property {string} component
 * @property {string} level
 */

/**
 * Structured JSON-lines logger. One line per record: ts, level, component, msg, then data.
 * Errors in data are serialised to name, message, code and stack. A redactor, when given,
 * is applied to the finished line so secrets never reach the stream.
 * @param {{component?: string, level?: keyof typeof LEVELS, stream?: NodeJS.WritableStream, redactor?: {apply: (s: string) => string}, clock?: () => number}} [opts]
 * @returns {Logger}
 */
export function createLogger(opts = {}) {
  const component = opts.component ?? 'workbox';
  const level = opts.level ?? (process.env.WORKBOX_LOG_LEVEL || 'info');
  if (!(level in LEVELS)) throw new RangeError(`unknown log level ${level}`);
  const stream = opts.stream ?? process.stderr;
  const clock = opts.clock ?? Date.now;
  const threshold = LEVELS[level];

  const write = (lvl, msg, data) => {
    if (LEVELS[lvl] < threshold) return;
    const record = { ts: new Date(clock()).toISOString(), level: lvl, component, msg: String(msg) };
    if (data && typeof data === 'object') Object.assign(record, serialise(data));
    let line = `${JSON.stringify(record)}\n`;
    if (opts.redactor) line = opts.redactor.apply(line);
    stream.write(line);
  };

  return {
    component,
    level,
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    child: (sub) => createLogger({ ...opts, component: `${component}.${sub}`, level }),
  };
}

/** @param {object} data */
function serialise(data) {
  const out = {};
  for (const [k, val] of Object.entries(data))
    out[k] = val instanceof Error ? errorToJSON(val) : val;
  return out;
}

/** @param {Error & {code?: string, data?: unknown}} err */
export function errorToJSON(err) {
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) out.code = err.code;
  if (err.data !== undefined) out.data = err.data;
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 8).join('\n');
  if (err.cause instanceof Error) out.cause = errorToJSON(err.cause);
  return out;
}

/** A logger that discards everything; for tests and quiet tools. */
export function nullLogger() {
  return createLogger({ level: 'silent', stream: { write: () => true } });
}
