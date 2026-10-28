import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cli from '../../src/index.js';
import { main } from '../../src/main.js';

test('index re-exports main', () => {
  assert.equal(cli.main, main);
});
