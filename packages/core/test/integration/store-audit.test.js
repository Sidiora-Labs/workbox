import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Store } from '../../src/store.js';
import { Audit } from '../../src/audit.js';
import { Redactor } from '../../src/redact.js';
import { createLogger } from '../../src/log.js';
import { loadConfig } from '../../src/config.js';
import { tmpDir, fakeClock } from '../helpers/tmp.js';

/**
 * The host's durable trio working together: a sandbox walks its lifecycle while every step
 * writes an event, an audit line and a log line through one redactor; a second Store on the same
 * file reads the committed state; the audit chain verifies across a day boundary.
 */
test('lifecycle writes store, audit and log consistently and survives reopen', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const cfg = loadConfig({ env: { WORKBOX_ROOT: dir } });
    const clock = fakeClock(Date.UTC(2026, 9, 25, 23, 59, 59));
    const redactor = new Redactor();
    redactor.add('ghp_secretsecret', 'github');
    const lines = [];
    const log = createLogger({
      component: 'core',
      level: 'debug',
      stream: { write: (l) => lines.push(l) },
      redactor,
      clock,
    });
    const store = Store.open(cfg.paths.db, { clock });
    const audit = new Audit({ dir: cfg.paths.audit, clock, redactor }).open();
    const reader = Store.open(cfg.paths.db, { clock });

    const record = (sandboxId, action, data) => {
      store.appendEvent(sandboxId, action, data);
      audit.append({ actor: 'test', action, sandboxId, data });
      log.info(action, { sandboxId, ...data });
    };

    const s = store.createSandbox({
      rootfs: cfg.rootfs,
      runtime: cfg.runtime,
      profile: { limits: cfg.limits, network: cfg.network },
      idempotencyKey: 'flow-1',
    });
    record(s.id, 'sandbox.created', { token: 'ghp_secretsecret' });
    for (const [to, reason] of [
      ['PROVISIONING', 'launch'],
      ['BOOTSTRAPPING', 'hello'],
      ['READY', 'ready'],
    ]) {
      clock.advance(400);
      store.transition(s.id, to, reason);
      record(s.id, `sandbox.${to.toLowerCase()}`, { reason });
    }
    store.createBoot({ bootId: 'boot-1', sandboxId: s.id, nonceHash: 'h', pid: 1234 });
    assert.equal(store.consumeNonce('boot-1', 'h'), 'consumed');
    assert.equal(store.consumeNonce('boot-1', 'h'), 'already');

    const seen = reader.getSandbox(s.id);
    assert.equal(seen.state, 'READY');
    assert.equal(seen.pid, 1234);
    assert.equal(reader.listEvents(s.id).length, 4);
    assert.equal(reader.listTransitions(s.id).length, 4);

    const files = audit.constructor.verify(cfg.paths.audit);
    assert.deepEqual(files, { ok: true, entries: 4, brokenAt: null });
    const joined = lines.join('');
    assert.ok(!joined.includes('ghp_secretsecret'));
    assert.ok(joined.includes('[REDACTED:github]'));
    assert.equal(lines.length, 4);

    store.close();
    reader.close();
    const reopened = Store.open(cfg.paths.db, { clock });
    const again = new Audit({ dir: cfg.paths.audit, clock }).open();
    assert.equal(again.seq, 4);
    assert.equal(reopened.getSandbox(s.id).version, 4);
    assert.equal(
      reopened.createSandbox({ rootfs: 'x', runtime: 'y', profile: {}, idempotencyKey: 'flow-1' })
        .id,
      s.id,
    );
    reopened.transition(s.id, 'DRAINING', 'drain');
    reopened.transition(s.id, 'DELETING', 'delete');
    reopened.transition(s.id, 'DELETED', 'cgroup removed');
    again.append({ actor: 'test', action: 'sandbox.deleted', sandboxId: s.id });
    const v = Audit.verify(cfg.paths.audit);
    assert.equal(v.ok, true);
    assert.equal(v.entries, 5);
    assert.ok(path.basename(path.join(cfg.paths.audit, 'x')));
    reopened.close();
  } finally {
    cleanup();
  }
});
