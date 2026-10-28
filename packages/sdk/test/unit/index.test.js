import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../../src/index.js';
import { WorkboxClient } from '../../src/client.js';

test('index re-exports client', () => {
  assert.equal(sdk.WorkboxClient, WorkboxClient);
});
