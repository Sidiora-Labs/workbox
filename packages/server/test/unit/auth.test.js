import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '@workbox/core';
import {
  createAuth,
  createStoredKey,
  newKeyToken,
  hashToken,
  loadKeysFile,
  browserGuard,
  SCOPES,
  SCOPE_MATRIX,
  ANY_KEY,
  FLEET_ROUTES,
  KEY_TOKEN,
  MAX_KEY_TTL_SECONDS,
} from '../../src/auth.js';
import { fakeClock } from '../../../core/test/helpers/tmp.js';

test('stored keys authenticate with their binding until they expire or are revoked', () => {
  const clock = fakeClock();
  const store = Store.open(':memory:', { clock });
  try {
    const auth = createAuth({
      keys: [{ id: 'root', token: 'admin-token', scopes: ['admin'] }],
      store,
    });
    assert.deepEqual(auth.authenticate('Bearer admin-token'), {
      id: 'root',
      scopes: ['admin'],
      binding: null,
      source: 'config',
      expiresAt: null,
    });
    const minted = createStoredKey(
      store,
      {
        name: 'agent',
        scopes: ['exec', 'read', 'exec'],
        labels: { team: 'a' },
        sandboxIds: ['sb-1', 'sb-1'],
        ttlSeconds: 60,
      },
      'root',
    );
    assert.match(minted.token, KEY_TOKEN);
    const binding = { labels: { team: 'a' }, sandboxIds: ['sb-1'] };
    assert.deepEqual(minted, {
      id: minted.id,
      name: 'agent',
      token: minted.token,
      scopes: ['exec', 'read'],
      binding,
      createdAt: clock(),
      expiresAt: clock() + 60_000,
    });
    assert.equal(store.getApiKeyByDigest(hashToken(minted.token)).id, minted.id);
    assert.equal(store.getApiKey(minted.id).createdBy, 'root');

    const bearer = `Bearer ${minted.token}`;
    const p = auth.authenticate(bearer);
    assert.deepEqual(p, {
      id: minted.id,
      scopes: ['exec', 'read'],
      binding,
      source: 'store',
      expiresAt: minted.expiresAt,
    });
    assert.ok(
      Object.isFrozen(p) && Object.isFrozen(p.binding) && Object.isFrozen(p.binding.labels),
    );
    assert.equal(store.getApiKey(minted.id).lastUsedAt, clock(), 'the use is recorded');
    assert.equal(auth.authorize(p, 'exec'), true);
    assert.equal(auth.authorize(p, 'admin'), false);
    assert.equal(auth.authorize(p, ANY_KEY), true);
    assert.equal(auth.authorize(null, ANY_KEY), false);
    assert.equal(auth.authenticate(`Bearer ${newKeyToken()}`), null, 'never stored');
    assert.equal(createAuth({}).authenticate(bearer), null, 'no store, no stored keys');

    clock.advance(59_999);
    assert.equal(auth.authenticate(bearer)?.id, minted.id);
    clock.advance(1);
    assert.equal(auth.authenticate(bearer), null, 'expired at expiresAt');

    const forever = createStoredKey(store, { name: 'ops', scopes: ['admin'] });
    assert.equal(forever.expiresAt, null);
    assert.equal(forever.binding, null);
    assert.equal(store.getApiKey(forever.id).createdBy, null);
    const ops = auth.authenticate(`Bearer ${forever.token}`);
    assert.equal(ops.source, 'store');
    assert.equal(ops.binding, null);
    store.revokeApiKey(forever.id);
    assert.equal(auth.authenticate(`Bearer ${forever.token}`), null, 'revoked at once');
  } finally {
    store.close();
  }
});

test('a stored key needs a name and known scopes; empty labels and ids leave it unbound', () => {
  const store = Store.open(':memory:');
  try {
    const bad = [
      [{ scopes: ['read'] }, /\$\.name/],
      [{ name: 'x', scopes: [] }, /\$\.scopes/],
      [{ name: 'x', scopes: ['root'] }, /\$\.scopes\[0\]/],
      [{ name: 'x', scopes: ['read'], ttlSeconds: 0 }, /ttlSeconds/],
      [{ name: 'x', scopes: ['read'], ttlSeconds: MAX_KEY_TTL_SECONDS + 1 }, /ttlSeconds/],
      [{ name: 'x', scopes: ['read'], ttlSeconds: 1.5 }, /ttlSeconds/],
      [{ name: 'x', scopes: ['read'], labels: { '': 'a' } }, /labels/],
      [{ name: 'x', scopes: ['read'], labels: { team: 1 } }, /labels\.team/],
      [{ name: 'x', scopes: ['read'], sandboxIds: [''] }, /sandboxIds/],
      [{ name: 'x', scopes: ['read'], extra: 1 }, /extra/],
    ];
    for (const [input, re] of bad)
      assert.throws(
        () => createStoredKey(store, input),
        (e) => e.code === 'E_INVALID_PARAMS' && re.test(e.message),
        JSON.stringify(input),
      );
    assert.equal(store.listApiKeys().length, 0);
    const open = createStoredKey(store, {
      name: 'x',
      scopes: ['read'],
      labels: {},
      sandboxIds: [],
    });
    assert.equal(open.binding, null);
    const tokens = new Set(Array.from({ length: 50 }, () => newKeyToken()));
    assert.equal(tokens.size, 50);
    for (const t of tokens) assert.match(t, KEY_TOKEN);
  } finally {
    store.close();
  }
});

test('bearer auth with hashed tokens and scope checks', () => {
  const auth = createAuth({
    keys: [
      { id: 'ro', token: 'read-token', scopes: ['read'] },
      { id: 'root', tokenSha256: hashToken('admin-token'), scopes: ['admin'] },
    ],
  });
  assert.equal(SCOPES.length, 4);
  assert.equal(auth.size, 2);
  const ro = auth.authenticate('Bearer read-token');
  assert.equal(ro.id, 'ro');
  assert.equal(auth.authorize(ro, 'read'), true);
  assert.equal(auth.authorize(ro, 'exec'), false);
  assert.equal(auth.authorize(null, 'read'), false);
  assert.equal(
    auth.authorize(auth.authenticate('Bearer admin-token'), 'exec'),
    true,
    'admin implies all',
  );
  assert.equal(auth.authenticate('Bearer wrong'), null);
  assert.equal(auth.authenticate('Basic read-token'), null);
  assert.equal(auth.authenticate(undefined), null);
  assert.throws(
    () => createAuth({ keys: [{ id: 'x', token: 't', scopes: ['nope'] }] }),
    /unknown scope/,
  );
  assert.throws(() => createAuth({ keys: [{ id: 'x', scopes: ['read'] }] }), /no usable token/);
});

test('scoped keys load from a config file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbox-keys-'));
  try {
    const file = path.join(dir, 'keys.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        keys: [{ id: 'f', tokenSha256: hashToken('file-token'), scopes: ['exec'] }],
      }),
    );
    assert.equal(loadKeysFile(file).length, 1);
    const auth = createAuth({ keysFile: file });
    assert.equal(auth.authenticate('Bearer file-token').id, 'f');
    fs.writeFileSync(file, '{"nokeys":1}');
    assert.throws(() => loadKeysFile(file), /expected/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the scope matrix: read observes only, exec runs, answer answers, admin mutates the fleet', () => {
  const scopes = new Set(Object.values(SCOPE_MATRIX));
  for (const s of scopes) assert.ok(SCOPES.includes(s) || s === ANY_KEY, s);
  for (const [key, scope] of Object.entries(SCOPE_MATRIX))
    if (scope === 'read' || scope === ANY_KEY) assert.match(key, /^GET /, key);
  assert.equal(SCOPE_MATRIX['POST /v1/sandboxes/:id/exec'], 'exec');
  assert.equal(SCOPE_MATRIX['DELETE /v1/sandboxes/:id'], 'admin');
  assert.equal(SCOPE_MATRIX['POST /v1/asks/:askId/answer'], 'answer');
  assert.equal(SCOPE_MATRIX['GET /v1/sandboxes/:id/sessions/:sessionId/ws'], 'exec');
  assert.equal(SCOPE_MATRIX['GET /v1/whoami'], ANY_KEY);
  for (const route of ['POST /v1/keys', 'GET /v1/keys', 'DELETE /v1/keys/:keyId'])
    assert.equal(SCOPE_MATRIX[route], 'admin', route);
  for (const route of FLEET_ROUTES) assert.ok(route in SCOPE_MATRIX, route);
  assert.deepEqual(
    FLEET_ROUTES.filter((r) => r.includes(':id')),
    [],
  );
});

test('H15 browser guard: Origin, Sec-Fetch-Site and foreign hosts are refused', () => {
  assert.equal(browserGuard({ host: '127.0.0.1:8080' }), null);
  assert.equal(browserGuard({ host: 'localhost' }), null);
  assert.equal(browserGuard({ host: '[::1]:80' }), null);
  assert.equal(browserGuard({ host: 'box.example:443' }, ['box.example']), null);
  assert.match(browserGuard({ host: 'localhost', origin: 'null' }), /Origin/);
  assert.match(browserGuard({ host: 'localhost', 'sec-fetch-site': 'none' }), /Sec-Fetch-Site/);
  assert.match(browserGuard({ host: 'evil.example' }), /evil\.example/);
  assert.match(browserGuard({ host: '127.0.0.1.evil.example' }), /not served/);
  assert.match(browserGuard({}), /missing Host/);
});
