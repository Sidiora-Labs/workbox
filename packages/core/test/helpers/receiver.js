import http from 'node:http';

/**
 * A real HTTP webhook receiver on 127.0.0.1. Request n is answered with `script[n]` (the last
 * entry repeats), or with what `script(hit, n)` returns: `{status, body?, headers?}`, or `'hang'`
 * to never answer. Every request is recorded with its raw body.
 * @param {Array<{status: number, body?: string, headers?: Record<string, string>}|'hang'>|((hit: object, n: number) => object|'hang')} [script]
 */
export async function receiver(script = [{ status: 204 }]) {
  /** @type {{method: string, url: string, headers: import('node:http').IncomingHttpHeaders, body: string, at: number}[]} */
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const hit = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        at: Date.now(),
      };
      hits.push(hit);
      const step =
        typeof script === 'function'
          ? script(hit, hits.length)
          : script[Math.min(hits.length, script.length) - 1];
      if (step === 'hang') return;
      res.writeHead(step.status, { 'content-type': 'text/plain', ...(step.headers ?? {}) });
      res.end(step.body ?? '');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    hits,
    port,
    url: `http://127.0.0.1:${port}/hook`,
    /** Hits whose path is `path`. @param {string} path */
    at: (path) => hits.filter((h) => h.url === path),
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * Wait until `fn` returns a truthy value (awaited), polling every 20 ms; reject after `ms`.
 * @template T
 * @param {() => T|Promise<T>} fn
 * @param {number} [ms]
 * @param {string} [what] named in the timeout error
 * @returns {Promise<T>}
 */
export async function until(fn, ms = 10_000, what = 'condition') {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
