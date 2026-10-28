import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

const AUDIT_URL = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/audit.js'),
).href;

const WRITER = `
import fs from 'node:fs';
import { Audit } from ${JSON.stringify(AUDIT_URL)};
const [dir, actor, count, go] = process.argv.slice(1);
const nap = new Int32Array(new SharedArrayBuffer(4));
const audit = new Audit({ dir, fileFor: () => 'audit-20261028.ndjson' }).open();
process.stdout.write('ready\\n');
while (!fs.existsSync(go)) Atomics.wait(nap, 0, 0, 1);
for (let i = 0; i < Number(count); i++) {
  audit.append({ actor, action: 'race.append', data: { i } });
  Atomics.wait(nap, 0, 0, i % 2);
}
`;

function writer(args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', WRITER, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    err += d;
  });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve({ code, err })));
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      if (out.includes('ready')) resolve();
    });
    exited.then(({ code }) => reject(new Error(`writer exited ${code} before ready: ${err}`)));
  });
  return { ready, exited };
}

/**
 * Two real processes, released together, append to one audit directory. The lockfile and the
 * tail re-read under it must leave a single chain holding every entry of both writers.
 */
test('two writer processes appending at once keep one valid audit chain', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const auditDir = path.join(dir, 'audit');
    const go = path.join(dir, 'go');
    const count = 150;
    const writers = ['alpha', 'beta'].map((actor) => writer([auditDir, actor, String(count), go]));
    await Promise.all(writers.map((w) => w.ready));
    fs.writeFileSync(go, '');
    const results = await Promise.all(writers.map((w) => w.exited));
    assert.deepEqual(
      results.map((r) => r.code),
      [0, 0],
      results.map((r) => r.err).join('\n'),
    );
    assert.deepEqual(Audit.verify(auditDir), { ok: true, entries: 2 * count, brokenAt: null });
    const entries = fs
      .readFileSync(path.join(auditDir, 'audit-20261028.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    for (const actor of ['alpha', 'beta'])
      assert.deepEqual(
        entries.filter((e) => e.actor === actor).map((e) => e.data.i),
        [...Array(count).keys()],
      );
    const switches = entries.filter((e, i) => i > 0 && e.actor !== entries[i - 1].actor).length;
    assert.ok(switches > 1, `the writers interleaved (${switches} switches)`);
    assert.ok(!fs.existsSync(path.join(auditDir, '.audit.lock')));
  } finally {
    cleanup();
  }
});
