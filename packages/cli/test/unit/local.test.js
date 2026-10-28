import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
