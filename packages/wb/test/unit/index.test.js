import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as wb from '../../src/index.js';
import { WbClient } from '../../src/client.js';
import { main } from '../../src/main.js';

test('index re-exports the implementing modules', () => {
  assert.equal(wb.WbClient, WbClient);
  assert.equal(wb.main, main);
  assert.ok(Array.isArray(wb.COMMANDS));
  assert.ok(wb.PRESETS);
});
