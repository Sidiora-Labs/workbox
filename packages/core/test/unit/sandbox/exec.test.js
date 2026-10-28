import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once, EventEmitter } from 'node:events';
import { Peer, PROTOCOL_VERSION } from '@workbox/protocol';
import { Runner } from '@workbox/runner';
import {
  exec,
  DEFAULT_EXEC_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
} from '../../../src/sandbox/exec.js';

/**
 * exec() against a real Runner on the host: a Peer over a unix socket plays the supervisor role
 * (request + event re-emission), exactly the surface Supervisor exposes.
 */
async function runnerTarget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-exec-'));
  const socket = path.join(dir, 'r.sock');
  const boot = {
    bootId: 'B'.repeat(26),
    nonce: 'n'.repeat(64),
    sandboxId: 'S'.repeat(26),
    protocol: PROTOCOL_VERSION,
  };
  const runner = new Runner({
    socketPath: socket,
    boot,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    checks: async () => ({ ok: true }),
  });
  await runner.start();
  const sock = net.connect(socket);
  await once(sock, 'connect');
  const peer = new Peer(sock, { name: 'host' });
  await peer.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
  await peer.request('runner.go', {});
  const target = new EventEmitter();
  target.request = (m, p, o) => peer.request(m, p, o);
  peer.on('event', (m, p) => target.emit('event', m, p));
  return {
    target,
    runner,
    cleanup: async () => (
      peer.close(), await runner.stop(), fs.rmSync(dir, { recursive: true, force: true })
    ),
  };
}

test('exec captures both streams, exit code, input and cleans up its session', async () => {
  const { target, runner, cleanup } = await runnerTarget();
  try {
    const r = await exec(target, {
      argv: ['sh', '-c', 'cat; echo err >&2; exit 7'],
      input: 'from stdin',
    });
    assert.equal(r.exitCode, 7);
    assert.equal(r.signal, null);
    assert.equal(r.stdout, 'from stdin');
    assert.equal(r.stderr, 'err\n');
    assert.deepEqual(r.truncated, { stdout: false, stderr: false });
    assert.equal(r.timedOut, false);
    assert.ok(r.durationMs >= 0);
    assert.equal(runner.sessions.list().length, 0, 'exec removed its session');
    assert.equal(DEFAULT_EXEC_TIMEOUT_MS, 60_000);
    assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1024 * 1024);
    await assert.rejects(exec(target, { argv: [] }), (e) => e.code === 'E_INVALID_PARAMS');
    await assert.rejects(
      exec(target, { argv: ['definitely-not-a-binary-xyz'] }),
      (e) => e.code === 'E_NOT_FOUND',
    );
  } finally {
    await cleanup();
  }
});

test('exec truncates bounded output and reports a timeout with the stop signal', async () => {
  const { target, runner, cleanup } = await runnerTarget();
  try {
    const big = await exec(target, {
      argv: ['sh', '-c', 'head -c 5000 /dev/zero | tr "\\0" a; echo; echo small >&2'],
      maxOutputBytes: 1000,
    });
    assert.equal(big.stdout.length, 1000);
    assert.deepEqual(big.truncated, { stdout: true, stderr: false });
    assert.equal(big.stderr, 'small\n');
    const t0 = Date.now();
    const slow = await exec(target, {
      argv: ['sh', '-c', 'echo started; sleep 30'],
      timeoutMs: 200,
      graceMs: 100,
    });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.stdout, 'started\n');
    assert.equal(slow.signal, 'SIGTERM');
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(runner.sessions.list().length, 0);
    const fast = await exec(target, { argv: ['true'], timeoutMs: 5000 });
    assert.equal(fast.exitCode, 0);
    const env = await exec(target, {
      argv: ['sh', '-c', 'echo $A; pwd'],
      env: { A: 'b' },
      cwd: '/tmp',
    });
    assert.equal(env.stdout, 'b\n/tmp\n');
  } finally {
    await cleanup();
  }
});
