import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../src/index.js';

test('index exports the public surface', () => {
  const expected = [
    'Codes',
    'ProtocolError',
    'isProtocolError',
    'newId',
    'isId',
    'idTime',
    'encodeFrame',
    'LineDecoder',
    'DEFAULT_MAX_LINE_BYTES',
    'request',
    'ok',
    'fail',
    'event',
    'isRequest',
    'isResponse',
    'isEvent',
    'kindOf',
    'v',
    'validate',
    'assertValid',
    'Peer',
    'CANCEL_METHOD',
    'DEFAULT_TIMEOUT_MS',
    'Redactor',
    'RedactStream',
    'Methods',
    'Events',
    'PROTOCOL_VERSION',
    'SESSION_READ_DEFAULT_BYTES',
    'SESSION_READ_MAX_BYTES',
    'validateParams',
    'isBrokerMethod',
    'methodNames',
  ];
  assert.deepEqual(Object.keys(api).sort(), [...expected].sort());
});
