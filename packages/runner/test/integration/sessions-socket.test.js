import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from '@workbox/protocol';
import { Runner } from '../../src/runner.js';
import { createLog } from '../../src/log.js';
import { bootFixture, connectPeer } from '../helpers/boot.js';

const quiet = createLog({ level: 'silent', stream: { write: () => undefined } });
const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * Sessions driven over the real socket: the host control channel gets lifecycle events, a local
 * client attaches and types, the host disconnects and reconnects and replays from a sequence.
 */
test('sessions over the socket survive a host disconnect and replay on reattach', async () => {
  const fx = bootFixture();
  const runner = new Runner({
    socketPath: fx.socket,
    boot: fx.boot,
    log: quiet,
    checks: async () => ({ ok: true, problems: [], pid: 2 }),
    stopGraceMs: 200,
  });
  try {
    await runner.start();
    const host = await connectPeer(fx.socket, 'host');
    const hostEvents = [];
    host.on('event', (m, p) => hostEvents.push([m, p]));
    await assert.rejects(
      host.request('session.start', { argv: ['sh'] }),
      (e) => e.code === 'E_STATE',
      'no sessions before go',
    );
    await host.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    await host.request('runner.go', { env: { FROM_HOST: 'yes' } });

    const started = await host.request('session.start', {
      argv: ['sh', '-c', 'echo $FROM_HOST; read line; echo got:$line; sleep 0.1; echo done'],
      name: 'shell',
    });
    await until(() =>
      hostEvents.some(([m, p]) => m === 'session.started' && p.sessionId === started.sessionId),
    );
    const list = await host.request('session.list', {});
    assert.equal(list.sessions.length, 1);
    assert.equal(list.sessions[0].name, 'shell');

    const local = await connectPeer(fx.socket, 'local');
    const localEvents = [];
    local.on('event', (m, p) => localEvents.push([m, p]));
    await local.request('runner.hello', { protocol: PROTOCOL_VERSION });
    const att = await local.request('session.attach', { sessionId: started.sessionId, fromSeq: 0 });
    assert.equal(att.gap, null);
    await until(() => localEvents.length >= 1);
    assert.equal(Buffer.from(localEvents[0][1].data, 'base64').toString(), 'yes\n');
    await local.request('session.input', {
      sessionId: started.sessionId,
      data: Buffer.from('hi\n').toString('base64'),
    });
    await until(() => localEvents.some(([m]) => m === 'session.exit'));
    const text = localEvents
      .filter(([m]) => m === 'session.output')
      .map(([, p]) => Buffer.from(p.data, 'base64').toString())
      .join('');
    assert.equal(text, 'yes\ngot:hi\ndone\n');
    assert.ok(
      hostEvents.some(
        ([m, p]) => m === 'session.exit' && p.sessionId === started.sessionId && p.code === 0,
      ),
      'control channel saw the exit without attaching',
    );
    assert.equal(
      hostEvents.filter(([m]) => m === 'session.output').length,
      0,
      'control channel did not receive output it never attached to',
    );

    const longRunning = await host.request('session.start', {
      argv: ['sh', '-c', 'i=0; while [ $i -lt 50 ]; do echo line$i; i=$((i+1)); sleep 0.02; done'],
    });
    host.close();
    await until(() => runner.control === null);
    await new Promise((r) => setTimeout(r, 300));
    const host2 = await connectPeer(fx.socket, 'host2');
    const events2 = [];
    host2.on('event', (m, p) => events2.push([m, p]));
    await host2.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    const list2 = await host2.request('session.list', {});
    assert.equal(list2.sessions.length, 2, 'sessions survived the host disconnect');
    const live = list2.sessions.find((s) => s.sessionId === longRunning.sessionId);
    assert.ok(live.seq >= 5, `output accumulated while nobody listened: seq ${live.seq}`);
    const re = await host2.request('session.attach', {
      sessionId: longRunning.sessionId,
      fromSeq: 3,
    });
    assert.equal(re.replayedFrom, 3);
    assert.equal(re.gap, null);
    await until(() => events2.some(([m]) => m === 'session.exit'));
    const lines = events2
      .filter(([m]) => m === 'session.output')
      .map(([, p]) => Buffer.from(p.data, 'base64').toString())
      .join('')
      .trim()
      .split('\n');
    assert.equal(lines[0], 'line3');
    assert.equal(lines[lines.length - 1], 'line49');
    await assert.rejects(
      host2.request('session.attach', { sessionId: 'nope' }),
      (e) => e.code === 'E_NOT_FOUND',
    );
    await assert.rejects(
      host2.request('session.resize', { sessionId: longRunning.sessionId, rows: 1, cols: 1 }),
      (e) => e.code === 'E_UNSUPPORTED',
    );
    assert.deepEqual(await host2.request('session.remove', { sessionId: longRunning.sessionId }), {
      sessionId: longRunning.sessionId,
      removed: true,
    });
    const status = await host2.request('runner.status', {});
    assert.equal(status.sessions, 0);
    const sleeper = await host2.request('session.start', { argv: ['sleep', '30'] });
    const stopped = await host2.request('runner.shutdown', { graceMs: 100 });
    assert.equal(stopped.stopping, true);
    await until(() => runner.phase === 'stopped');
    assert.ok(runner.sessions.get(sleeper.sessionId).exited, 'shutdown stops live sessions');
    local.close();
    host2.close();
  } finally {
    await runner.stop();
    fx.cleanup();
  }
});
