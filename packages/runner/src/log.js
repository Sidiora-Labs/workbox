/**
 * Minimal JSON-lines logger for the runner. Lines go to stderr, which the host appends to the
 * sandbox launch.log. The runner cannot import @workbox/core, so this stays self-contained.
 */
export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/**
 * @param {{level?: keyof typeof LEVELS, stream?: {write: (s: string) => unknown}, clock?: () => number, component?: string}} [opts]
 */
export function createLog(opts = {}) {
  const level = opts.level ?? 'info';
  if (!(level in LEVELS)) throw new RangeError(`unknown log level ${level}`);
  const stream = opts.stream ?? process.stderr;
  const clock = opts.clock ?? Date.now;
  const component = opts.component ?? 'runner';
  const threshold = LEVELS[level];
  const write = (lvl, msg, data) => {
    if (LEVELS[lvl] < threshold) return;
    const rec = { ts: new Date(clock()).toISOString(), level: lvl, component, msg: String(msg) };
    if (data && typeof data === 'object') {
      for (const [k, val] of Object.entries(data))
        rec[k] =
          val instanceof Error ? { name: val.name, message: val.message, code: val.code } : val;
    }
    stream.write(`${JSON.stringify(rec)}\n`);
  };
  return {
    level,
    component,
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
  };
}
