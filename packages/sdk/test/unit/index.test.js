import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sdk from '../../src/index.js';
import * as client from '../../src/client.js';
import { WorkboxApiError } from '../../src/errors.js';
import * as agents from '../../src/agents.js';
import * as webhooks from '../../src/webhooks.js';

test('index re-exports the client, its handles and the error', () => {
  for (const name of [
    'WorkboxClient',
    'Sandbox',
    'SandboxSession',
    'SessionStream',
    'EventStream',
    'ROUTES',
    'retryDelay',
  ])
    assert.equal(sdk[name], client[name], name);
  assert.equal(sdk.WorkboxApiError, WorkboxApiError);
  for (const name of ['AGENTS', 'AGENT_CWD', 'agentSandboxInput', 'agentSessionParams'])
    assert.equal(sdk[name], agents[name], name);
  for (const name of [
    'verifyWebhook',
    'WebhookVerificationError',
    'WEBHOOK_SECRET_PREFIX',
    'WEBHOOK_TOLERANCE_SECONDS',
  ])
    assert.equal(sdk[name], webhooks[name], name);
});
