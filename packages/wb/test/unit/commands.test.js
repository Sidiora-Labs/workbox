import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { Peer, PROTOCOL_VERSION } from '@workbox/protocol';
import { Runner } from '@workbox/runner';
import { WbClient } from '../../src/client.js';
import {
  splitAtDoubleDash,
  sessionCommand,
  parseOpts,
  runProcess,
  runCommand,
  exitStatus,
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

test('a command killed by a signal exits 128 + the signal number, never 0', async () => {
  assert.equal(exitStatus(0, null), 0);
  assert.equal(exitStatus(3, null), 3);
  assert.equal(exitStatus(null, 'SIGKILL'), 137);
  assert.equal(exitStatus(null, 'SIGTERM'), 143);
  assert.equal(exitStatus(null, null), 1);
  const { envelope, exitCode } = await runProcess(['sh', '-c', 'kill -KILL $$'], {
    out: { write() {} },
    err: { write() {} },
  });
  assert.equal(exitCode, null);
  assert.equal(envelope.exitCode, null);
  assert.equal(envelope.signal, 'SIGKILL');
  assert.equal(exitStatus(exitCode, envelope.signal), 137);
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

test('session attach on an exited session replays the spool, prints the exit and carries its status', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-attach-'));
  const socketPath = path.join(dir, 'runner.sock');
  const runner = new Runner({
    socketPath,
    boot: { bootId: 'b1', nonce: 'n1', sandboxId: 's1', protocol: PROTOCOL_VERSION },
    checks: async () => ({ ok: true, problems: [] }),
  });
  await runner.start();
  const hostSocket = net.connect(socketPath);
  await once(hostSocket, 'connect');
  const host = new Peer(hostSocket, { name: 'host' });
  const crashes = [];
  const onCrash = (e) => crashes.push(e);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  try {
    await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    await host.request('runner.go', {});
    const starter = new WbClient({ socketPath });
    const { sessionId } = await starter.request('session.start', {
      argv: ['sh', '-c', 'echo replayed-one; echo replayed-two >&2; exit 3'],
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { sessions } = await starter.request('session.list');
      if (sessions.find((x) => x.sessionId === sessionId)?.exited) break;
      assert.ok(Date.now() < deadline, 'session did not exit');
      await new Promise((r) => setTimeout(r, 20));
    }
    starter.close();

    for (let round = 0; round < 3; round++) {
      const out = [];
      const err = [];
      const client = new WbClient({ socketPath });
      const result = await sessionCommand(
        {
          client,
          out: { write: (d) => out.push(Buffer.from(d)) },
          err: { write: (d) => err.push(String(d)) },
        },
        ['attach', sessionId],
      );
      client.close();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(result.sessionId, sessionId);
      assert.equal(result.exited.code, 3);
      assert.equal(result.exitCode, 3);
      const text = Buffer.concat(out).toString();
      assert.match(text, /replayed-one\n/);
      assert.match(text, /replayed-two\n/);
      assert.equal(err.join(''), `wb: session ${sessionId} exited with code 3\n`);
    }
    assert.deepEqual(crashes, [], 'closing the client after the exit does not crash');
    await assert.rejects(
      sessionCommand({ client: new WbClient({ socketPath }), out: {}, err: {} }, ['attach']),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
  } finally {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
    host.close();
    await runner.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
