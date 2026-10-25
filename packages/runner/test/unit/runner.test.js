import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROTOCOL_VERSION } from '@workbox/protocol';
import { Runner, RUNNER_VERSION } from '../../src/runner.js';
import { createLog } from '../../src/log.js';
import { bootFixture, connectPeer } from '../helpers/boot.js';

const quiet = createLog({ level: 'silent', stream: { write: () => undefined } });

test('boot barrier, control channel, nonce once, status and shutdown', async () => {
  const fx = bootFixture();
  const checks = async () => ({ ok: true, problems: [], pid: 2 });
  const runner = new Runner({
    socketPath: fx.socket,
    boot: fx.boot,
    log: quiet,
    checks,
    clock: () => 1000,
  });
  try {
    await runner.start();
    assert.equal(fs.statSync(fx.socket).mode & 0o777, 0o600);
    assert.equal(runner.phase, 'boot');
    const local = await connectPeer(fx.socket, 'local');
    const asLocal = await local.request('runner.hello', { protocol: PROTOCOL_VERSION });
    assert.equal(asLocal.role, 'local');
    assert.equal(asLocal.nonce, null);
    assert.equal(asLocal.phase, 'boot');
    await assert.rejects(local.request('runner.go', {}), (e) => e.code === 'E_DENIED');
    await assert.rejects(local.request('runner.shutdown', {}), (e) => e.code === 'E_DENIED');
    await assert.rejects(
      local.request('runner.hello', { protocol: 99 }),
      (e) => e.code === 'E_UNSUPPORTED' && e.data.supported === PROTOCOL_VERSION,
    );
    await assert.rejects(
      local.request('runner.hello', { protocol: 'x' }),
      (e) => e.code === 'E_INVALID_PARAMS',
    );
    await assert.rejects(
      local.request('session.start', { argv: ['sh'] }),
      (e) => e.code === 'E_UNKNOWN_METHOD',
    );

    const host = await connectPeer(fx.socket, 'host');
    const hello = await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    assert.equal(hello.role, 'host');
    assert.equal(hello.nonce, fx.boot.nonce);
    assert.equal(hello.bootId, fx.boot.bootId);
    assert.equal(hello.sandboxId, fx.boot.sandboxId);
    assert.equal(hello.runnerVersion, RUNNER_VERSION);
    assert.equal(hello.protocol, PROTOCOL_VERSION);
    assert.equal(hello.pid, process.pid);
    assert.equal(hello.connections, 2);
    assert.equal(runner.boot.nonce, null, 'nonce forgotten after first hello');
    const again = await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    assert.equal(again.nonce, null, 'nonce is given once');
    const other = await connectPeer(fx.socket, 'other');
    await assert.rejects(
      other.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' }),
      (e) => e.code === 'E_BUSY',
    );
    other.close();

    const go = await host.request('runner.go', {
      env: { HTTP_PROXY: 'http://10.0.2.2:3128' },
      network: { mode: 'egress', proxy: 'http://10.0.2.2:3128' },
    });
    assert.deepEqual(go, { ready: true, checks: { ok: true, problems: [], pid: 2 } });
    assert.equal(runner.phase, 'ready');
    assert.deepEqual(runner.env, { HTTP_PROXY: 'http://10.0.2.2:3128' });
    const second = await host.request('runner.go', {});
    assert.equal(second.alreadyReady, true);
    const status = await local.request('runner.status', {});
    assert.equal(status.phase, 'ready');
    assert.equal(status.control, true);
    assert.equal(status.network.mode, 'egress');
    assert.equal(status.uptimeMs, 0);
    assert.equal(status.sessions, 0);

    const detached = new Promise((resolve) => runner.once('detached', resolve));
    host.close();
    await detached;
    assert.equal(runner.control, null);
    const host2 = await connectPeer(fx.socket, 'host2');
    const re = await host2.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    assert.equal(re.nonce, null);
    assert.equal(re.phase, 'ready');
    const stopped = new Promise((resolve) => runner.once('stopped', resolve));
    assert.deepEqual(await host2.request('runner.shutdown', {}), { stopping: true });
    await stopped;
    assert.equal(runner.phase, 'stopped');
    assert.equal(fs.existsSync(fx.socket), false);
    await runner.stop();
    local.close();
    host2.close();
  } finally {
    await runner.stop();
    fx.cleanup();
  }
});

test('go before hello is denied and a failing check set is still reported', async () => {
  const fx = bootFixture();
  const runner = new Runner({
    socketPath: fx.socket,
    boot: fx.boot,
    log: quiet,
    checks: async () => ({ ok: false, problems: ['CapEff wrong'], pid: 7 }),
  });
  try {
    fs.writeFileSync(fx.socket, 'stale');
    await runner.start();
    const host = await connectPeer(fx.socket);
    await assert.rejects(host.request('runner.go', {}), (e) => e.code === 'E_DENIED');
    await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    const go = await host.request('runner.go', {});
    assert.equal(go.ready, true);
    assert.deepEqual(go.checks.problems, ['CapEff wrong']);
    host.close();
  } finally {
    await runner.stop();
    fx.cleanup();
  }
});
