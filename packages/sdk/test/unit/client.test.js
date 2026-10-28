import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SCOPE_MATRIX } from '@workbox/server';
import { ROUTES, Sandbox, SessionStream, WorkboxClient, retryDelay } from '../../src/client.js';
import { WorkboxApiError } from '../../src/errors.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A real HTTP server on 127.0.0.1 that answers request n with `script[n]` (the last entry
 * repeats) and records every request. `'drop'` destroys the connection unanswered, `'hang'`
 * never answers.
 */
async function scripted(script) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        at: Date.now(),
        body: text ? JSON.parse(text) : undefined,
      });
      const step = script[Math.min(hits.length, script.length) - 1];
      if (step === 'drop') return req.socket.destroy();
      if (step === 'hang') return undefined;
      res.writeHead(step.status, { 'content-type': 'application/json', connection: 'close' });
      return res.end(JSON.stringify(step.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    hits,
    server,
    base,
    client: (opts = {}) =>
      new WorkboxClient({ baseUrl: `${base}/`, token: 'tok', retryDelayMs: 5, ...opts }),
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

const unavailable = { status: 503, body: { error: { code: 'E_UNAVAILABLE', message: 'down' } } };
const page = { status: 200, body: { items: [], cursor: null, complete: true } };

test('every server route maps to SDK methods that exist', () => {
  const serverRoutes = [...Object.keys(SCOPE_MATRIX), 'GET /healthz', 'GET /readyz'].sort();
  assert.deepEqual(Object.keys(ROUTES).sort(), serverRoutes);
  const classes = { WorkboxClient, Sandbox };
  for (const [route, methods] of Object.entries(ROUTES))
    for (const name of methods) {
      const [cls, method] = name.split('#');
      assert.equal(typeof classes[cls].prototype[method], 'function', `${route} -> ${name}`);
    }
});

test('an idempotent GET retries a 503 and a dropped connection, then succeeds', async () => {
  const srv = await scripted([unavailable, 'drop', page]);
  try {
    const out = await srv.client().listSandboxes({ limit: 5 });
    assert.equal(out.complete, true);
    assert.equal(srv.hits.length, 3);
    assert.ok(srv.hits.every((h) => h.url === '/v1/sandboxes?limit=5'));
    assert.equal(srv.hits[0].headers.authorization, 'Bearer tok');
  } finally {
    await srv.close();
  }
});

test('retries stop after `retries` with the last error', async () => {
  const srv = await scripted([unavailable]);
  try {
    await assert.rejects(
      srv.client({ retries: 2 }).sandbox('sb-1').inspect(),
      (e) => e instanceof WorkboxApiError && e.status === 503 && e.code === 'E_UNAVAILABLE',
    );
    assert.equal(srv.hits.length, 3);
  } finally {
    await srv.close();
  }
});

test('non-idempotent calls are sent once on a 503 and on a dropped connection', async () => {
  const down = await scripted([unavailable]);
  const dropped = await scripted(['drop']);
  try {
    const box = down.client({ retries: 3 }).sandbox('sb-1');
    await assert.rejects(box.exec({ argv: ['true'] }), (e) => e.status === 503);
    await assert.rejects(box.createCheckpoint({ name: 'x' }), (e) => e.status === 503);
    await assert.rejects(box.startSession({ argv: ['sh'] }), (e) => e.status === 503);
    await assert.rejects(box.writeFile('/a', 'x', { append: true }), (e) => e.status === 503);
    assert.deepEqual(
      down.hits.map((h) => `${h.method} ${h.url}`),
      [
        'POST /v1/sandboxes/sb-1/exec',
        'POST /v1/sandboxes/sb-1/checkpoints',
        'POST /v1/sandboxes/sb-1/sessions',
        'PUT /v1/sandboxes/sb-1/files',
      ],
    );
    await assert.rejects(
      dropped.client({ retries: 3 }).answerAsk('ask-1', 'yes'),
      (e) => e instanceof WorkboxApiError && e.status === 0 && e.code === 'E_UNAVAILABLE',
    );
    assert.equal(dropped.hits.length, 1);
  } finally {
    await down.close();
    await dropped.close();
  }
});

test('create carries one idempotency key and resends that same key on every retry', async () => {
  const flaky = await scripted(['drop', unavailable, { status: 201, body: { id: 'sb-1' } }]);
  const once = await scripted([{ status: 201, body: { id: 'sb-2', state: 'READY' } }]);
  try {
    const sb = await flaky.client().createSandbox({ name: 'one' });
    assert.equal(sb.id, 'sb-1');
    assert.equal(flaky.hits.length, 3);
    const keys = flaky.hits.map((h) => h.body.idempotencyKey);
    assert.match(keys[0], UUID);
    assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
    assert.ok(flaky.hits.every((h) => h.body.name === 'one'));
    const mine = await once.client().createSandbox({ idempotencyKey: 'mine' });
    assert.equal(mine.row.state, 'READY');
    assert.equal(once.hits[0].body.idempotencyKey, 'mine');
  } finally {
    await flaky.close();
    await once.close();
  }
});

test('a 4xx is never retried and maps to a WorkboxApiError', async () => {
  const srv = await scripted([
    { status: 403, body: { error: { code: 'E_DENIED', message: 'no', requestId: 'r-1' } } },
  ]);
  try {
    await assert.rejects(
      srv.client().listSandboxes(),
      (e) => e.status === 403 && e.code === 'E_DENIED' && e.requestId === 'r-1' && !e.retryable,
    );
    assert.equal(srv.hits.length, 1);
  } finally {
    await srv.close();
  }
});

test('a file write is retried unless it appends; text and bytes go as base64', async () => {
  const srv = await scripted([unavailable, { status: 200, body: { bytes: 2 } }]);
  try {
    const box = srv.client().sandbox('sb/1');
    assert.equal((await box.writeFile('/a', 'hi', { mkdirs: true })).bytes, 2);
    assert.equal(srv.hits.length, 2);
    assert.equal(srv.hits[1].url, '/v1/sandboxes/sb%2F1/files');
    assert.deepEqual(srv.hits[1].body, { mkdirs: true, path: '/a', data: b64('hi') });
    await box.writeFile('/b', new Uint8Array([0, 255]));
    assert.equal(srv.hits[2].body.data, Buffer.from([0, 255]).toString('base64'));
  } finally {
    await srv.close();
  }
});

test('an AbortSignal cuts a hanging request, a pending backoff and a pre-aborted call', async () => {
  const hang = await scripted(['hang']);
  const down = await scripted([unavailable]);
  try {
    await assert.rejects(
      hang.client().health({ signal: AbortSignal.timeout(100) }),
      (e) => e.name === 'TimeoutError',
    );
    assert.equal(hang.hits.length, 1);
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = down.client({ retryDelayMs: 10_000 }).listAsks({ signal: ac.signal });
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(pending, (e) => e.name === 'AbortError');
    assert.ok(Date.now() - t0 < 3000, 'abort did not wait out the backoff');
    assert.equal(down.hits.length, 1);
    await assert.rejects(
      down.client().reconcile({ signal: AbortSignal.abort() }),
      (e) => e.name === 'AbortError',
    );
    assert.equal(down.hits.length, 1);
  } finally {
    await hang.close();
    await down.close();
  }
});

test('events() pages with afterSeq until a page comes back empty', async () => {
  const srv = await scripted([
    { status: 200, body: { events: [{ seq: 1 }, { seq: 2 }] } },
    { status: 200, body: { events: [{ seq: 5 }] } },
    { status: 200, body: { events: [] } },
  ]);
  try {
    const seen = [];
    for await (const evt of srv.client().sandbox('sb-1').events({ afterSeq: 0, limit: 2 }))
      seen.push(evt.seq);
    assert.deepEqual(seen, [1, 2, 5]);
    assert.deepEqual(
      srv.hits.map((h) => h.url),
      [
        '/v1/sandboxes/sb-1/events?afterSeq=0&limit=2',
        '/v1/sandboxes/sb-1/events?afterSeq=2&limit=2',
        '/v1/sandboxes/sb-1/events?afterSeq=5&limit=2',
      ],
    );
  } finally {
    await srv.close();
  }
});

test('a session stream on a refused upgrade throws instead of hanging', async () => {
  const srv = await scripted([page]);
  const upgrades = [];
  srv.server.on('upgrade', (req, socket) => {
    upgrades.push(req.url);
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  try {
    const stream = srv.client().sandbox('sb-1').attach('s 1');
    assert.ok(stream instanceof SessionStream);
    stream.input('never sent\n');
    await assert.rejects(
      async () => {
        for await (const _evt of stream) assert.fail('no events expected');
      },
      (e) => e instanceof WorkboxApiError && e.code === 'E_UNAVAILABLE',
    );
    assert.deepEqual(upgrades, ['/v1/sandboxes/sb-1/sessions/s%201/ws?token=tok']);
  } finally {
    await srv.close();
  }
});

test('retryDelay is exponential with jitter and capped', () => {
  assert.equal(
    retryDelay(0, 100, 5000, () => 0),
    50,
  );
  assert.equal(
    retryDelay(0, 100, 5000, () => 1),
    100,
  );
  assert.equal(
    retryDelay(3, 100, 5000, () => 0),
    400,
  );
  assert.equal(
    retryDelay(3, 100, 5000, () => 0.5),
    600,
  );
  assert.equal(
    retryDelay(10, 100, 5000, () => 1),
    5000,
  );
  const spread = new Set(Array.from({ length: 20 }, () => retryDelay(2, 100, 5000)));
  assert.ok(spread.size > 1, 'default jitter is random');
  for (const d of spread) assert.ok(d >= 200 && d <= 400, String(d));
});

test('the client requires a baseUrl and trims trailing slashes', () => {
  assert.throws(() => new WorkboxClient({}), /baseUrl is required/);
  assert.equal(new WorkboxClient({ baseUrl: 'http://h:1//' }).baseUrl, 'http://h:1');
});
