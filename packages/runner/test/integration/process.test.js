import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@workbox/protocol';
import { bootFixture, connectPeer } from '../helpers/boot.js';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.js');

/**
 * The runner as a real child process, driven over its socket by two clients: the host control
 * channel and a local client, exactly as the supervisor and wb will.
 */
test('runner process: boot, handshake, local client, SIGTERM shutdown', async () => {
  const fx = bootFixture();
  const child = spawn(process.execPath, [MAIN, '--boot', fx.bootFile, '--log-level', 'debug'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  try {
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(fx.socket) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(fx.socket), `socket appeared; stderr: ${stderr}`);
    assert.equal(fs.existsSync(fx.bootFile), false);

    const host = await connectPeer(fx.socket, 'host');
    const hello = await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    assert.equal(hello.pid, child.pid);
    assert.equal(hello.nonce, fx.boot.nonce);
    const go = await host.request('runner.go', { network: { mode: 'none' } });
    assert.equal(go.ready, true);
    assert.equal(
      go.checks.ok,
      false,
      'not inside a sandbox, so the real self-checks fail honestly',
    );
    assert.ok(go.checks.problems.length > 0);

    const local = await connectPeer(fx.socket, 'local');
    const status = await local.request('runner.status', {});
    assert.equal(status.phase, 'ready');
    assert.equal(status.connections, 2);
    local.close();
    host.close();

    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(fs.existsSync(fx.socket), false);
    const lines = stderr
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.msg === 'listening'));
    assert.ok(lines.some((l) => l.msg === 'ready'));
    assert.ok(lines.some((l) => l.msg === 'signal' && l.signal === 'SIGTERM'));
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    fx.cleanup();
  }
});

test('runner process exits 1 with a JSON error when the boot file is unusable', async () => {
  const fx = bootFixture();
  fs.writeFileSync(fx.bootFile, '{"bootId":"only"}');
  const child = spawn(process.execPath, [MAIN, '--boot', fx.bootFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const [code] = await once(child, 'exit');
  fx.cleanup();
  assert.equal(code, 1);
  const rec = JSON.parse(stderr.trim().split('\n').pop());
  assert.equal(rec.level, 'error');
  assert.match(rec.error, /lacks nonce/);
});
