import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ReadableStream } from 'node:stream/web';
import { SCOPE_MATRIX, WsSocket, acceptKey } from '@workbox/server';
import {
  EventStream,
  ROUTES,
  Sandbox,
  SandboxSession,
  SessionStream,
  WorkboxClient,
  retryDelay,
} from '../../src/client.js';
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
      const raw = Buffer.concat(chunks);
      const json = (req.headers['content-type'] ?? '').includes('json');
      hits.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        at: Date.now(),
        body: raw.length && json ? JSON.parse(raw.toString()) : undefined,
        raw,
      });
      const step = script[Math.min(hits.length, script.length) - 1];
      if (step === 'drop') return req.socket.destroy();
      if (step === 'hang') return undefined;
      if (step.bytes) {
        res.writeHead(step.status, { 'content-type': 'application/octet-stream' });
        return res.end(step.bytes);
      }
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
  const classes = { WorkboxClient, Sandbox, SandboxSession };
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

test('key calls: create is sent once, revoke, list and whoami retry', async () => {
  const down = await scripted([unavailable]);
  const flaky = await scripted([unavailable, { status: 200, body: { id: 'key_1' } }]);
  try {
    const input = { name: 'agent', scopes: ['read'], labels: { team: 'a' }, ttlSeconds: 60 };
    await assert.rejects(down.client({ retries: 3 }).createKey(input), (e) => e.status === 503);
    assert.equal(down.hits.length, 1);
    assert.equal(down.hits[0].method, 'POST');
    assert.equal(down.hits[0].url, '/v1/keys');
    assert.deepEqual(down.hits[0].body, input);
    const client = flaky.client();
    assert.deepEqual(await client.revokeKey('key/1'), { id: 'key_1' });
    assert.deepEqual(await client.listKeys(), { id: 'key_1' });
    assert.deepEqual(await client.whoami(), { id: 'key_1' });
    assert.deepEqual(
      flaky.hits.map((h) => `${h.method} ${h.url}`),
      ['DELETE /v1/keys/key%2F1', 'DELETE /v1/keys/key%2F1', 'GET /v1/keys', 'GET /v1/whoami'],
    );
  } finally {
    await down.close();
    await flaky.close();
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

test('session control: reads, waits, stops and resizes retry; input and signals go once', async () => {
  const ok = { status: 200, body: { ok: true } };
  const srv = await scripted([unavailable, ok]);
  try {
    const session = srv.client({ retries: 3 }).sandbox('sb-1').session('se 1');
    assert.ok(session instanceof SandboxSession);
    const steps = [
      () => session.info(),
      () => session.output({ fromSeq: 2, maxBytes: 10, encoding: 'text' }),
      () => session.wait({ timeoutMs: 5 }),
      () => session.stop({ graceMs: 1 }),
      () => session.resize(10, 20),
      () => session.remove(),
    ];
    for (const step of steps) {
      srv.hits.length = 0;
      assert.deepEqual(await step(), { ok: true });
      assert.equal(srv.hits.length, 2, 'retried once after the 503');
    }
  } finally {
    await srv.close();
  }
});

test('session control sends each route its method, path and body', async () => {
  const srv = await scripted([{ status: 200, body: {} }]);
  try {
    const session = srv.client().sandbox('sb-1').session('se 1');
    await session.info();
    await session.output({ fromSeq: 2, maxBytes: 10, encoding: 'text' });
    await session.output();
    await session.wait({ timeoutMs: 5 });
    await session.wait();
    await session.input('hi', { eof: true });
    await session.input(undefined, { eof: true });
    await session.signal('SIGINT');
    await session.stop({ graceMs: 1 });
    await session.stop();
    await session.resize(10, 20);
    await session.remove();
    const base = '/v1/sandboxes/sb-1/sessions/se%201';
    assert.deepEqual(
      srv.hits.map((h) => [h.method, h.url, h.body]),
      [
        ['GET', base, undefined],
        ['GET', `${base}/output?fromSeq=2&maxBytes=10&encoding=text`, undefined],
        ['GET', `${base}/output`, undefined],
        ['POST', `${base}/wait`, { timeoutMs: 5 }],
        ['POST', `${base}/wait`, {}],
        ['POST', `${base}/input`, { eof: true, data: b64('hi') }],
        ['POST', `${base}/input`, { eof: true }],
        ['POST', `${base}/signal`, { signal: 'SIGINT' }],
        ['POST', `${base}/stop`, { graceMs: 1 }],
        ['POST', `${base}/stop`, {}],
        ['POST', `${base}/resize`, { rows: 10, cols: 20 }],
        ['DELETE', base, undefined],
      ],
    );
  } finally {
    await srv.close();
  }
});

test('input and signals are sent once on a 503', async () => {
  const srv = await scripted([unavailable]);
  try {
    const session = srv.client({ retries: 3 }).sandbox('sb-1').session('se-1');
    await assert.rejects(session.input('x'), (e) => e.status === 503);
    await assert.rejects(session.signal('SIGTERM'), (e) => e.status === 503);
    assert.equal(srv.hits.length, 2);
  } finally {
    await srv.close();
  }
});

test('files: stat, remove and mkdir; downloads as a Buffer or a stream', async () => {
  const bytes = Buffer.from([0, 1, 2, 250, 255]);
  const srv = await scripted([
    { status: 200, body: { size: 5 } },
    { status: 200, body: { removed: true } },
    unavailable,
    { status: 200, body: { created: true } },
    unavailable,
    { status: 200, bytes },
    { status: 200, bytes },
    { status: 200, bytes },
  ]);
  try {
    const box = srv.client().sandbox('sb-1');
    assert.equal((await box.statFile('/a b')).size, 5);
    assert.equal((await box.removeFile('/d', { recursive: true })).removed, true);
    assert.equal((await box.mkdir('/d/e', { parents: false, mode: 0o700 })).created, true);
    assert.deepEqual(await box.download('/f'), bytes, 'retried after the 503');
    const stream = await box.download('/f', { stream: true });
    assert.ok(stream instanceof ReadableStream);
    const parts = [];
    for await (const c of stream) parts.push(Buffer.from(c));
    assert.deepEqual(Buffer.concat(parts), bytes);
    assert.deepEqual(await box.downloadArtifact('ab'.repeat(32)), bytes);
    assert.deepEqual(
      srv.hits.map((h) => [h.method, h.url, h.body]),
      [
        ['GET', '/v1/sandboxes/sb-1/files?path=%2Fa+b&stat=1', undefined],
        ['DELETE', '/v1/sandboxes/sb-1/files?path=%2Fd&recursive=1', undefined],
        ['POST', '/v1/sandboxes/sb-1/files/mkdir', { path: '/d/e', parents: false, mode: 0o700 }],
        ['POST', '/v1/sandboxes/sb-1/files/mkdir', { path: '/d/e', parents: false, mode: 0o700 }],
        ['GET', '/v1/sandboxes/sb-1/files/raw?path=%2Ff', undefined],
        ['GET', '/v1/sandboxes/sb-1/files/raw?path=%2Ff', undefined],
        ['GET', '/v1/sandboxes/sb-1/files/raw?path=%2Ff', undefined],
        ['GET', `/v1/sandboxes/sb-1/artifacts/${'ab'.repeat(32)}`, undefined],
      ],
    );
  } finally {
    await srv.close();
  }
});

test('an upload from bytes is retried; one from a stream is sent once', async () => {
  const srv = await scripted([unavailable, { status: 200, body: { bytes: 3 } }]);
  const down = await scripted([unavailable]);
  try {
    const box = srv.client().sandbox('sb-1');
    assert.equal((await box.upload('/u', 'abc', { mode: 0o640, mkdirs: true })).bytes, 3);
    assert.deepEqual(
      srv.hits.map((h) => [h.method, h.url, h.headers['content-type'], h.raw.toString()]),
      [
        [
          'PUT',
          '/v1/sandboxes/sb-1/files/raw?path=%2Fu&mode=640&mkdirs=1',
          'application/octet-stream',
          'abc',
        ],
        [
          'PUT',
          '/v1/sandboxes/sb-1/files/raw?path=%2Fu&mode=640&mkdirs=1',
          'application/octet-stream',
          'abc',
        ],
      ],
    );
    async function* pieces() {
      yield 'one ';
      yield Buffer.from('two');
    }
    const streamed = down.client({ retries: 3 }).sandbox('sb-1');
    await assert.rejects(streamed.upload('/s', pieces()), (e) => e.status === 503);
    assert.equal(down.hits.length, 1);
    assert.equal(down.hits[0].raw.toString(), 'one two');
    const web = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([7, 8]));
        c.close();
      },
    });
    await assert.rejects(streamed.upload('/w', web), (e) => e.status === 503);
    assert.deepEqual([...down.hits[1].raw], [7, 8]);
  } finally {
    await srv.close();
    await down.close();
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

test('listEvents: fleet and sandbox pages carry types, sandboxId and the long-poll wait', async () => {
  const srv = await scripted([{ status: 200, body: { events: [], nextSeq: 4 } }]);
  try {
    const client = srv.client();
    const fleet = await client.listEvents({
      afterSeq: 4,
      limit: 10,
      types: ['build.*', 'session.exited'],
      sandboxId: 'sb-1',
      waitMs: 30_000,
    });
    assert.deepEqual(fleet, { events: [], nextSeq: 4 });
    await client.listEvents();
    await client.listEvents({ types: [] });
    await client.sandbox('sb-1').listEvents({ afterSeq: 2, types: ['x.*'], waitMs: 5 });
    assert.deepEqual(
      srv.hits.map((h) => decodeURIComponent(h.url)),
      [
        '/v1/events?afterSeq=4&limit=10&types=build.*,session.exited&waitMs=30000&sandboxId=sb-1',
        '/v1/events',
        '/v1/events',
        '/v1/sandboxes/sb-1/events?afterSeq=2&types=x.*&waitMs=5',
      ],
    );
  } finally {
    await srv.close();
  }
});

/**
 * Answer every events WebSocket upgrade on `srv` with the next entry of `script`: a function that
 * gets the open server socket. Records each upgrade URL.
 */
function scriptedUpgrades(srv, script) {
  const urls = [];
  srv.server.on('upgrade', (req, socket, head) => {
    urls.push(req.url);
    const step = script[Math.min(urls.length, script.length) - 1];
    if (step === 'refuse') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`,
    );
    step(new WsSocket(socket, head));
  });
  return urls;
}

const frame = (ws, msg) => ws.send(JSON.stringify(msg));
const event = (seq) => ({ type: 'event', event: { seq, sandboxId: 'sb-1', type: 'build.done' } });

test('events() resumes after a drop from where it got to and never repeats an event', async () => {
  const srv = await scripted([page]);
  const urls = scriptedUpgrades(srv, [
    (ws) => {
      frame(ws, event(6));
      frame(ws, event(7));
      frame(ws, { type: 'live', seq: 9 });
      setTimeout(() => ws.terminate(), 20);
    },
    (ws) => {
      frame(ws, event(7));
      frame(ws, { type: 'unknown' });
      frame(ws, null);
      ws.socket.write(Buffer.from([0x81, 3, 0x6e, 0x6f, 0x21]));
      frame(ws, event(10));
      setTimeout(() => ws.close(1001), 20);
    },
    (ws) => frame(ws, event(11)),
  ]);
  try {
    const ac = new AbortController();
    const stream = srv.client().events({
      afterSeq: 5,
      types: ['build.*'],
      sandboxId: 'sb-1',
      signal: ac.signal,
    });
    assert.ok(stream instanceof EventStream);
    const seen = [];
    await assert.rejects(
      async () => {
        for await (const evt of stream) {
          seen.push(evt.seq);
          if (evt.seq === 11) ac.abort();
        }
      },
      (e) => e.name === 'AbortError',
    );
    assert.deepEqual(seen, [6, 7, 10, 11]);
    assert.equal(stream.lastSeq, 11);
    assert.deepEqual(
      urls.map((u) => decodeURIComponent(u)),
      [
        '/v1/events/ws?afterSeq=5&types=build.*&sandboxId=sb-1&token=tok',
        '/v1/events/ws?afterSeq=9&types=build.*&sandboxId=sb-1&token=tok',
        '/v1/events/ws?afterSeq=10&types=build.*&sandboxId=sb-1&token=tok',
      ],
    );
  } finally {
    await srv.close();
  }
});

test('a sandbox follow streams from seq 0; without afterSeq the fleet stream is live only', async () => {
  const srv = await scripted([page]);
  const urls = scriptedUpgrades(srv, [
    (ws) => {
      frame(ws, event(1));
    },
    (ws) => {
      frame(ws, { type: 'live', seq: 3 });
      frame(ws, event(4));
    },
  ]);
  try {
    const client = srv.client({ token: '' });
    const own = client.sandbox('sb 1').events({ follow: true })[Symbol.asyncIterator]();
    assert.equal((await own.next()).value.seq, 1);
    await own.return();
    const live = client.events();
    for await (const evt of live) {
      assert.equal(evt.seq, 4);
      live.close();
    }
    assert.deepEqual(urls, ['/v1/sandboxes/sb%201/events/ws?afterSeq=0', '/v1/events/ws']);
    const closed = client.events();
    closed.close();
    for await (const _evt of closed) assert.fail('a closed stream yields nothing');
    assert.equal(urls.length, 2, 'and never connects');
  } finally {
    await srv.close();
  }
});

test('a refused events upgrade: a 4xx from the REST route throws, anything else is retried', async () => {
  const denied = await scripted([
    {
      status: 401,
      body: { error: { code: 'E_DENIED', message: 'missing or invalid bearer token' } },
    },
  ]);
  const flaky = await scripted([unavailable, unavailable, unavailable, page]);
  try {
    scriptedUpgrades(denied, ['refuse']);
    await assert.rejects(
      async () => {
        for await (const _evt of denied.client().events({ types: ['a.*'] }))
          assert.fail('no events expected');
      },
      (e) => e instanceof WorkboxApiError && e.status === 401 && e.code === 'E_DENIED',
    );
    assert.equal(denied.hits[0].url, '/v1/events?afterSeq=0&limit=1&types=a.*');

    const urls = scriptedUpgrades(flaky, ['refuse', 'refuse', (ws) => frame(ws, event(2))]);
    const follow = flaky.client({ retries: 0 }).sandbox('sb-1').events({ follow: true });
    const it = follow[Symbol.asyncIterator]();
    assert.equal((await it.next()).value.seq, 2);
    await it.return();
    assert.ok(urls.length >= 3, 'the upgrade was tried again after each refusal');
    assert.ok(flaky.hits.length >= 2);
    for (const hit of flaky.hits)
      assert.match(hit.url, /^\/v1\/sandboxes\/sb-1\/events\?afterSeq=0&limit=1$/);
  } finally {
    await denied.close();
    await flaky.close();
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
    // Node 24's WebSocket client may retry a refused upgrade once; every attempt is this URL.
    assert.ok(upgrades.length >= 1);
    for (const url of upgrades) assert.equal(url, '/v1/sandboxes/sb-1/sessions/s%201/ws?token=tok');
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
