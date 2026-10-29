import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../../src/index.js';
import { createServer } from '../../src/server.js';
import { WsSocket } from '../../src/ws.js';
import * as auth from '../../src/auth.js';
import * as access from '../../src/access.js';

test('index re-exports', () => {
  assert.equal(server.createServer, createServer);
  assert.equal(server.WsSocket, WsSocket);
  assert.equal(server.SCOPE_MATRIX, auth.SCOPE_MATRIX);
  assert.equal(server.MAX_BODY_BYTES, 8 * 1024 * 1024);
  for (const name of [
    'createAuth',
    'createStoredKey',
    'newKeyToken',
    'ANY_KEY',
    'FLEET_ROUTES',
    'KEY_TOKEN',
    'KEY_CREATE_SCHEMA',
    'MAX_KEY_TTL_SECONDS',
  ])
    assert.equal(server[name], auth[name], name);
  for (const name of ['sandboxVisible', 'isBound', 'requireUnbound', 'createLabels'])
    assert.equal(server[name], access[name], name);
});
