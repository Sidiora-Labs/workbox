import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { bootServer, call, TOKENS } from '../helpers/real-server.js';
import { selfSigned, tlsUpgrade } from '../helpers/tls.js';

test('HTTPS and WSS over a real engine: certificate reload and the failed-auth limit', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-server-tls-'));
  const first = selfSigned(dir, 'first');
  const second = selfSigned(dir, 'second');
  const windowMs = 1500;
  const srv = await bootServer({
    server: { tls: { cert: first.cert, key: first.key }, authFailures: { max: 3, windowMs } },
  });
  const ca = [first.cert, second.cert];
  const get = (p, token) => call(srv.port, { path: p, token, ca });
  try {
    assert.match(srv.base, /^https:\/\/127\.0\.0\.1:\d+$/);

    await t.test('REST answers over HTTPS with the configured certificate', async () => {
      const health = await get('/healthz');
      assert.equal(health.status, 200);
      assert.equal(health.peer, first.fingerprint);
      assert.equal((await get('/v1/sandboxes', TOKENS.read)).status, 200);
      await assert.rejects(call(srv.port, { path: '/healthz' }), 'plain HTTP gets no answer');
      await assert.rejects(
        call(srv.port, { path: '/healthz', ca: [second.cert] }),
        /self-signed|certificate/i,
        'a client that does not trust the certificate refuses it',
      );
    });

    await t.test('a session WebSocket upgrades over TLS', async () => {
      const created = await call(srv.port, {
        method: 'POST',
        path: '/v1/sandboxes',
        token: TOKENS.admin,
        body: { name: 'tls-box' },
        ca,
      });
      assert.equal(created.status, 201, created.text);
      const started = await call(srv.port, {
        method: 'POST',
        path: `/v1/sandboxes/${created.json.id}/sessions`,
        token: TOKENS.exec,
        body: { argv: ['sh', '-c', 'sleep 5'], name: 'tls-session' },
        ca,
      });
      assert.equal(started.status, 201, started.text);
      const target = `/v1/sandboxes/${created.json.id}/sessions/${started.json.sessionId}/ws`;
      const head = await tlsUpgrade(srv.port, `${target}?token=${TOKENS.exec}`, { ca });
      assert.match(head, /^HTTP\/1\.1 101 /);
      assert.match(head, /\r\nSec-WebSocket-Accept: /);
    });

    await t.test('reloadTls serves a new certificate; bad material keeps the old one', async () => {
      srv.app.reloadTls({ cert: second.cert, key: second.key });
      assert.equal((await get('/healthz')).peer, second.fingerprint);
      const invalid = { code: 'E_INVALID_PARAMS' };
      assert.throws(() => srv.app.reloadTls({ cert: first.cert, key: second.key }), invalid);
      assert.throws(
        () => srv.app.reloadTls({ cert: 'not a certificate', key: first.key }),
        invalid,
      );
      assert.throws(() => srv.app.reloadTls({ cert: first.cert }), invalid);
      assert.equal((await get('/healthz')).peer, second.fingerprint);
      srv.app.reloadTls({ cert: first.cert, key: first.key });
      assert.equal((await get('/healthz')).peer, first.fingerprint);
    });

    await t.test('bad tokens on REST are limited with Retry-After, then recover', async () => {
      for (let i = 0; i < 3; i++)
        assert.equal((await get('/v1/sandboxes', 'wrong-token')).status, 401);
      const limited = await get('/v1/sandboxes', TOKENS.read);
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error.code, 'E_LIMIT');
      assert.match(limited.headers['retry-after'], /^[12]$/);
      const ws = await tlsUpgrade(srv.port, `/v1/sandboxes/x/sessions/y/ws?token=${TOKENS.exec}`, {
        ca,
      });
      assert.match(ws, /^HTTP\/1\.1 429 /);
      assert.match(ws, /\r\nRetry-After: [12]\r\n/);
      assert.equal((await get('/healthz')).status, 200);
      await sleep(windowMs + 200);
      assert.equal((await get('/v1/sandboxes', TOKENS.read)).status, 200);
    });

    await t.test('bad tokens on WebSocket upgrades count as well', async () => {
      const target = '/v1/sandboxes/x/sessions/y/ws';
      for (let i = 0; i < 3; i++)
        assert.match(await tlsUpgrade(srv.port, target, { ca }), /^HTTP\/1\.1 401 /);
      assert.equal((await get('/v1/sandboxes', TOKENS.read)).status, 429);
      await sleep(windowMs + 200);
      for (let i = 0; i < 5; i++)
        assert.equal((await get('/v1/sandboxes', TOKENS.read)).status, 200);
    });

    const requests = srv.logs.filter((l) => l.status === 429);
    assert.ok(requests.length >= 2, 'limited requests are logged');
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
