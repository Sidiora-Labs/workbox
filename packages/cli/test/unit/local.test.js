import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Audit, loadConfig } from '@workbox/core';
import { openLocalEngine } from '../../src/local.js';

test('local engine opens against a temp root (store+audit+manager wired)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
  const engine = await openLocalEngine({ overrides: { root: dir } });
  try {
    assert.ok(engine.manager);
    assert.equal(engine.store.listSandboxes().items.length, 0);
    assert.ok(fs.existsSync(engine.config.paths.db));
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local engine opens without secrets when the secrets file is unsafe and when reconcile fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-'));
  const secretsFile = path.join(dir, 'secrets.json');
  fs.writeFileSync(secretsFile, JSON.stringify({ NPM_TOKEN: 'npm-secret-value' }), { mode: 0o644 });
  const overrides = { root: dir, secretsFile };
  const auditDir = loadConfig({ env: {}, overrides }).paths.audit;
  const day = Date.UTC(2999, 11, 31);
  new Audit({ dir: auditDir, clock: () => day }).open().append({ actor: 'test', action: 'seed' });
  const blocked = [0, 86_400_000].map((ahead) =>
    path.join(
      auditDir,
      `audit-${new Date(Date.now() + ahead).toISOString().slice(0, 10).replace(/-/g, '')}.ndjson`,
    ),
  );
  for (const p of blocked) fs.mkdirSync(p);
  const engine = await openLocalEngine({ env: {}, overrides, reconcile: true });
  try {
    assert.equal(engine.manager.secrets, null, 'a group/world-readable secrets file is not loaded');
    await assert.rejects(engine.manager.reconcile(), (e) => e.code === 'EISDIR');
    assert.ok(blocked.every((p) => fs.statSync(p).isDirectory()));
    const seeded = fs.readFileSync(path.join(auditDir, 'audit-29991231.ndjson'), 'utf8');
    assert.equal(seeded.trim().split('\n').length, 1, 'the failed reconcile appended nothing');
    assert.equal(engine.store.listSandboxes().items.length, 0);
  } finally {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
