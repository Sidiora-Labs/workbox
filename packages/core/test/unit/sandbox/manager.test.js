import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../../../src/store.js';
import { loadConfig } from '../../../src/config.js';
import { SecretProvider } from '../../../src/secrets.js';
import { CgroupManager } from '../../../src/host/cgroup.js';
import { eventEmit } from '../../../src/broker/events.js';
import { askRaise, publicAsk } from '../../../src/broker/asks.js';
import {
  Manager,
  validateCreate,
  sandboxInput,
  EVENT_PRUNE_INTERVAL_MS,
} from '../../../src/sandbox/manager.js';
import { fakeClock } from '../../helpers/tmp.js';

class FakeSupervisor extends EventEmitter {
  constructor(deps) {
    super();
    this.sandbox = deps.sandbox;
    this.store = deps.store;
    this.hooks = deps.hooks;
    this.limits = {};
    this.cgroupPath = '/nonexistent';
  }
  get id() {
    return this.sandbox.id;
  }
  get networkMode() {
    return 'none';
  }
  registerPeerHandlers() {}
  async launch() {
    this.store.transition(this.id, 'PROVISIONING', 'launch');
    this.store.transition(this.id, 'BOOTSTRAPPING', 'hello');
    const row = this.store.transition(this.id, 'READY', 'ready');
    this.sandbox = row;
    return row;
  }
  async attach() {
    return 'ABSENT';
  }
  async destroy() {
    this.store.transition(this.id, 'DELETING', 'destroy');
    return this.store.transition(this.id, 'DELETED', 'gone');
  }
  drain() {
    return this.store.transition(this.id, 'DRAINING', 'drain');
  }
  request() {
    return Promise.resolve({});
  }
  observeHealth() {
    return 'ABSENT';
  }
  close() {}
}

function manager() {
  const config = loadConfig({ env: { WORKBOX_ROOT: '/tmp/workbox-manager-test' } });
  const store = Store.open(':memory:');
  const fake = { exists: () => false, stats: () => ({}) };
  return new Manager({
    config,
    store,
    cgroups: fake,
    rootfs: {},
    runtime: {},
    supervisorFactory: (d) => new FakeSupervisor(d),
  });
}

test('create/inspect/list/destroy and reconcile-to-ABSENT through the manager', async () => {
  const m = manager();
  const row = await m.create({ name: 'one', idempotencyKey: 'k1' });
  assert.equal(row.state, 'READY');
  assert.equal((await m.create({ name: 'one', idempotencyKey: 'k1' })).id, row.id);
  assert.deepEqual(
    m.store.listEvents(row.id).map((e) => [e.type, e.source, e.payload]),
    [['sandbox.created', 'host', { name: 'one', rootfs: 'minimal', labels: {} }]],
    'a replayed create logs nothing',
  );
  assert.equal(m.inspect(row.id).desired, 'READY');
  assert.equal(m.list().items.length, 1);
  await assert.rejects(() => m.create({ idempotencyKey: 'k1', rootfs: 'other' }), /idempotency/);
  const rec = await m.reconcile();
  assert.deepEqual(rec.absent, [row.id]);
  const gone = await m.destroy(row.id);
  assert.equal(gone.state, 'DELETED');
  m.close();
  m.store.close();
});

test('validateCreate rejects unknown fields, bad names and bad network modes', () => {
  assert.throws(() => validateCreate({ bogus: 1 }), /unknown create field/);
  assert.throws(() => validateCreate({ name: '../x' }), /simple identifier/);
  assert.throws(() => validateCreate({ profile: { network: { mode: 'open' } } }), /network/);
  assert.equal(sandboxInput(loadConfig({ env: { WORKBOX_ROOT: '/tmp/x' } }), {}).rootfs, 'minimal');
});

/** A Manager over real Supervisors that are never launched: no runner, no cgroup writes. */
function engineFor(store, opts = {}) {
  return new Manager({
    config: loadConfig({
      env: { WORKBOX_ROOT: '/tmp/workbox-manager-test' },
      overrides: opts.overrides,
    }),
    store,
    cgroups: new CgroupManager({ root: '/nonexistent-cgroup-root', parent: 'workbox-test' }),
    rootfs: {},
    runtime: {},
    secrets: opts.secrets,
  });
}

const sandboxRow = (store) =>
  store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });

test('logEvent stores a redacted payload and emits logged with the stored row', () => {
  const store = Store.open(':memory:');
  const secret = `wbx-${'s3cr3t'.repeat(4)}`;
  const m = engineFor(store, {
    secrets: new SecretProvider({ env: { WORKBOX_SECRET_DEPLOY_TOKEN: secret } }),
  });
  try {
    const sb = sandboxRow(store);
    const logged = [];
    m.on('logged', (row) => logged.push(row));
    const row = m.logEvent(sb.id, 'note.secret', { argv: ['curl', `-Htoken:${secret}`] });
    assert.deepEqual(row, store.getEvent(row.seq));
    assert.deepEqual(logged, [row]);
    assert.deepEqual(Object.keys(row).sort(), [
      'at',
      'causation',
      'payload',
      'sandboxId',
      'seq',
      'source',
      'type',
    ]);
    assert.equal(row.source, 'host');
    assert.deepEqual(row.payload.argv, ['curl', '-Htoken:[REDACTED:DEPLOY_TOKEN]']);
    assert.ok(!JSON.stringify(store.listEvents(sb.id)).includes(secret));

    m.once('logged', () => {
      throw new Error('listener failure');
    });
    const kept = m.logEvent(sb.id, 'note.after', undefined, { source: 'wb', causation: '7' });
    assert.deepEqual(store.getEvent(kept.seq), kept, 'a failing listener never loses the row');
    assert.deepEqual([kept.source, kept.causation, kept.payload], ['wb', '7', null]);
  } finally {
    m.close();
    store.close();
  }
});

test('the broker context logs wb events, raised asks and host answers through the Manager', () => {
  const store = Store.open(':memory:');
  const m = engineFor(store);
  try {
    const sb = sandboxRow(store);
    const logged = [];
    m.on('logged', (row) => logged.push(row));
    const ctx = m.brokerContextFor(m.supervisor(sb.id));
    const emitted = eventEmit(ctx, { type: 'build.done', payload: { ok: true }, causation: '1' });
    assert.throws(() => eventEmit(ctx, { type: 'ask.answered', payload: {} }), {
      code: 'E_INVALID_PARAMS',
    });
    const ask = askRaise(ctx, { kind: 'question', title: 'Which branch?' });
    m.answerAsk(ask.askId, { answer: 'main', by: 'tester' });
    const raised = publicAsk(store.getAsk(ask.askId));
    delete raised.answer;
    raised.status = 'open';
    raised.answeredAt = null;

    assert.deepEqual(logged, store.listEvents(sb.id), 'every append was announced, in order');
    assert.deepEqual(
      logged.map((e) => [e.type, e.source, e.payload]),
      [
        ['build.done', 'wb', { ok: true }],
        ['ask.raised', 'host', raised],
        ['ask.answered', 'host', { askId: ask.askId, by: 'tester' }],
      ],
    );
    assert.equal(logged[0].seq, emitted.seq);
    assert.equal(logged[0].causation, '1');
    assert.equal('answer' in logged[1].payload, false);
  } finally {
    m.close();
    store.close();
  }
});

test('a session start and exit are logged once, also after a Manager restart', () => {
  const store = Store.open(':memory:');
  const first = engineFor(store);
  let second = null;
  try {
    const sb = sandboxRow(store);
    const sup = first.supervisor(sb.id);
    const started = { sessionId: 's1', name: 'build', argv: ['make'], pid: 42, startedAt: 1 };
    const exit = { sessionId: 's1', code: 2, signal: null, seq: 3, at: 5 };
    sup.emit('event', 'session.started', started);
    for (let i = 0; i < 3; i++) sup.emit('event', 'session.exit', exit);
    sup.emit('event', 'session.output', { sessionId: 's1', stream: 'stdout', seq: 0, data: '' });
    assert.deepEqual(
      store.listEvents(sb.id).map((e) => [e.type, e.payload]),
      [
        ['session.started', { sessionId: 's1', name: 'build', argv: ['make'], pid: 42 }],
        ['session.exited', { sessionId: 's1', name: 'build', code: 2, signal: null }],
      ],
    );
    assert.equal(store.listSessions(sb.id)[0].exitCode, 2);
    first.close();

    second = engineFor(store);
    const again = second.supervisor(sb.id);
    again.emit('event', 'session.started', started);
    again.emit('event', 'session.exit', exit);
    assert.equal(store.listEvents(sb.id).length, 2, 'what the store has seen is not relogged');
    again.emit('event', 'session.started', { ...started, sessionId: 's2', name: null });
    again.emit('event', 'session.exit', {
      ...exit,
      sessionId: 's2',
      code: null,
      signal: 'SIGKILL',
    });
    assert.deepEqual(
      store.listEvents(sb.id, { afterSeq: 2 }).map((e) => [e.type, e.payload]),
      [
        ['session.started', { sessionId: 's2', name: null, argv: ['make'], pid: 42 }],
        ['session.exited', { sessionId: 's2', name: null, code: null, signal: 'SIGKILL' }],
      ],
    );
  } finally {
    first.close();
    second?.close();
    store.close();
  }
});

test('the Manager prunes the event log at start and on demand by events.retentionDays', () => {
  const clock = fakeClock();
  const store = Store.open(':memory:', { clock });
  let m = null;
  try {
    const sb = sandboxRow(store);
    const day = 86_400_000;
    store.appendEvent(sb.id, 'old', {});
    clock.advance(3 * day);
    store.appendEvent(sb.id, 'recent', {});
    m = engineFor(store, { overrides: { events: { retentionDays: 2 } } });
    assert.deepEqual(
      store.listEvents(sb.id).map((e) => e.type),
      ['recent'],
      'pruned at start',
    );
    assert.equal(EVENT_PRUNE_INTERVAL_MS, 3_600_000);
    assert.equal(m.pruneTimer.hasRef(), false, 'the hourly timer never holds the process open');
    clock.advance(2 * day + 1);
    store.appendEvent(sb.id, 'fresh', {});
    assert.equal(m.pruneEvents(), 1);
    assert.deepEqual(
      store.listEvents(sb.id).map((e) => e.type),
      ['fresh'],
    );
  } finally {
    m?.close();
    store.close();
  }
});
