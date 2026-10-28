import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SecretProvider, parseRef, assertRef, secretRedactor } from '../../src/secrets.js';
import { MIN_LENGTH } from '../../src/redact.js';
import { tmpDir } from '../helpers/tmp.js';

test('secretRedactor registers every provider value under its reference', () => {
  const p = new SecretProvider({ env: { WORKBOX_SECRET_DEPLOY_TOKEN: 'tok-abcdef' } });
  const r = secretRedactor(p);
  assert.equal(r.apply('x tok-abcdef y'), 'x [REDACTED:DEPLOY_TOKEN] y');
  assert.deepEqual(r.applyDeep({ k: ['tok-abcdef'] }), { k: ['[REDACTED:DEPLOY_TOKEN]'] });
  const b64 = Buffer.from('tok-abcdef').toString('base64');
  assert.equal(r.apply(`auth ${b64}`), 'auth [REDACTED:DEPLOY_TOKEN]');
});

test('provider loads env refs and resolves with rename', () => {
  const p = new SecretProvider({
    env: { WORKBOX_SECRET_DEPLOY_TOKEN: 's3cret-value', WORKBOX_SECRET_UNSET: '', OTHER: 'x' },
  });
  assert.deepEqual(p.refs(), ['DEPLOY_TOKEN']);
  assert.deepEqual(p.resolveEnv(['DEPLOY_TOKEN']), { DEPLOY_TOKEN: 's3cret-value' });
  assert.deepEqual(p.resolveEnv(['DEPLOY_TOKEN=TOKEN']), { TOKEN: 's3cret-value' });
  assert.throws(() => p.resolveEnv(['NOPE']), /not configured/);
});

test('provider loads a 0600 file and refuses a world-readable one', () => {
  const t = tmpDir();
  const file = path.join(t.dir, 'secrets.json');
  fs.writeFileSync(file, JSON.stringify({ FOO: 'bar-value-1' }), { mode: 0o600 });
  const p = new SecretProvider({ file, env: {} });
  assert.equal(p.resolveEnv(['FOO']).FOO, 'bar-value-1');
  fs.chmodSync(file, 0o644);
  assert.throws(() => new SecretProvider({ file, env: {} }), /group\/world/);
  t.cleanup();
});

test('a value shorter than 8 characters is refused with a code from every source', () => {
  const seven = 'k7Qz9wX';
  assert.equal(seven.length, MIN_LENGTH - 1);
  const refused = (e) => {
    assert.equal(e.code, 'E_INVALID_PARAMS');
    assert.deepEqual(e.data, { ref: 'SHORT_TOKEN', minLength: 8 });
    assert.equal(e.message.includes(seven), false, 'the value never appears in the error');
    return true;
  };
  const p = new SecretProvider({ env: {} });
  assert.throws(() => p.set('SHORT_TOKEN', seven), refused);
  assert.equal(p.has('SHORT_TOKEN'), false);
  assert.throws(() => new SecretProvider({ env: { WORKBOX_SECRET_SHORT_TOKEN: seven } }), refused);
  const t = tmpDir();
  const file = path.join(t.dir, 'secrets.json');
  fs.writeFileSync(file, JSON.stringify({ SHORT_TOKEN: seven }), { mode: 0o600 });
  assert.throws(() => new SecretProvider({ file, env: {} }), refused);
  t.cleanup();
  p.set('LONG_TOKEN', `${seven}8`);
  assert.deepEqual(p.refs(), ['LONG_TOKEN']);
  assert.throws(() => p.set('EMPTY_TOKEN', ''), { code: 'E_INVALID_PARAMS' });
});

test('parseRef and assertRef reject junk', () => {
  assert.throws(() => parseRef('bad ref!'));
  assert.throws(() => parseRef('A=1BAD'));
  assert.throws(() => assertRef('../etc/passwd'));
  assert.deepEqual(parseRef('OK'), { ref: 'OK', envName: 'OK' });
});
