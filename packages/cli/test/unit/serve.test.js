import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { hashToken } from '@workbox/server';
import { selfSigned } from '../../../server/test/helpers/tls.js';
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

/** GET `target` over HTTPS trusting only `ca`; resolves with the status and the certificate seen. */
function tlsStatus(port, target, { token, ca }) {
  const headers = { host: `127.0.0.1:${port}` };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: '127.0.0.1', port, path: target, headers, ca, agent: false },
      (res) => {
        const peer = res.socket.getPeerCertificate().fingerprint256;
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, peer }));
      },
    );
    req.on('error', reject);
  });
}

async function until(cond, what) {
  const deadline = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
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

test('loadServeConfig reads tls file paths, relative to the config file, and fails closed', () => {
  const t = tempDir();
  try {
    const abs = { certFile: '/etc/workbox/tls/cert.pem', keyFile: '/etc/workbox/tls/key.pem' };
    assert.deepEqual(loadServeConfig(writeJson(t.dir, 'abs.json', { tls: abs })).tls, abs);
    const rel = { tls: { certFile: 'cert.pem', keyFile: 'tls/key.pem' } };
    assert.deepEqual(loadServeConfig(writeJson(t.dir, 'rel.json', rel)).tls, {
      certFile: path.join(t.dir, 'cert.pem'),
      keyFile: path.join(t.dir, 'tls', 'key.pem'),
    });
    assert.equal('tls' in loadServeConfig(writeJson(t.dir, 'none.json', {})), false);
    const invalid = (name, tls, pattern) =>
      assert.throws(
        () => loadServeConfig(writeJson(t.dir, name, { tls })),
        (e) => e.code === 'E_INVALID_PARAMS' && pattern.test(e.message),
        name,
      );
    invalid('string.json', 'cert.pem', /tls must be an object with certFile and keyFile/);
    invalid('null.json', null, /tls must be an object/);
    invalid('array.json', ['a', 'b'], /tls must be an object/);
    invalid('nokey.json', { certFile: 'a.pem' }, /tls\.keyFile must be a non-empty path/);
    invalid('empty.json', { certFile: '', keyFile: 'b.pem' }, /tls\.certFile must be/);
    invalid('extra.json', { certFile: 'a', keyFile: 'b', ca: 'c' }, /unknown key tls\.ca/);
  } finally {
    t.cleanup();
  }
});

test('serveCommand serves HTTPS and reloads its certificate on SIGHUP, keeping it on failure', async () => {
  const t = tempDir();
  const engine = await openLocalEngine({ env: {}, overrides: { root: path.join(t.dir, 'root') } });
  try {
    const first = selfSigned(t.dir, 'first');
    const second = selfSigned(t.dir, 'second');
    const ca = [first.cert, second.cert];
    const certFile = path.join(t.dir, 'live.crt');
    const keyFile = path.join(t.dir, 'live.key');
    fs.copyFileSync(first.certFile, certFile);
    fs.copyFileSync(first.keyFile, keyFile);
    const config = writeJson(t.dir, 'serve.json', {
      tls: { certFile: 'live.crt', keyFile: 'live.key' },
    });
    const lines = [];
    const errs = [];
    const out = { write: (d) => lines.push(String(d)) };
    const err = { write: (d) => errs.push(String(d)) };
    const hup = process.listenerCount('SIGHUP');
    const ac = new AbortController();
    const running = serveCommand({ engine, out, err }, ['--config', config, '--port', '0'], {
      env: { WORKBOX_TOKEN: 'tok-env' },
      signal: ac.signal,
    });
    await until(() => lines.length, 'the startup line');
    const m = /^workbox server listening on https:\/\/127\.0\.0\.1:(\d+)\n$/.exec(lines[0]);
    assert.ok(m, lines[0]);
    const port = Number(m[1]);
    assert.equal(process.listenerCount('SIGHUP'), hup + 1);
    assert.deepEqual(await tlsStatus(port, '/v1/sandboxes', { token: 'tok-env', ca }), {
      status: 200,
      peer: first.fingerprint,
    });

    fs.copyFileSync(second.certFile, certFile);
    fs.copyFileSync(second.keyFile, keyFile);
    process.kill(process.pid, 'SIGHUP');
    await until(() => lines.some((l) => /reloaded its TLS certificate/.test(l)), 'the reload');
    assert.equal((await tlsStatus(port, '/healthz', { ca })).peer, second.fingerprint);

    fs.writeFileSync(certFile, 'not a certificate\n');
    process.kill(process.pid, 'SIGHUP');
    await until(() => errs.length === 1, 'the failed reload');
    assert.match(
      errs[0],
      /^workbox serve: TLS reload failed, keeping the old certificate: invalid TLS certificate or key/,
    );
    fs.copyFileSync(second.certFile, certFile);
    fs.rmSync(keyFile);
    process.kill(process.pid, 'SIGHUP');
    await until(() => errs.length === 2, 'the second failed reload');
    assert.match(errs[1], /cannot read the TLS key .*live\.key/);
    assert.equal((await tlsStatus(port, '/healthz', { ca })).peer, second.fingerprint);
    ac.abort();
    await running;
    assert.equal(process.listenerCount('SIGHUP'), hup, 'the SIGHUP handler is removed');

    const stopped = new AbortController();
    stopped.abort();
    const flags = ['--port', '0', '--tls-cert', first.certFile, '--tls-key', first.keyFile];
    await serveCommand({ engine, out, err }, ['--config', config, ...flags], {
      env: {},
      signal: stopped.signal,
    });
    assert.match(lines.at(-1), /^workbox server listening on https:\/\/127\.0\.0\.1:\d+\n$/);
    const refused = (args, pattern) =>
      assert.rejects(
        serveCommand({ engine, out, err }, ['--port', '0', ...args], {
          env: {},
          signal: stopped.signal,
        }),
        (e) => e.code === 'E_INVALID_PARAMS' && pattern.test(e.message),
        args.join(' '),
      );
    await refused(['--tls-cert', first.certFile], /both a certificate \(--tls-cert\) and a key/);
    await refused(['--tls-key', first.keyFile], /both a certificate/);
    await refused(
      ['--tls-cert', path.join(t.dir, 'missing.crt'), '--tls-key', first.keyFile],
      /cannot read the TLS certificate/,
    );
    await refused(
      ['--tls-cert', first.certFile, '--tls-key', second.keyFile],
      /invalid TLS certificate or key/,
    );
    assert.equal(errs.length, 2, 'TLS on loopback prints no warning');
  } finally {
    engine.close();
    t.cleanup();
  }
});

test('serveCommand warns on stderr when it listens beyond loopback without TLS', async () => {
  const t = tempDir();
  const engine = await openLocalEngine({ env: {}, overrides: { root: path.join(t.dir, 'root') } });
  try {
    const cert = selfSigned(t.dir, 'cert');
    const lines = [];
    const errs = [];
    const ctx = {
      engine,
      out: { write: (d) => lines.push(String(d)) },
      err: { write: (d) => errs.push(String(d)) },
    };
    const stopped = new AbortController();
    stopped.abort();
    const once = { env: {}, signal: stopped.signal };
    await serveCommand(ctx, ['--host', '0.0.0.0', '--port', '0'], once);
    assert.equal(errs.length, 1);
    assert.match(
      errs[0],
      /^workbox serve: warning: listening on 0\.0\.0\.0 without TLS; .*--tls-cert and --tls-key.*\n$/,
    );
    assert.equal(errs[0].split('\n').length, 2, 'one line');
    await serveCommand(ctx, ['--port', '0'], once);
    const tls = ['--tls-cert', cert.certFile, '--tls-key', cert.keyFile];
    await serveCommand(ctx, ['--host', '0.0.0.0', '--port', '0', ...tls], once);
    assert.match(lines.at(-1), /listening on https:\/\/0\.0\.0\.0:\d+\n$/);
    assert.equal(errs.length, 1, 'no warning on loopback or with TLS');
  } finally {
    engine.close();
    t.cleanup();
  }
});
