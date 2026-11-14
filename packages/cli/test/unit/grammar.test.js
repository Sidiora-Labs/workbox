import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCommand } from '../../src/grammar.js';

test('contextual help does not need valid operands or a server', () => {
  for (const args of [
    ['sandbox', '--help'],
    ['sandbox', 'create', '--help'],
    ['serve', '-h'],
    ['key', 'create', '--help'],
    ['webhook', 'create', '--help'],
    ['agent', '--help'],
  ])
    assert.match(validateCommand(args), /workbox/);
  assert.match(validateCommand(['sandbox', 'create', '--help']), /--network VALUE/);
});

test('unknown flags, values and missing operands fail before dispatch', () => {
  for (const args of [
    ['sandbox', 'create', '--netwrok', 'none'],
    ['sandbox', 'create', '--network', 'typo'],
    ['serve', '--port'],
    ['sandbox', 'rm'],
    ['sandbox', 'create', 'unexpected'],
    ['sandbox', 'run', 'sb', '--'],
    ['sandbox', 'exec', 'sb'],
    ['sandbox', 'unknown'],
    ['unknown'],
    ['agent', 'codex', '--secret'],
  ])
    assert.throws(() => validateCommand(args), { code: 'E_INVALID_PARAMS' });
});

test('child arguments stay opaque and existing command aliases are accepted', () => {
  for (const args of [
    ['sandbox', 'exec', 'sb', '--', 'node', '--version', '--help', '--server', 'child'],
    ['sandbox', 'exec', 'sb', 'node', '--version'],
    ['sandbox', 'exec', 'sb', 'node', '--help'],
    ['sandbox', 'run', 'sb', '--wait', '--', 'node', '--help'],
    ['sandbox', 'create', '--network', 'none', '--server', 'http://localhost', '--token', 'test'],
    ['key', 'revoke', 'key-1'],
    ['webhook', 'delete', 'hook-1'],
    ['webhook', 'rotate-secret', 'hook-1'],
    ['events', '-f', '--type', 'session.*'],
    ['agent', 'codex', '-p', 'do the work', '--no-secret'],
  ])
    assert.equal(validateCommand(args), null);
});
