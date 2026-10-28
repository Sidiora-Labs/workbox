import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slirpArgv,
  proxyEnv,
  proxyHostAddress,
  netnsPid,
  NET_DEFAULTS,
} from '../../../src/host/netns.js';
import { hostAddresses } from '../../../src/host/proxy.js';

test('slirp argv keeps host loopback disabled and passes the ready fd', () => {
  assert.deepEqual(slirpArgv({ pid: 7 }), [
    'slirp4netns',
    '--configure',
    '--mtu',
    '1500',
    '--disable-host-loopback',
    '7',
    'tap0',
  ]);
  assert.deepEqual(slirpArgv({ pid: 7, readyFd: 3 }).slice(-3), ['--ready-fd=3', '7', 'tap0']);
  assert.throws(() => slirpArgv({ pid: 0 }));
  assert.throws(() => slirpArgv({ pid: 7, tap: 'tap0; rm' }));
});

test('proxy env points at the per-sandbox listener', () => {
  assert.deepEqual(proxyEnv({ mode: 'none' }), {});
  assert.equal(proxyEnv({ mode: 'egress' }).HTTP_PROXY, `http://${NET_DEFAULTS.gateway}:8080`);
  const env = proxyEnv({ mode: 'allowlist', proxyHost: '192.0.2.10', proxyPort: 41000 });
  assert.equal(env.HTTP_PROXY, 'http://192.0.2.10:41000');
  assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
  assert.match(env.NO_PROXY, /localhost/);
  assert.throws(() => proxyEnv({ mode: 'egress', proxyHost: 'example.com' }));
});

test('proxy host address is a non-loopback IPv4 of this host', () => {
  const addr = proxyHostAddress();
  assert.match(addr, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(!addr.startsWith('127.'));
  assert.ok(hostAddresses().has(addr));
});

test('netnsPid refuses a process tree that never leaves the host netns', () => {
  assert.throws(() => netnsPid(process.pid), /own network namespace/);
});
