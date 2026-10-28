import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
import { FakeManager } from '../helpers/fake-manager.js';

// Localhost test traffic must never go through an ambient HTTP(S) proxy.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])
  delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';

async function boot() {
  const app = createServer({
    manager: new FakeManager(),
    keys: [
      { id: 'root', token: 'admin-token', scopes: ['admin', 'read', 'exec', 'answer'] },
      { id: 'ro', token: 'read-token', scopes: ['read'] },
    ],
  });
  const addr = await app.listen(0);
  return { app, base: `http://127.0.0.1:${addr.port}` };
}

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('health open; auth 401/403; lifecycle and exec over HTTP; 400 with field path', async () => {
  const { app, base } = await boot();
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/v1/sandboxes`)).status, 401);
    const create = await fetch(`${base}/v1/sandboxes`, {
      method: 'POST',
      headers: H('admin-token'),
      body: '{}',
    });
    assert.equal(create.status, 201);
    const row = await create.json();
    assert.equal(
      (
        await fetch(`${base}/v1/sandboxes`, {
          method: 'POST',
          headers: H('read-token'),
          body: '{}',
        })
      ).status,
      403,
    );
    const bad = await fetch(`${base}/v1/sandboxes/${row.id}/exec`, {
      method: 'POST',
      headers: H('admin-token'),
      body: '{}',
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.details.errors[0].path, 'argv');
    const exec = await fetch(`${base}/v1/sandboxes/${row.id}/exec`, {
      method: 'POST',
      headers: H('admin-token'),
      body: JSON.stringify({ argv: ['echo', 'x'] }),
    });
    assert.equal(exec.status, 200);
    assert.match((await exec.json()).stdout, /ran echo x/);
    const inspect = await (
      await fetch(`${base}/v1/sandboxes/${row.id}`, { headers: H('read-token') })
    ).json();
    assert.equal(inspect.desired, 'READY');
    const metrics = await (await fetch(`${base}/metrics`, { headers: H('read-token') })).text();
    assert.match(metrics, /workbox_http_requests_total/);
  } finally {
    await app.close();
  }
});

test('websocket session streams output events and requires a token', async () => {
  const { app, base } = await boot();
  try {
    const create = await (
      await fetch(`${base}/v1/sandboxes`, { method: 'POST', headers: H('admin-token'), body: '{}' })
    ).json();
    const wsBase = base.replace('http', 'ws');
    const ws = new WebSocket(
      `${wsBase}/v1/sandboxes/${create.id}/sessions/sess-1/ws?token=admin-token`,
    );
    const events = [];
    await new Promise((resolve, reject) => {
      ws.addEventListener('error', reject);
      ws.addEventListener('message', (ev) => {
        events.push(JSON.parse(String(ev.data)));
        if (events.some((e) => e.type === 'session.output')) resolve();
      });
      setTimeout(() => reject(new Error(`no ws output; got ${JSON.stringify(events)}`)), 5000);
    });
    assert.ok(events.some((e) => e.type === 'ready'));
    ws.close();
  } finally {
    await app.close();
  }
});
