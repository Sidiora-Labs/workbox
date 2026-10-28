import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../../src/index.js';
import { createServer } from '../../src/server.js';

test('index re-exports', () => {
  assert.equal(server.createServer, createServer);
  assert.equal(server.MAX_BODY_BYTES, 8 * 1024 * 1024);
});
