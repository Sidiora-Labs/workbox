import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as mcp from '../../src/index.js';

test('index re-exports tools and server', () => {
  assert.deepEqual(
    [...mcp.TOOL_NAMES],
    ['sandbox_create', 'sandbox_list', 'sandbox_exec', 'sandbox_destroy'],
  );
  assert.equal(typeof mcp.handleMessage, 'function');
});
