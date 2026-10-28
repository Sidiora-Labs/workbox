import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkboxError } from '@workbox/core';
import { createServer } from '@workbox/server';
import { main, exitCodeForError, HELP } from '../../src/main.js';
import { openLocalEngine } from '../../src/local.js';

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

test('--help/--version, unknown command exit 2, remote sandbox ls', async () => {
  const o = capture();
  const e = capture();
  assert.equal(await main(['--help'], { out: o.stream, err: e.stream }), 0);
  assert.match(o.text(), /workbox sandbox/);
  assert.ok(HELP.includes('serve'));
  assert.equal(await main(['--version'], { out: o.stream, err: e.stream }), 0);
  assert.equal(await main(['bogus'], { out: o.stream, err: e.stream }), 2);
  const o2 = capture();
  const client = { listSandboxes: async () => ({ items: [], complete: true }) };
  assert.equal(await main(['sandbox', 'ls'], { out: o2.stream, err: e.stream, client }), 0);
  assert.match(o2.text(), /items/);
  assert.equal(exitCodeForError({ code: 'E_NOT_FOUND' }), 3);
});

test('every error code family maps to its documented exit code', () => {
  const exit = (code) => exitCodeForError(new WorkboxError(code, `failed with ${code}`));
  assert.equal(exit('E_INVALID_PARAMS'), 2);
  assert.equal(exit('E_PARSE'), 2);
  assert.equal(exit('E_NOT_FOUND'), 3);
  for (const code of ['E_DENIED', 'E_QUARANTINED', 'E_UNAVAILABLE', 'E_CLOSED'])
    assert.equal(exit(code), 4, code);
  assert.equal(exit('E_TIMEOUT'), 5);
  assert.equal(exit('E_CONFLICT'), 1);
  assert.equal(exitCodeForError(new Error('no code')), 1);
  assert.equal(exitCodeForError(undefined), 1);
});

async function tempEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-main-'));
  const engine = await openLocalEngine({ env: {}, overrides: { root: dir } });
  return {
    engine,
    cleanup: () => {
      engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a supplied local engine serves commands and stays open; codeless errors exit 1', async () => {
  const { engine, cleanup } = await tempEngine();
  try {
    const o = capture();
    const e = capture();
    assert.equal(
      await main(['sandbox', 'frobnicate'], { out: o.stream, err: e.stream, engine }),
      1,
    );
    assert.equal(e.text(), 'workbox: unknown sandbox subcommand frobnicate\n');
    assert.equal(o.text(), '');
    const e2 = capture();
    assert.equal(
      await main(['sandbox', 'inspect', 'nope'], { out: o.stream, err: e2.stream, engine }),
      3,
    );
    assert.match(e2.text(), /^workbox: .* \(E_NOT_FOUND\)\n$/);
    const o3 = capture();
    assert.equal(
      await main(['sandbox', 'ls', '--json'], { out: o3.stream, err: e.stream, engine }),
      0,
    );
    assert.deepEqual(JSON.parse(o3.text()).items, []);
    assert.equal(o3.text().trim().includes('\n'), false, '--json prints one compact line');
    assert.equal(engine.store.listSandboxes().items.length, 0, 'main did not close the engine');
  } finally {
    cleanup();
  }
});

test('remote mode falls back to WORKBOX_TOKEN, and to no token at all', async () => {
  const { engine, cleanup } = await tempEngine();
  const app = createServer({
    manager: engine.manager,
    keys: [{ id: 'ops', token: 'tok-from-env', scopes: ['read'] }],
    audit: engine.audit,
  });
  const addr = await app.listen(0, '127.0.0.1');
  const remote = ['sandbox', 'ls', '--server', `http://127.0.0.1:${addr.port}`];
  const saved = process.env.WORKBOX_TOKEN;
  try {
    process.env.WORKBOX_TOKEN = 'tok-from-env';
    const o = capture();
    const e = capture();
    assert.equal(await main(remote, { out: o.stream, err: e.stream }), 0, e.text());
    assert.deepEqual(JSON.parse(o.text()).items, []);
    delete process.env.WORKBOX_TOKEN;
    const e2 = capture();
    assert.equal(await main(remote, { out: o.stream, err: e2.stream }), 4);
    assert.match(e2.text(), /\(E_DENIED\)\n$/);
  } finally {
    if (saved === undefined) delete process.env.WORKBOX_TOKEN;
    else process.env.WORKBOX_TOKEN = saved;
    await app.close();
    cleanup();
  }
});
