import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../../src/index.js';

test('runner index exports', () => {
  assert.deepEqual(Object.keys(runner).sort(), [
    'DEFAULT_BOOT_FILE',
    'DEFAULT_SPOOL_BYTES',
    'DEFAULT_STOP_GRACE_MS',
    'EXPECTED_CAPS',
    'LEVELS',
    'MAX_READ_BYTES',
    'RUNNER_VERSION',
    'RingSpool',
    'Runner',
    'SessionManager',
    'createFs',
    'createLog',
    'decodeBase64',
    'main',
    'parseArgs',
    'probeMount',
    'ptyArgv',
    'readBootFile',
    'readIdMap',
    'readMounts',
    'readStatus',
    'resizePty',
    'selfChecks',
    'shellQuote',
    'spawnPty',
  ]);
});
