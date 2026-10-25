import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../../src/index.js';

test('runner index exports', () => {
  assert.deepEqual(Object.keys(runner).sort(), [
    'DEFAULT_BOOT_FILE',
    'EXPECTED_CAPS',
    'LEVELS',
    'RUNNER_VERSION',
    'Runner',
    'createLog',
    'main',
    'parseArgs',
    'probeMount',
    'readBootFile',
    'readIdMap',
    'readMounts',
    'readStatus',
    'selfChecks',
  ]);
});
