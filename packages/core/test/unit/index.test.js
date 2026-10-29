import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../../src/index.js';

test('index exports the foundation surface', () => {
  for (const name of [
    'WorkboxError',
    'E',
    'httpStatusFor',
    'loadConfig',
    'derivePaths',
    'merge',
    'deepFreeze',
    'DEFAULTS',
    'Redactor',
    'createLogger',
    'nullLogger',
    'errorToJSON',
    'Store',
    'SCHEMA_VERSION',
    'WebhookDispatcher',
    'newWebhookSecret',
    'signWebhook',
    'resolveTarget',
    'isPublicAddress',
    'NOT_PUBLIC_RANGES',
    'Audit',
    'canonicalJSON',
    'hashEntry',
    'States',
    'Health',
    'TRANSITIONS',
    'canTransition',
    'assertTransition',
    'isLive',
    'isTerminal',
  ]) {
    assert.ok(name in core, name);
  }
});
