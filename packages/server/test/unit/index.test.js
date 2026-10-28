import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../../src/index.js';
import { createServer } from '../../src/server.js';
import { WsSocket } from '../../src/ws.js';
import { SCOPE_MATRIX } from '../../src/auth.js';

test('index re-exports', () => {
  assert.equal(server.createServer, createServer);
  assert.equal(server.WsSocket, WsSocket);
  assert.equal(server.SCOPE_MATRIX, SCOPE_MATRIX);
  assert.equal(server.MAX_BODY_BYTES, 8 * 1024 * 1024);
});
