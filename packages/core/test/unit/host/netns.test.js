import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { slirpArgv, proxyEnv, SandboxNet, NET_DEFAULTS } from '../../../src/host/netns.js';

test('slirp argv and proxy env', () => {
  assert.deepEqual(slirpArgv({ pid: 7 }), [
    'slirp4netns',
    '--configure',
    '--mtu',
    '1500',
    '--disable-host-loopback',
    '7',
    'tap0',
  ]);
  assert.throws(() => slirpArgv({ pid: 0 }));
  assert.deepEqual(proxyEnv({ mode: 'none' }), {});
  assert.equal(proxyEnv({ mode: 'egress' }).HTTP_PROXY, `http://${NET_DEFAULTS.gateway}:8080`);
});

test('SandboxNet installs rules via nsenter stdin and stops slirp', async () => {
  const calls = [];
  const spawnFn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdin = {
      data: '',
      end(d) {
        this.data = d ?? '';
        calls.push({ cmd, args, stdin: this.data });
        setImmediate(() => child.emit('close', 0));
      },
    };
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
    };
    return child;
  };
  const net = new SandboxNet({ pid: 99, mode: 'none', spawnFn });
  await net.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'nsenter');
  assert.match(calls[0].stdin, /table inet workbox/);
  net.stop();
});
