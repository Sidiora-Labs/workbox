import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as server from '../../src/index.js';
import { createServer, waitForSessionExit, writeSandboxFile } from '../../src/server.js';
import { WsSocket } from '../../src/ws.js';
import * as auth from '../../src/auth.js';
import * as access from '../../src/access.js';
import * as streams from '../../src/streams.js';
import * as webhooks from '../../src/webhooks.js';
import * as openapi from '../../src/openapi.js';
import { AUTH_FAILURE_DEFAULTS, addressKey, createFailureLimiter } from '../../src/ratelimit.js';

test('index re-exports', () => {
  assert.equal(server.createServer, createServer);
  assert.equal(server.WsSocket, WsSocket);
  assert.equal(server.SCOPE_MATRIX, auth.SCOPE_MATRIX);
  assert.equal(server.MAX_BODY_BYTES, 8 * 1024 * 1024);
  assert.equal(server.createFailureLimiter, createFailureLimiter);
  assert.equal(server.addressKey, addressKey);
  assert.equal(server.AUTH_FAILURE_DEFAULTS, AUTH_FAILURE_DEFAULTS);
  for (const name of [
    'createAuth',
    'createStoredKey',
    'newKeyToken',
    'ANY_KEY',
    'FLEET_ROUTES',
    'KEY_TOKEN',
    'KEY_CREATE_SCHEMA',
    'MAX_KEY_TTL_SECONDS',
  ])
    assert.equal(server[name], auth[name], name);
  for (const name of ['sandboxVisible', 'isBound', 'requireUnbound', 'createLabels'])
    assert.equal(server[name], access[name], name);
  assert.equal(server.FILE_CHUNK_BYTES, 4 * 1024 * 1024);
  assert.equal(server.DEFAULT_MAX_UPLOAD_BYTES, 1024 * 1024 * 1024);
  assert.equal(server.waitForSessionExit, waitForSessionExit);
  assert.equal(server.writeSandboxFile, writeSandboxFile);
  for (const name of [
    'EventHub',
    'EventFeed',
    'ReplayMerge',
    'pollEvents',
    'streamEvents',
    'eventsQuery',
    'eventFilter',
    'parseTypes',
    'typeMatcher',
    'drained',
    'MAX_EVENT_WAIT_MS',
    'REPLAY_PAGE',
    'MAX_TYPE_PATTERNS',
  ])
    assert.equal(server[name], streams[name], name);
  for (const name of [
    'createWebhook',
    'updateWebhook',
    'rotateWebhookSecret',
    'deleteWebhook',
    'listWebhooks',
    'ownedWebhook',
    'webhookVisible',
    'queueTestDelivery',
    'listDeliveries',
    'retryDelivery',
    'webhookHandlers',
    'WEBHOOK_CREATE_SCHEMA',
    'WEBHOOK_UPDATE_SCHEMA',
    'WEBHOOK_TYPE_PATTERN',
    'DELIVERY_STATUSES',
  ])
    assert.equal(server[name], webhooks[name], name);
  for (const name of [
    'buildOpenApi',
    'routeDocProblems',
    'allRoutes',
    'openApiPath',
    'patternOf',
    'toJsonSchema',
    'ROUTE_DOCS',
    'PUBLIC_ROUTES',
    'OPENAPI_PATH',
    'SERVER_VERSION',
    'BASE64_PATTERN',
  ])
    assert.equal(server[name], openapi[name], name);
});
