import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@workbox/core';
import { createServer } from '@workbox/server';
import { WorkboxClient } from '@workbox/sdk';
import { keyCommand, parseKeyCreate, parseTtl, KEY_USAGE } from '../../src/keys.js';
import { main, HELP } from '../../src/main.js';
import { openLocalEngine } from '../../src/local.js';

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

const invalid = (re) => (e) => e.code === 'E_INVALID_PARAMS' && re.test(e.message);

test('--ttl takes a whole number of seconds, minutes, hours or days', () => {
  assert.equal(parseTtl('3600s'), 3600);
  assert.equal(parseTtl('15m'), 900);
  assert.equal(parseTtl('12h'), 43_200);
  assert.equal(parseTtl('30d'), 2_592_000);
  for (const bad of ['', '30', '0d', '-1h', '1.5h', '2w', 'd', '01h'])
    assert.throws(() => parseTtl(bad), invalid(/--ttl/), bad);
});

test('key create flags repeat for scopes, labels and sandboxes', () => {
  assert.deepEqual(parseKeyCreate(['--name', 'agent', '--scope', 'read']), {
    name: 'agent',
    scopes: ['read'],
  });
  assert.deepEqual(
    parseKeyCreate([
      '--name',
      'agent',
      '--scope',
      'read',
      '--scope',
      'exec',
      '--label',
      'team=a',
      '--label',
      'expr=x=y',
      '--sandbox',
      'sb-1',
      '--sandbox',
      'sb-2',
      '--ttl',
      '12h',
    ]),
    {
      name: 'agent',
      scopes: ['read', 'exec'],
      labels: { team: 'a', expr: 'x=y' },
      sandboxIds: ['sb-1', 'sb-2'],
      ttlSeconds: 43_200,
    },
  );
  assert.deepEqual(parseKeyCreate(['--name', 'n', '--scope', 'read', '--label', 'empty=']).labels, {
    empty: '',
  });
  assert.throws(() => parseKeyCreate(['--scope', 'read']), invalid(/--name is required/));
  assert.throws(() => parseKeyCreate(['--name', 'n']), invalid(/at least one --scope/));
  assert.throws(() => parseKeyCreate(['--name']), invalid(/--name needs a value/));
  assert.throws(() => parseKeyCreate(['--name', 'n', '--bogus', 'x']), invalid(/unknown argument/));
  assert.throws(() => parseKeyCreate(['--name', 'n', 'stray']), invalid(/unknown argument stray/));
  for (const label of ['team', '=a'])
    assert.throws(
      () => parseKeyCreate(['--name', 'n', '--scope', 'read', '--label', label]),
      invalid(/must be key=value/),
      label,
    );
  assert.ok(KEY_USAGE.includes('workbox key rm <keyId>'));
  assert.match(HELP, /workbox key create --name N --scope S/);
  assert.match(HELP, /workbox key ls\|rm <keyId>/);
});

test('key create, ls and rm work on the local engine and through --server', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-keys-'));
  const engine = await openLocalEngine({ env: {}, overrides: { root: dir } });
  const app = createServer({
    manager: engine.manager,
    keys: [{ id: 'ops', token: 'cli-keys-admin', scopes: ['admin'] }],
    audit: engine.audit,
    logger: createLogger({ component: 'server', stream: { write() {} } }),
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const server = ['--server', `http://127.0.0.1:${port}`, '--token', 'cli-keys-admin'];
  const run = async (args, deps = {}) => {
    const out = capture();
    const err = capture();
    const code = await main(args, { out: out.stream, err: err.stream, ...deps });
    return { code, out: out.text(), err: err.text() };
  };
  try {
    const local = await run(
      ['key', 'create', '--name', 'agent', '--scope', 'read', '--label', 'team=a', '--ttl', '1h'],
      { engine },
    );
    assert.equal(local.code, 0, local.err);
    assert.match(local.err, /shown only this once/);
    const key = JSON.parse(local.out);
    assert.match(key.token, /^wbk_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(key.binding, { labels: { team: 'a' } });
    assert.equal(key.expiresAt - key.createdAt, 3_600_000);
    assert.equal(engine.store.getApiKey(key.id).createdBy, 'cli');

    const agent = new WorkboxClient({ baseUrl: `http://127.0.0.1:${port}`, token: key.token });
    const me = await agent.whoami();
    assert.equal(me.id, key.id, 'the running server accepts a key minted on its store at once');
    assert.equal(me.source, 'store');

    const remote = await run([
      'key',
      'create',
      '--name',
      'remote',
      '--scope',
      'admin',
      '--sandbox',
      'sb-1',
      '--json',
      ...server,
    ]);
    assert.equal(remote.code, 0, remote.err);
    assert.equal(remote.out.trim().includes('\n'), false, '--json prints one line');
    const remoteKey = JSON.parse(remote.out);
    assert.deepEqual(remoteKey.binding, { sandboxIds: ['sb-1'] });
    assert.equal(engine.store.getApiKey(remoteKey.id).createdBy, 'ops');

    const lsLocal = await run(['key', 'ls'], { engine });
    assert.equal(lsLocal.code, 0, lsLocal.err);
    assert.deepEqual(
      JSON.parse(lsLocal.out).keys.map((k) => k.id),
      [key.id, remoteKey.id],
    );
    const lsRemote = await run(['key', 'list', ...server]);
    assert.equal(lsRemote.code, 0, lsRemote.err);
    assert.deepEqual(JSON.parse(lsRemote.out), JSON.parse(lsLocal.out));
    for (const text of [lsLocal.out, lsRemote.out]) {
      assert.equal(text.includes(key.token), false);
      assert.equal(text.includes(remoteKey.token), false);
    }

    const bound = await run([
      'key',
      'ls',
      '--server',
      `http://127.0.0.1:${port}`,
      '--token',
      remoteKey.token,
    ]);
    assert.equal(bound.code, 4, 'a bound key may not list keys');
    assert.match(bound.err, /\(E_DENIED\)\n$/);

    const rm = await run(['key', 'rm', key.id], { engine });
    assert.equal(rm.code, 0, rm.err);
    assert.equal(typeof JSON.parse(rm.out).revokedAt, 'number');
    await assert.rejects(agent.whoami(), (e) => e.status === 401);
    const rmRemote = await run(['key', 'revoke', remoteKey.id, ...server]);
    assert.equal(rmRemote.code, 0, rmRemote.err);
    assert.equal(typeof JSON.parse(rmRemote.out).revokedAt, 'number');

    assert.equal((await run(['key', 'rm', 'key_none'], { engine })).code, 3);
    assert.equal((await run(['key', 'rm', 'key_none', ...server])).code, 3);
    const badScope = await run(['key', 'create', '--name', 'x', '--scope', 'root'], { engine });
    assert.equal(badScope.code, 2);
    assert.match(badScope.err, /scopes/);
    assert.equal((await run(['key', 'frob'], { engine })).code, 2);
    assert.equal((await run(['key', 'rm'], { engine })).code, 2);
    assert.equal((await run(['key', 'ls', 'extra'], { engine })).code, 2);
    await assert.rejects(keyCommand({}, ['ls']), invalid(/needs a local engine or --server/));
  } finally {
    await app.close();
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
