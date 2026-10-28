import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, findCommand, toolsJson, toolsText, helpFor } from '../../src/registry.js';

test('every spec subcommand is registered with summary and usage', () => {
  const names = COMMANDS.map((c) => c.name);
  for (const n of [
    'status',
    'tools',
    'help',
    'session',
    'run',
    'ask',
    'secret',
    'event',
    'lease',
    'checkpoint',
    'artifact',
    'net',
    'preset',
  ])
    assert.ok(names.includes(n), n);
  for (const c of COMMANDS) {
    assert.ok(c.summary.length > 0, c.name);
    assert.ok(c.usage.startsWith('wb '), c.name);
  }
  const json = toolsJson();
  assert.equal(json.schema, 1);
  assert.equal(json.tools.length, COMMANDS.length);
  assert.match(toolsText(), /preset/);
  assert.match(helpFor(findCommand('run')), /wb run --/);
  assert.equal(findCommand('nope'), null);
});
