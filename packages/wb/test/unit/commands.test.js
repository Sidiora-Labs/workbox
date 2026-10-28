import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  splitAtDoubleDash,
  parseOpts,
  runProcess,
  runCommand,
  statusCommand,
  eventCommand,
  askCommand,
} from '../../src/commands.js';

function fakeClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    async connect() {},
    async request(method, params) {
      calls.push({ method, params });
      if (handlers[method]) return handlers[method](params);
      if (method === 'broker.artifact.put') return { sha256: params.sha256, size: params.size };
      if (method === 'broker.evidence.record') return { id: 'ev1' };
      return { ok: true, method };
    },
    onEvent() {
      return () => {};
    },
  };
}

test('argv parsing helpers', () => {
  assert.deepEqual(splitAtDoubleDash(['--name', 'x', '--', 'echo', 'hi']), {
    opts: ['--name', 'x'],
    rest: ['echo', 'hi'],
  });
  const { opts, positional } = parseOpts(['--kind', 'decision', 'title words'], new Set(['kind']));
  assert.deepEqual(opts.kind, ['decision']);
  assert.deepEqual(positional, ['title words']);
});

test('runProcess builds a correct evidence envelope', async () => {
  const chunks = [];
  const { envelope, exitCode } = await runProcess(['sh', '-c', 'echo out; echo err >&2; exit 3'], {
    out: { write: (d) => chunks.push(d) },
    err: { write: (d) => chunks.push(d) },
  });
  assert.equal(exitCode, 3);
  assert.equal(envelope.exitCode, 3);
  assert.equal(envelope.stdoutSha256, createHash('sha256').update('out\n').digest('hex'));
  assert.equal(envelope.stderrSha256, createHash('sha256').update('err\n').digest('hex'));
  assert.ok(envelope.durationMs >= 0);
});

test('runCommand stores the log and records evidence; status/ask/event route to broker', async () => {
  const client = fakeClient({ 'runner.status': () => ({ sandboxId: 's' }) });
  const ctx = {
    client,
    out: { write() {} },
    err: { write() {} },
    outboxDir: '/tmp/wb-test-outbox',
  };
  const out = await runCommand(ctx, ['--', 'sh', '-c', 'echo hello']);
  assert.equal(out.evidence.id, 'ev1');
  assert.ok(out.artifact.sha256);
  assert.ok(client.calls.some((c) => c.method === 'broker.evidence.record'));
  await statusCommand(ctx);
  await eventCommand(ctx, ['emit', 'build.done', '{"ok":true}']);
  await askCommand(ctx, ['raise', '--kind', 'question', 'why?']);
  assert.ok(client.calls.some((c) => c.method === 'broker.event.emit'));
  assert.ok(client.calls.some((c) => c.method === 'broker.ask.raise'));
  await assert.rejects(() => runCommand(ctx, []), /requires a command/);
});
