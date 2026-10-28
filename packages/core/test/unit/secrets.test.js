import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SecretProvider, parseRef, assertRef } from '../../src/secrets.js';
import { tmpDir } from '../helpers/tmp.js';

test('provider loads env refs and resolves with rename', () => {
  const p = new SecretProvider({ env: { WORKBOX_SECRET_DEPLOY_TOKEN: 's3cret', OTHER: 'x' } });
  assert.deepEqual(p.refs(), ['DEPLOY_TOKEN']);
  assert.deepEqual(p.resolveEnv(['DEPLOY_TOKEN']), { DEPLOY_TOKEN: 's3cret' });
  assert.deepEqual(p.resolveEnv(['DEPLOY_TOKEN=TOKEN']), { TOKEN: 's3cret' });
  assert.throws(() => p.resolveEnv(['NOPE']), /not configured/);
});

test('provider loads a 0600 file and refuses a world-readable one', () => {
  const t = tmpDir();
  const file = path.join(t.dir, 'secrets.json');
  fs.writeFileSync(file, JSON.stringify({ FOO: 'bar' }), { mode: 0o600 });
  const p = new SecretProvider({ file, env: {} });
  assert.equal(p.resolveEnv(['FOO']).FOO, 'bar');
  fs.chmodSync(file, 0o644);
  assert.throws(() => new SecretProvider({ file, env: {} }), /group\/world/);
  t.cleanup();
});

test('parseRef and assertRef reject junk', () => {
  assert.throws(() => parseRef('bad ref!'));
  assert.throws(() => parseRef('A=1BAD'));
  assert.throws(() => assertRef('../etc/passwd'));
  assert.deepEqual(parseRef('OK'), { ref: 'OK', envName: 'OK' });
});
