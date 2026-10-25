import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@workbox/protocol';
import { parseArgs, readBootFile, main, DEFAULT_BOOT_FILE } from '../../src/main.js';
import { createLog } from '../../src/log.js';
import { bootFixture, connectPeer } from '../helpers/boot.js';

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), {
    boot: DEFAULT_BOOT_FILE,
    socket: null,
    keepBootFile: false,
    logLevel: 'info',
  });
  assert.deepEqual(
    parseArgs(['--boot', '/b', '--socket', '/s', '--keep-boot-file', '--log-level', 'debug']),
    { boot: '/b', socket: '/s', keepBootFile: true, logLevel: 'debug' },
  );
  assert.throws(() => parseArgs(['--boot']), /needs a value/);
  assert.throws(() => parseArgs(['--what']), /unknown argument/);
});

test('readBootFile validates required keys', () => {
  const fx = bootFixture();
  try {
    assert.equal(readBootFile(fx.bootFile).bootId, fx.boot.bootId);
    const bad = path.join(fx.dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ bootId: 'x' }));
    assert.throws(() => readBootFile(bad), /lacks nonce/);
  } finally {
    fx.cleanup();
  }
});

test('main starts a runner from the boot file, deletes the file and honours SIGTERM', async () => {
  const fx = bootFixture();
  const exits = [];
  const log = createLog({ level: 'silent', stream: { write: () => undefined } });
  const runner = await main(['--boot', fx.bootFile], { exit: (c) => exits.push(c), log });
  try {
    assert.equal(
      fs.existsSync(fx.bootFile),
      false,
      'boot file removed so the nonce cannot be read later',
    );
    const peer = await connectPeer(fx.socket);
    const hello = await peer.request('runner.hello', { protocol: PROTOCOL_VERSION, role: 'host' });
    assert.equal(hello.nonce, fx.boot.nonce);
    peer.close();
    const stopped = new Promise((resolve) => runner.once('stopped', resolve));
    process.emit('SIGTERM', 'SIGTERM');
    await stopped;
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(exits, [0]);
    assert.equal(process.listeners('SIGTERM').length, 0);
  } finally {
    await runner.stop();
    fx.cleanup();
  }
});

test('main keeps the boot file when asked and uses an explicit socket', async () => {
  const fx = bootFixture();
  const socket = path.join(fx.dir, 'other.sock');
  const log = createLog({ level: 'silent', stream: { write: () => undefined } });
  const runner = await main(['--boot', fx.bootFile, '--socket', socket, '--keep-boot-file'], {
    exit: () => undefined,
    log,
  });
  try {
    assert.ok(fs.existsSync(fx.bootFile));
    assert.ok(fs.existsSync(socket));
  } finally {
    await runner.stop();
    fx.cleanup();
  }
});
