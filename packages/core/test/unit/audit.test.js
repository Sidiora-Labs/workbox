import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
