import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  slirpArgv,
  proxyEnv,
  proxyLinkArgv,
  PROXY_LINK,
  netnsPid,
  assertSandboxNetns,
  spawnGuarded,
  runInNetns,
  guardedSpawnCount,
  SandboxNet,
  NET_DEFAULTS,
} from '../../../src/host/netns.js';
import { installArgv, isPrivateIpv4 } from '../../../src/host/nft.js';

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
  assert.equal(proxyEnv({ mode: 'egress' }).HTTP_PROXY, 'http://198.18.0.1:8080');
  const env = proxyEnv({ mode: 'allowlist', proxyHost: '192.0.2.10', proxyPort: 41000 });
  assert.equal(env.HTTP_PROXY, 'http://192.0.2.10:41000');
  assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
  assert.match(env.NO_PROXY, /localhost/);
  assert.throws(() => proxyEnv({ mode: 'egress', proxyHost: 'example.com' }));
});

test('the proxy binds to a host-only dummy link in a range nft drops', () => {
  assert.equal(PROXY_LINK, 'workbox0');
  assert.equal(NET_DEFAULTS.proxyHost, '198.18.0.1');
  assert.equal(isPrivateIpv4(NET_DEFAULTS.proxyHost), true);
  assert.deepEqual(proxyLinkArgv('198.18.0.1'), [
    ['ip', 'link', 'add', 'workbox0', 'type', 'dummy'],
    ['ip', 'addr', 'replace', '198.18.0.1/32', 'dev', 'workbox0'],
    ['ip', 'link', 'set', 'workbox0', 'up'],
  ]);
  assert.equal(proxyLinkArgv('198.18.0.9')[1][3], '198.18.0.9/32');
  assert.throws(() => proxyLinkArgv('198.18.0.1/24 dev eth0'));
});

test('netnsPid refuses a process tree that never leaves the host netns', () => {
  assert.throws(() => netnsPid(process.pid), /own network namespace/);
});

test('the guard refuses the host and this process network namespace before any spawn', async () => {
  const before = guardedSpawnCount();
  for (const pid of [process.pid, 1]) {
    assert.throws(() => assertSandboxNetns(pid), {
      code: 'E_DENIED',
      message: new RegExp(`pid ${pid}`),
    });
    assert.throws(() => spawnGuarded(pid, installArgv(pid, '/tmp/r.nft').argv, {}), {
      code: 'E_DENIED',
    });
    assert.throws(() => spawnGuarded(pid, slirpArgv({ pid }), {}), { code: 'E_DENIED' });
    await assert.rejects(runInNetns(pid, ['nft', 'list', 'ruleset']), { code: 'E_DENIED' });
  }
  assert.throws(() => assertSandboxNetns(2 ** 30), { code: 'E_DENIED' });
  assert.throws(() => spawnGuarded(42, ['nsenter', '-t', '7', '-n', 'nft']), {
    code: 'E_INVALID_PARAMS',
  });
  assert.equal(guardedSpawnCount(), before);
});

test('SandboxNet re-checks the namespace immediately before nft and slirp spawns', async () => {
  const before = guardedSpawnCount();
  for (const pid of [process.pid, 1]) {
    const sbNet = new SandboxNet({ pid, sandboxId: 'sb_guard', policy: { mode: 'egress' } });
    sbNet.nsPid = pid;
    await assert.rejects(sbNet.installRules({ mode: 'none' }), { code: 'E_DENIED' });
    await assert.rejects(sbNet._startSlirp(), { code: 'E_DENIED' });
    assert.equal(sbNet.child, null);
    sbNet.stop();
  }
  const own = new SandboxNet({ pid: process.pid, sandboxId: 'sb_guard', policy: { mode: 'none' } });
  await assert.rejects(own.start(), /own network namespace/);
  assert.throws(() => netnsPid(1), { code: 'E_DENIED' });
  assert.equal(guardedSpawnCount(), before);
});
