import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Store } from '../../../src/store.js';
import { loadConfig } from '../../../src/config.js';
import { Manager, validateCreate, sandboxInput } from '../../../src/sandbox/manager.js';

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
