import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
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
      (e) => e.code === 'E_STATE' && e.data.phase === 'boot',
      'no session may start before the host lifts the boot barrier',
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

const okChecks = async () => ({ ok: true, problems: [], pid: 1 });
const b64 = (s) => Buffer.from(s).toString('base64');

function capturingLog() {
  const lines = [];
  const log = createLog({ level: 'warn', stream: { write: (l) => lines.push(JSON.parse(l)) } });
  return { log, lines };
}

/** Record every session.exit the host receives; `exitOf(id)` resolves with that session's. */
function exitRecorder(host) {
  const seen = new Map();
  const waiters = new Map();
  host.on('event', (method, params) => {
    if (method !== 'session.exit') return;
    seen.set(params.sessionId, params);
    waiters.get(params.sessionId)?.(params);
  });
  return (id) =>
    seen.has(id) ? Promise.resolve(seen.get(id)) : new Promise((r) => waiters.set(id, r));
}

test('host token gates the control channel and the peer limit refuses extra connections', async () => {
  const fx = bootFixture({
    hostTokenHash: createHash('sha256').update('host-secret').digest('hex'),
  });
  const runner = new Runner({
    socketPath: fx.socket,
    boot: fx.boot,
    log: quiet,
    checks: okChecks,
    maxPeers: 1,
  });
  try {
    await runner.start();
    const host = await connectPeer(fx.socket, 'host');
    const hello = { protocol: PROTOCOL_VERSION, role: 'host' };
    await assert.rejects(
      host.request('runner.hello', hello),
      (e) => e.code === 'E_DENIED' && /invalid host token/.test(e.message),
    );
    await assert.rejects(
      host.request('runner.hello', { ...hello, hostToken: 'wrong-secret' }),
      (e) => e.code === 'E_DENIED',
    );
    assert.equal(runner.control, null, 'a rejected token never attaches the control channel');
    const ok = await host.request('runner.hello', { ...hello, hostToken: 'host-secret' });
    assert.equal(ok.role, 'host');
    assert.equal(ok.nonce, fx.boot.nonce);
    assert.notEqual(runner.control, null);

    const extra = net.connect(fx.socket);
    const [, [hadError]] = await Promise.all([once(extra, 'connect'), once(extra, 'close')]);
    assert.equal(hadError, false);
    assert.equal(runner.peers.size, 1, 'the connection over maxPeers was destroyed');
    assert.equal((await host.request('runner.status', {})).connections, 1);
    host.close();
  } finally {
    await runner.stop();
    fx.cleanup();
  }
});

test('ready runner serves session control, fs and broker relay, and resolves secret refs', async () => {
  const fx = bootFixture();
  const { log, lines } = capturingLog();
  const runner = new Runner({
    socketPath: fx.socket,
    boot: fx.boot,
    log,
    checks: okChecks,
    fsRoot: fx.dir,
  });
  const peers = [];
  try {
    await runner.start();
    const host = await connectPeer(fx.socket, 'host');
    peers.push(host);
    await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    const exitOf = exitRecorder(host);
    const resolvedRefs = [];
    host.handle('broker.secret.resolve', (p) => {
      resolvedRefs.push(p.refs);
      return { env: { WB_TOKEN: 'resolved-secret-value' } };
    });
    host.handle('broker.status', () => ({ servedBy: 'host-handler' }));
    const local = await connectPeer(fx.socket, 'local');
    peers.push(local);
    await assert.rejects(local.request('broker.status', {}), (e) => e.code === 'E_STATE');
    await host.request('runner.go', {});

    assert.deepEqual(await local.request('broker.status', {}), { servedBy: 'host-handler' });
    await assert.rejects(
      local.request('broker.secret.resolve', { refs: ['WB_TOKEN'] }),
      (e) => e.code === 'E_DENIED' && /runner-internal/.test(e.message),
    );
    await assert.rejects(
      host.request('broker.status', {}),
      (e) => e.code === 'E_DENIED' && /served by the host/.test(e.message),
    );

    const check = await local.request('session.start', {
      argv: ['sh', '-c', 'test "$WB_TOKEN" = resolved-secret-value'],
      secretRefs: ['WB_TOKEN'],
    });
    const checked = await exitOf(check.sessionId);
    assert.deepEqual(resolvedRefs, [['WB_TOKEN']]);
    assert.equal(checked.code, 0, 'the resolved secret reached the child environment');

    const sleeper = await local.request('session.start', { argv: ['sleep', '30'] });
    await local.request('session.attach', { sessionId: sleeper.sessionId });
    assert.deepEqual(await local.request('session.detach', { sessionId: sleeper.sessionId }), {
      sessionId: sleeper.sessionId,
      detached: true,
    });
    await local.request('session.signal', { sessionId: sleeper.sessionId, signal: 'SIGTERM' });
    assert.equal((await exitOf(sleeper.sessionId)).signal, 'SIGTERM');
    const stoppable = await local.request('session.start', { argv: ['sleep', '30'] });
    const stopped = await local.request('session.stop', {
      sessionId: stoppable.sessionId,
      graceMs: 5000,
    });
    assert.equal(stopped.escalated, false);
    assert.equal(stopped.exited.signal, 'SIGTERM');

    const box = `${fx.dir}/box`;
    const file = `${box}/note.txt`;
    assert.deepEqual(await local.request('fs.mkdir', { path: box }), { path: box, created: true });
    assert.equal((await local.request('fs.write', { path: file, data: b64('hello') })).bytes, 5);
    const read = await local.request('fs.read', { path: file });
    assert.equal(Buffer.from(read.data, 'base64').toString(), 'hello');
    assert.deepEqual(await local.request('fs.list', { path: box }), {
      path: box,
      entries: [{ name: 'note.txt', type: 'file' }],
    });
    assert.equal((await local.request('fs.stat', { path: file })).size, 5);
    await assert.rejects(
      local.request('fs.read', { path: os.tmpdir() }),
      (e) => e.code === 'E_DENIED',
    );
    await assert.rejects(
      local.request('fs.mkdir', { path: `${file}/below-a-file` }),
      (e) => e.code === 'E_INTERNAL',
    );
    assert.ok(
      lines.some((l) => l.msg === 'handler failed' && l.method === 'fs.mkdir'),
      'an unexpected handler failure is logged with its method',
    );
    assert.deepEqual(await local.request('fs.remove', { path: box, recursive: true }), {
      path: box,
      removed: true,
    });
    assert.equal(fs.existsSync(box), false);

    const raw = net.connect(fx.socket);
    await once(raw, 'connect');
    raw.write('this is not an envelope\n');
    await once(raw, 'close');
    assert.ok(
      lines.some((l) => l.msg === 'protocol error'),
      'a malformed peer is logged',
    );

    const detached = once(runner, 'detached');
    host.close();
    await detached;
    await assert.rejects(
      local.request('broker.status', {}),
      (e) => e.code === 'E_UNAVAILABLE' && /broker relay/.test(e.message),
    );
    await assert.rejects(
      local.request('session.start', { argv: ['true'], secretRefs: ['WB_TOKEN'] }),
      (e) => e.code === 'E_UNAVAILABLE' && /secret resolution/.test(e.message),
    );
  } finally {
    for (const peer of peers) peer.close();
    await runner.stop();
    fx.cleanup();
  }
});
