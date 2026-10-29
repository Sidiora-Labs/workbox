import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, matchRoute, MAX_BODY_BYTES, BODY_SCHEMAS } from '../../src/server.js';
import { SCOPE_MATRIX } from '../../src/auth.js';
import { bootServer, call, rawUpgrade, TOKENS } from '../helpers/real-server.js';

let srv;
before(async () => {
  srv = await bootServer({ server: { serverNames: ['workbox.internal'] } });
});
after(async () => {
  await srv?.stop();
});

test('matchRoute resolves templates, parameters, 405 paths and unknown paths', () => {
  assert.deepEqual(matchRoute('GET', '/v1/sandboxes/sb%2D1/files'), {
    key: 'GET /v1/sandboxes/:id/files',
    params: { id: 'sb-1' },
  });
  assert.deepEqual(matchRoute('PATCH', '/v1/sandboxes/x'), { key: null, params: {} });
  assert.equal(matchRoute('GET', '/v1/nope'), null);
  assert.equal(matchRoute('GET', '/v1/sandboxes/%E0%A4%A'), null);
  for (const key of Object.keys(BODY_SCHEMAS)) assert.ok(key in SCOPE_MATRIX, key);
});

test('H15: Origin, Sec-Fetch-Site and foreign Host are refused with 403 before auth', async () => {
  const origin = await call(srv.port, {
    path: '/v1/sandboxes',
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(origin.status, 403);
  assert.match(origin.json.error.message, /Origin/);
  const site = await call(srv.port, {
    path: '/healthz',
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(site.status, 403);
  const evil = await call(srv.port, {
    path: '/v1/sandboxes',
    token: TOKENS.admin,
    headers: { host: 'evil.example' },
  });
  assert.equal(evil.status, 403);
  assert.match(evil.json.error.message, /evil\.example/);
  for (const host of ['localhost:1', '[::1]:9', 'WORKBOX.internal'])
    assert.equal((await call(srv.port, { path: '/healthz', headers: { host } })).status, 200, host);
});

test('health, readiness, request ids and structured JSON logs', async () => {
  const health = await call(srv.port, { path: '/healthz', headers: { 'x-request-id': 'req-1' } });
  assert.equal(health.status, 200);
  assert.equal(health.headers['x-request-id'], 'req-1');
  assert.deepEqual((await call(srv.port, { path: '/readyz' })).json, { ready: true });
  const generated = await call(srv.port, { path: '/healthz', headers: { 'x-request-id': 'a b' } });
  assert.match(generated.headers['x-request-id'], /^[0-9a-f-]{36}$/);
  const entry = srv.logs.find((l) => l.requestId === 'req-1');
  assert.equal(entry.component, 'server');
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.ms, 'number');
  assert.equal(typeof entry.ts, 'string');
});

test('401 without or with a wrong token; 403 for a key without the scope', async () => {
  assert.equal((await call(srv.port, { path: '/v1/sandboxes' })).status, 401);
  const wrong = await call(srv.port, { path: '/v1/sandboxes', token: 'nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error.code, 'E_DENIED');
  assert.ok(wrong.json.error.requestId);
  const create = await call(srv.port, {
    method: 'POST',
    path: '/v1/sandboxes',
    token: TOKENS.read,
    body: {},
  });
  assert.equal(create.status, 403);
  assert.match(create.json.error.message, /scope admin/);
  for (const [method, p] of [
    ['POST', '/v1/sandboxes/sb-x/exec'],
    ['DELETE', '/v1/sandboxes/sb-x'],
    ['POST', '/v1/asks/ask-x/answer'],
    ['POST', '/v1/reconcile'],
  ])
    assert.equal(
      (await call(srv.port, { method, path: p, token: TOKENS.read, body: {} })).status,
      403,
      `${method} ${p}`,
    );
  const denied = srv.auditEntries().find((e) => e.data?.route === 'POST /v1/sandboxes');
  assert.equal(denied.actor, 'api:observer');
  assert.equal(denied.data.outcome, 'E_DENIED');
});

test('schema validation answers 400 with field paths', async () => {
  const exec = await call(srv.port, {
    method: 'POST',
    path: '/v1/sandboxes/sb-x/exec',
    token: TOKENS.exec,
    body: { argv: [] },
  });
  assert.equal(exec.status, 400);
  assert.equal(exec.json.error.code, 'E_INVALID_PARAMS');
  assert.ok(exec.json.error.details.errors.some((e) => e.path.includes('argv')));
  const unknown = await call(srv.port, {
    method: 'POST',
    path: '/v1/sandboxes',
    token: TOKENS.admin,
    body: { name: 'x', bogus: 1 },
  });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.json.error.details.errors.some((e) => e.path.includes('bogus')));
  const write = await call(srv.port, {
    method: 'PUT',
    path: '/v1/sandboxes/sb-x/files',
    token: TOKENS.exec,
    body: { path: '/tmp/x' },
  });
  assert.ok(write.json.error.details.errors.some((e) => e.path.includes('data')));
  const answer = await call(srv.port, {
    method: 'POST',
    path: '/v1/asks/ask-x/answer',
    token: TOKENS.answer,
    body: {},
  });
  assert.ok(answer.json.error.details.errors.some((e) => e.path.includes('answer')));
  const json = await call(srv.port, {
    method: 'POST',
    path: '/v1/sandboxes',
    token: TOKENS.admin,
    raw: '{not json',
  });
  assert.deepEqual(json.json.error.details.errors[0].path, '$');
  const limit = await call(srv.port, { path: '/v1/sandboxes?limit=-1', token: TOKENS.read });
  assert.equal(limit.status, 400);
  assert.equal(limit.json.error.details.errors[0].path, 'query.limit');
  const files = await call(srv.port, { path: '/v1/sandboxes/sb-x/files', token: TOKENS.read });
  assert.equal(files.json.error.details.errors[0].path, 'query.path');
});

test('an oversize body is refused with 413 by length and while streaming', async () => {
  const big = await call(srv.port, {
    method: 'POST',
    path: '/v1/sandboxes',
    token: TOKENS.admin,
    raw: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20),
  });
  assert.equal(big.status, 413);
  assert.equal(big.json.error.code, 'E_LIMIT');
  const small = createServer({
    manager: srv.manager,
    keys: [{ id: 'k', token: 't', scopes: ['admin'] }],
    maxBodyBytes: 64,
    logger: { info() {}, error() {} },
  });
  const { port } = await small.listen(0);
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/sandboxes',
          headers: { host: 'localhost', authorization: 'Bearer t' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.write('{"name":"');
      req.write('x'.repeat(200));
      req.end('"}');
    });
    assert.equal(status, 413);
  } finally {
    await small.close();
  }
});

test('routing errors: 404 route, 405 method, 404 sandbox, 426 without upgrade', async () => {
  const none = await call(srv.port, { path: '/v2/x', token: TOKENS.read });
  assert.equal(none.status, 404);
  const method = await call(srv.port, {
    method: 'PATCH',
    path: '/v1/sandboxes/x',
    token: TOKENS.admin,
  });
  assert.equal(method.status, 405);
  const missing = await call(srv.port, { path: '/v1/sandboxes/sb-none', token: TOKENS.read });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'E_NOT_FOUND');
  for (const tail of ['evidence', 'artifacts', 'checkpoints', 'events'])
    assert.equal(
      (await call(srv.port, { path: `/v1/sandboxes/sb-none/${tail}`, token: TOKENS.read })).status,
      404,
      tail,
    );
  const ws = await call(srv.port, {
    path: '/v1/sandboxes/sb-none/sessions/s/ws',
    token: TOKENS.exec,
  });
  assert.equal(ws.status, 426);
});

test('inventory, asks, reconcile and metrics on an empty fleet', async () => {
  const list = await call(srv.port, { path: '/v1/sandboxes?limit=5', token: TOKENS.read });
  assert.deepEqual(list.json, { items: [], cursor: null, complete: true });
  const asks = await call(srv.port, { path: '/v1/asks?status=open', token: TOKENS.read });
  assert.deepEqual(asks.json, { asks: [] });
  const rec = await call(srv.port, { method: 'POST', path: '/v1/reconcile', token: TOKENS.admin });
  assert.deepEqual(rec.json, { attached: [], absent: [], suspect: [], quarantined: [] });
  assert.ok(
    srv.auditEntries().some((e) => e.action === 'api.reconcile' && e.data.outcome === 'ok'),
  );
  const metrics = await call(srv.port, { path: '/metrics', token: TOKENS.read });
  assert.equal(metrics.status, 200);
  assert.match(metrics.headers['content-type'], /text\/plain/);
  assert.match(
    metrics.text,
    /workbox_http_requests_total\{method="POST",route="POST \/v1\/reconcile",status="200"\} 1/,
  );
  assert.equal((await call(srv.port, { path: '/metrics' })).status, 401);
});

test('websocket upgrades are authenticated and guarded before the handshake', async () => {
  const target = '/v1/sandboxes/sb-none/sessions/s/ws';
  assert.match(await rawUpgrade(srv.port, target), /^HTTP\/1\.1 401/);
  assert.match(await rawUpgrade(srv.port, `${target}?token=${TOKENS.read}`), /^HTTP\/1\.1 403/);
  assert.match(
    await rawUpgrade(srv.port, `${target}?token=${TOKENS.exec}`, { Origin: 'http://evil.example' }),
    /^HTTP\/1\.1 403/,
  );
  assert.match(
    await rawUpgrade(srv.port, target, { Authorization: `Bearer ${TOKENS.exec}` }),
    /^HTTP\/1\.1 404/,
  );
  assert.match(
    await rawUpgrade(srv.port, `/v1/sandboxes?token=${TOKENS.admin}`),
    /^HTTP\/1\.1 404/,
  );
});

test('readiness follows the probe; graceful close stops listening', async () => {
  let ready = true;
  const app = createServer({
    manager: srv.manager,
    keys: [{ id: 'k', token: 't', scopes: ['exec'] }],
    ready: () => ready,
    logger: { info() {}, error() {} },
  });
  const { port } = await app.listen(0);
  ready = false;
  assert.equal((await call(port, { path: '/readyz' })).status, 503);
  await app.close();
  await assert.rejects(call(port, { path: '/healthz' }), /ECONNREFUSED/);
  await assert.rejects(app.listen(port, '256.0.0.1'));
});

test('TLS material is checked at creation; reloadTls needs a TLS server', () => {
  const deps = { manager: srv.manager, keys: [], logger: { info() {}, error() {} } };
  const invalid = (pattern) => (e) => e.code === 'E_INVALID_PARAMS' && pattern.test(e.message);
  assert.throws(() => srv.app.reloadTls({ cert: 'x', key: 'y' }), invalid(/not started with TLS/));
  assert.throws(
    () => createServer({ ...deps, tls: { cert: 'x' } }),
    invalid(/needs a certificate and a key/),
  );
  assert.throws(
    () => createServer({ ...deps, tls: { cert: 'not pem', key: 'not pem' } }),
    invalid(/invalid TLS certificate or key/),
  );
  assert.throws(() => createServer({ ...deps, authFailures: { max: 0 } }), RangeError);
});

test('repeated failed authentications from one address are answered 429 before auth', async () => {
  const app = createServer({
    manager: srv.manager,
    keys: [{ id: 'k', token: 'good-token', scopes: ['admin'] }],
    authFailures: { max: 2, windowMs: 60_000 },
    logger: { info() {}, error() {} },
  });
  const { port } = await app.listen(0);
  try {
    for (let i = 0; i < 3; i++)
      assert.equal(
        (await call(port, { path: '/v1/sandboxes', token: 'good-token' })).status,
        200,
        'successes are not counted',
      );
    assert.equal((await call(port, { path: '/v1/sandboxes' })).status, 401);
    assert.match(await rawUpgrade(port, '/v1/sandboxes/sb-none/sessions/s/ws'), /^HTTP\/1\.1 401/);
    const limited = await call(port, { path: '/v1/sandboxes', token: 'good-token' });
    assert.equal(limited.status, 429);
    assert.equal(limited.json.error.code, 'E_LIMIT');
    const wait = Number(limited.headers['retry-after']);
    assert.ok(wait >= 1 && wait <= 60, String(wait));
    assert.equal(limited.json.error.details.retryAfterSeconds, wait);
    assert.match(
      await rawUpgrade(port, '/v1/sandboxes/sb-none/sessions/s/ws?token=good-token'),
      /^HTTP\/1\.1 429/,
    );
    assert.equal((await call(port, { path: '/healthz' })).status, 200, 'health needs no token');
  } finally {
    await app.close();
  }
});
