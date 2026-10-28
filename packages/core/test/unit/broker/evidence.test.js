import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../src/store.js';
import { recordEvidence, validateEnvelope } from '../../../src/broker/evidence.js';

const good = {
  argv: ['echo', 'hi'],
  cwd: '/workspace',
  exitCode: 0,
  signal: null,
  startedAt: 1,
  endedAt: 2,
  durationMs: 1,
  stdoutSha256: 'a'.repeat(64),
  stderrSha256: 'b'.repeat(64),
};

test('records a valid envelope and rejects malformed ones with field detail', () => {
  const store = Store.open(':memory:');
  const sb = store.createSandbox({ rootfs: 'minimal', runtime: 'current', profile: {} });
  const out = recordEvidence({ store, sandboxId: sb.id }, { envelope: good });
  assert.ok(out.id);
  assert.equal(store.listEvidence(sb.id).items[0].envelope.argv[0], 'echo');
  assert.throws(() => validateEnvelope({ ...good, argv: [] }), /argv/);
  assert.throws(() => validateEnvelope({ ...good, stdoutSha256: 'nope' }), /stdoutSha256/);
  assert.throws(() => validateEnvelope(null));
  store.close();
});
