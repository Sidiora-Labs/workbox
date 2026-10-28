import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { hashToken } from '@workbox/server';
import { openLocalEngine } from '../../src/local.js';
import { loadServeConfig, serveCommand } from '../../src/serve.js';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-serve-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeJson(dir, name, doc) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  return file;
}

/** GET `target` on a fresh connection with an explicit Host header; resolves with the status. */
function status(port, target, { token, host = `127.0.0.1:${port}` } = {}) {
  const headers = { host };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: target, headers, agent: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
  });
}

test('loadServeConfig accepts keys, host, port and server names, and fails closed otherwise', () => {
  const t = tempDir();
  try {
    const keys = [
      { id: 'ops', token: 'tok-ops', scopes: ['admin'] },
      { id: 'observer', tokenSha256: hashToken('tok-read'), scopes: ['read'] },
    ];
    const doc = { keys, host: '127.0.0.1', port: 8791, serverNames: ['box.example'] };
    assert.deepEqual(loadServeConfig(writeJson(t.dir, 'ok.json', doc)), doc);
    assert.deepEqual(loadServeConfig(writeJson(t.dir, 'empty.json', {})), {
      host: undefined,
      port: undefined,
      serverNames: [],
      keys: [],
    });
    const invalid = (name, body, pattern) =>
      assert.throws(
        () =>
          loadServeConfig(body === null ? path.join(t.dir, name) : writeJson(t.dir, name, body)),
        (e) => e.code === 'E_INVALID_PARAMS' && pattern.test(e.message),
        name,
      );
    invalid('missing.json', null, /is not readable JSON/);
    invalid('broken.json', '{not json', /is not readable JSON/);
    invalid('array.json', '[]', /must contain a JSON object/);
    invalid('null.json', 'null', /must contain a JSON object/);
    invalid('unknown.json', { keys: [], root: '/x' }, /unknown key root/);
    invalid('host.json', { host: '' }, /host must be a non-empty string/);
    invalid('port.json', { port: 70000 }, /port must be an integer >= 0 and <= 65535/);
    invalid('portf.json', { port: 1.5 }, /port must be an integer/);
    invalid('names.json', { serverNames: 'box.example' }, /serverNames must be an array/);
    invalid('names2.json', { serverNames: [''] }, /serverNames must be an array/);
    invalid('keys.json', { keys: {} }, /keys must be an array of scoped keys/);
    invalid(
      'scope.json',
      { keys: [{ id: 'k', token: 't', scopes: ['root'] }] },
      /unknown scope root/,
    );
    invalid('digest.json', { keys: [{ id: 'k', scopes: ['read'] }] }, /no usable token digest/);
  } finally {
    t.cleanup();
  }
});

test('serveCommand serves config-file and environment keys until its signal aborts', async () => {
  const t = tempDir();
  const engine = await openLocalEngine({ env: {}, overrides: { root: path.join(t.dir, 'root') } });
  try {
    const config = writeJson(t.dir, 'serve.json', {
      keys: [{ id: 'observer', tokenSha256: hashToken('tok-read'), scopes: ['read'] }],
      host: 'localhost',
      port: 8,
      serverNames: ['box.example'],
    });
    const lines = [];
    const out = { write: (d) => lines.push(String(d)) };
    const ac = new AbortController();
    const handlers = ['SIGTERM', 'SIGINT'].map((sig) => process.listenerCount(sig));
    const running = serveCommand({ engine, out }, ['--config', config, '--host', '127.0.0.1'], {
      env: { WORKBOX_PORT: '0', WORKBOX_TOKEN: 'tok-env' },
      signal: ac.signal,
    });
    const deadline = Date.now() + 10_000;
    while (!lines.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    const m = /^workbox server listening on http:\/\/127\.0\.0\.1:(\d+)\n$/.exec(lines.join(''));
    assert.ok(m, lines.join(''));
    const port = Number(m[1]);
    assert.notEqual(port, 8, 'WORKBOX_PORT outranks the config file');
    assert.equal(await status(port, '/readyz'), 200);
    assert.equal(await status(port, '/v1/sandboxes'), 401);
    assert.equal(await status(port, '/v1/sandboxes', { token: 'tok-wrong' }), 401);
    assert.equal(await status(port, '/v1/sandboxes', { token: 'tok-read' }), 200);
    assert.equal(await status(port, '/v1/sandboxes', { token: 'tok-env' }), 200);
    const named = { token: 'tok-read', host: `box.example:${port}` };
    assert.equal(await status(port, '/v1/sandboxes', named), 200);
    const foreign = { token: 'tok-read', host: `evil.example:${port}` };
    assert.equal(await status(port, '/v1/sandboxes', foreign), 403);
    ac.abort();
    await running;
    await assert.rejects(status(port, '/readyz'), { code: 'ECONNREFUSED' });
    assert.deepEqual(
      ['SIGTERM', 'SIGINT'].map((sig) => process.listenerCount(sig)),
      handlers,
      'the signal handlers are removed',
    );

    const stopped = new AbortController();
    stopped.abort();
    await serveCommand({ engine, out }, ['--port', '0'], { env: {}, signal: stopped.signal });
    assert.match(lines.at(-1), /listening on http:\/\/127\.0\.0\.1:\d+\n$/);
    await assert.rejects(
      serveCommand({ engine: null, out }, []),
      (e) => e.code === 'E_INVALID_PARAMS' && /takes no --server/.test(e.message),
    );
    await assert.rejects(
      serveCommand({ engine, out }, ['--config', path.join(t.dir, 'missing.json')], { env: {} }),
      { code: 'E_INVALID_PARAMS' },
    );
  } finally {
    engine.close();
    t.cleanup();
  }
});
