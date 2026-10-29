import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../../src/index.js';
import { createServer, waitForSessionExit, writeSandboxFile } from '../../src/server.js';
import { WsSocket } from '../../src/ws.js';
import { SCOPE_MATRIX } from '../../src/auth.js';

test('index re-exports', () => {
  assert.equal(server.createServer, createServer);
  assert.equal(server.WsSocket, WsSocket);
  assert.equal(server.SCOPE_MATRIX, SCOPE_MATRIX);
  assert.equal(server.MAX_BODY_BYTES, 8 * 1024 * 1024);
  assert.equal(server.FILE_CHUNK_BYTES, 4 * 1024 * 1024);
  assert.equal(server.DEFAULT_MAX_UPLOAD_BYTES, 1024 * 1024 * 1024);
  assert.equal(server.waitForSessionExit, waitForSessionExit);
  assert.equal(server.writeSandboxFile, writeSandboxFile);
});
