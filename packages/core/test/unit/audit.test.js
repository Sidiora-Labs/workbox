import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { threadId } from 'node:worker_threads';
import {
  Audit,
  canonicalJSON,
  hashEntry,
  dailyFile,
  auditFiles,
  GENESIS,
} from '../../src/audit.js';
import { Redactor } from '../../src/redact.js';
import { tmpDir, fakeClock } from '../helpers/tmp.js';

test('canonicalJSON sorts keys recursively and hashEntry is deterministic', () => {
  assert.equal(
    canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }),
    '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}',
  );
  assert.equal(canonicalJSON('s'), '"s"');
  assert.equal(hashEntry(GENESIS, { a: 1, b: 2 }), hashEntry(GENESIS, { b: 2, a: 1 }));
  assert.notEqual(hashEntry(GENESIS, { a: 1 }), hashEntry('1'.repeat(64), { a: 1 }));
  assert.equal(dailyFile(Date.UTC(2026, 9, 25)), 'audit-20261025.ndjson');
  assert.deepEqual(auditFiles('/nonexistent/dir'), []);
});

test('append builds a verifiable chain, redacts data and resumes after reopen', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const clock = fakeClock(Date.UTC(2026, 9, 25, 12));
    const r = new Redactor();
    r.add('hunter2hunter2', 'pw');
    const audit = new Audit({ dir, clock, redactor: r }).open();
    const a = audit.append({
      actor: 'cli',
      action: 'sandbox.create',
      sandboxId: 'S1',
      data: { pw: 'hunter2hunter2' },
    });
    assert.equal(a.seq, 1);
    assert.equal(path.basename(a.file), 'audit-20261025.ndjson');
    const b = audit.append({ actor: 'cli', action: 'sandbox.destroy', sandboxId: 'S1' });
    assert.equal(b.seq, 2);
    const lines = fs.readFileSync(a.file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(lines[0].prev, GENESIS);
    assert.equal(lines[1].prev, lines[0].hash);
    assert.deepEqual(lines[0].data, { pw: '[REDACTED:pw]' });
    assert.deepEqual(lines[1].data, {});
    assert.equal(fs.statSync(a.file).mode & 0o777, 0o600);
    assert.deepEqual(Audit.verify(dir), { ok: true, entries: 2, brokenAt: null });
    const resumed = new Audit({ dir, clock }).open();
    assert.equal(resumed.seq, 2);
    assert.equal(resumed.prev, lines[1].hash);
    clock.set(Date.UTC(2026, 9, 26, 1));
    const c = resumed.append({ actor: 'server', action: 'ask.answer' });
    assert.equal(c.seq, 3);
    assert.equal(path.basename(c.file), 'audit-20261026.ndjson');
    assert.deepEqual(auditFiles(dir), ['audit-20261025.ndjson', 'audit-20261026.ndjson']);
    assert.deepEqual(Audit.verify(dir), { ok: true, entries: 3, brokenAt: null });
    const lazy = new Audit({ dir, clock });
    lazy.append({ actor: 'x', action: 'y' });
    assert.equal(lazy.seq, 4);
  } finally {
    cleanup();
  }
});

test('verify detects tampering, gaps and unparsable lines', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const clock = fakeClock(Date.UTC(2026, 0, 1));
    const audit = new Audit({ dir, clock, fileFor: () => 'audit-20260101.ndjson' }).open();
    for (let i = 0; i < 3; i++) audit.append({ actor: 'a', action: `act${i}`, data: { i } });
    const file = path.join(dir, 'audit-20260101.ndjson');
    const original = fs.readFileSync(file, 'utf8');
    const lines = original.trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.data.i = 99;
    fs.writeFileSync(file, `${[lines[0], JSON.stringify(tampered), lines[2]].join('\n')}\n`);
    let v = Audit.verify(dir);
    assert.equal(v.ok, false);
    assert.deepEqual(v.brokenAt, {
      file: 'audit-20260101.ndjson',
      line: 2,
      reason: 'hash mismatch',
    });
    assert.equal(v.entries, 1);
    fs.writeFileSync(file, `${[lines[0], lines[2]].join('\n')}\n`);
    v = Audit.verify(dir);
    assert.equal(v.brokenAt.reason, 'prev hash mismatch');
    const third = JSON.parse(lines[2]);
    const second = JSON.parse(lines[1]);
    third.prev = JSON.parse(lines[0]).hash;
    fs.writeFileSync(file, `${[lines[0], JSON.stringify(third)].join('\n')}\n`);
    v = Audit.verify(dir);
    assert.match(v.brokenAt.reason, /sequence gap/);
    fs.writeFileSync(file, `${lines[0]}\n{nope\n`);
    v = Audit.verify(dir);
    assert.equal(v.brokenAt.reason, 'unparsable line');
    fs.writeFileSync(file, original);
    assert.ok(Audit.verify(dir).ok);
    assert.equal(second.seq, 2);
  } finally {
    cleanup();
  }
});

test('a final line torn mid-write is truncated on open, the repair is audited and the chain verifies', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const clock = fakeClock(Date.UTC(2026, 9, 27, 8));
    const audit = new Audit({ dir, clock }).open();
    for (let i = 0; i < 3; i++) audit.append({ actor: 'a', action: `act${i}`, data: { i } });
    const file = path.join(dir, 'audit-20261027.ndjson');
    const whole = fs.readFileSync(file, 'utf8');
    const keep = whole.lastIndexOf('\n', whole.length - 2) + 1;
    fs.truncateSync(file, keep + 20);
    assert.deepEqual(Audit.verify(dir).brokenAt, {
      file: 'audit-20261027.ndjson',
      line: 3,
      reason: 'unparsable line',
    });
    const reopened = new Audit({ dir, clock }).open();
    assert.equal(reopened.seq, 3);
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => l.action),
      ['act0', 'act1', 'audit.repair'],
    );
    assert.equal(lines[2].actor, 'audit');
    assert.deepEqual(lines[2].data, {
      file: 'audit-20261027.ndjson',
      offset: keep,
      bytes: 20,
      sha256: createHash('sha256')
        .update(whole.slice(keep, keep + 20))
        .digest('hex'),
    });
    assert.deepEqual(Audit.verify(dir), { ok: true, entries: 3, brokenAt: null });

    clock.set(Date.UTC(2026, 9, 28, 8));
    const next = path.join(dir, 'audit-20261028.ndjson');
    fs.writeFileSync(next, '{"seq":4,"ts":');
    const resumed = new Audit({ dir, clock }).open();
    assert.equal(
      resumed.seq,
      4,
      'an all-torn file empties and the chain resumes from the day before',
    );
    assert.equal(JSON.parse(fs.readFileSync(next, 'utf8')).data.bytes, 14);
    assert.deepEqual(Audit.verify(dir), { ok: true, entries: 4, brokenAt: null });

    fs.appendFileSync(next, '{"not":"an entry"}\n');
    assert.throws(
      () => new Audit({ dir, clock }).append({ actor: 'a', action: 'x' }),
      (e) => e.code === 'E_INTERNAL' && e.data.file === 'audit-20261028.ndjson',
    );
    assert.match(fs.readFileSync(next, 'utf8'), /"not":"an entry"/, 'a complete line is kept');
    assert.ok(!fs.existsSync(path.join(dir, '.audit.lock')), 'the lock is released on failure');
  } finally {
    cleanup();
  }
});

test('verify streams files larger than its buffer, lines longer than it and multibyte text', () => {
  const { dir, cleanup } = tmpDir();
  try {
    const clock = fakeClock(Date.UTC(2026, 9, 27));
    const audit = new Audit({ dir, clock, fsync: false }).open();
    for (let i = 0; i < 40; i++)
      audit.append({ actor: 'a', action: 'bulk', data: { i, pad: 'x'.repeat(4000) } });
    audit.append({ actor: 'a', action: 'huge', data: { pad: 'é'.repeat(70_000) } });
    assert.equal(new Audit({ dir, clock }).open().seq, 41);
    audit.append({ actor: 'a', action: 'after' });
    const file = path.join(dir, 'audit-20261027.ndjson');
    assert.ok(fs.statSync(file).size > 2 * 64 * 1024);
    assert.deepEqual(Audit.verify(dir), { ok: true, entries: 42, brokenAt: null });
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const huge = JSON.parse(lines[40]);
    huge.data.pad = `${huge.data.pad.slice(0, -1)}e`;
    lines[40] = JSON.stringify(huge);
    fs.writeFileSync(file, lines.join('\n'));
    assert.deepEqual(Audit.verify(dir), {
      ok: false,
      entries: 40,
      brokenAt: { file: 'audit-20261027.ndjson', line: 41, reason: 'hash mismatch' },
    });
  } finally {
    cleanup();
  }
});

test('the audit lock waits out a live holder with E_BUSY and breaks one a dead writer left', () => {
  const { dir, cleanup } = tmpDir();
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore',
  });
  try {
    const clock = fakeClock(Date.UTC(2026, 9, 27));
    const audit = new Audit({ dir, clock, lockTimeoutMs: 100 }).open();
    const lock = path.join(dir, '.audit.lock');
    const live = `${holder.pid}:0:feedface`;
    fs.writeFileSync(lock, live);
    const started = Date.now();
    assert.throws(
      () => audit.append({ actor: 'a', action: 'blocked' }),
      (e) => e.code === 'E_BUSY' && e.data.lock === lock,
    );
    assert.ok(Date.now() - started >= 100);
    assert.equal(fs.readFileSync(lock, 'utf8'), live, 'a live holder keeps its lock');
    assert.equal(Audit.verify(dir).entries, 0);

    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    fs.writeFileSync(lock, `${dead}:0:deadbeef`);
    assert.equal(audit.append({ actor: 'a', action: 'after-dead' }).seq, 1);
    fs.writeFileSync(lock, `${process.pid}:${threadId}:0ld`);
    assert.equal(audit.append({ actor: 'a', action: 'after-pid-reuse' }).seq, 2);
    fs.writeFileSync(lock, live);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    assert.equal(audit.append({ actor: 'a', action: 'after-stale' }).seq, 3);
    assert.ok(!fs.existsSync(lock));
    assert.deepEqual(Audit.verify(dir), { ok: true, entries: 3, brokenAt: null });
  } finally {
    holder.kill('SIGKILL');
    cleanup();
  }
});
