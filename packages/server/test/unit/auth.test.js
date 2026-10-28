import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAuth,
  hashToken,
  loadKeysFile,
  browserGuard,
  SCOPES,
  SCOPE_MATRIX,
} from '../../src/auth.js';

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
  for (const s of scopes) assert.ok(SCOPES.includes(s));
  for (const [key, scope] of Object.entries(SCOPE_MATRIX))
    if (scope === 'read') assert.match(key, /^GET /, key);
  assert.equal(SCOPE_MATRIX['POST /v1/sandboxes/:id/exec'], 'exec');
  assert.equal(SCOPE_MATRIX['DELETE /v1/sandboxes/:id'], 'admin');
  assert.equal(SCOPE_MATRIX['POST /v1/asks/:askId/answer'], 'answer');
  assert.equal(SCOPE_MATRIX['GET /v1/sandboxes/:id/sessions/:sessionId/ws'], 'exec');
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
