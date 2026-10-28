import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Manager } from '../../src/sandbox/manager.js';
import { Audit, auditFiles } from '../../src/audit.js';
import { NET_DEFAULTS, PROXY_LINK, runInNetns, hasTap } from '../../src/host/netns.js';
import { NET_STATE_FILE } from '../../src/host/launch.js';
import { hostAddresses } from '../../src/host/proxy.js';
import { isPrivateIpv4 } from '../../src/host/nft.js';
import { testEngine } from '../helpers/engine.js';

// Host-side test traffic must never go through an ambient HTTP(S) proxy.
for (const k of [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])
  delete process.env[k];

const MiB = 1024 * 1024;
const NODE = '/opt/workbox/node/bin/node';
// A "public" peer: a veth pair into a network namespace of its own, addressed from TEST-NET-2,
// which no blocked range covers. The host side of the pair is a host address like any other.
const SLOT = 4 * (process.pid % 63);
const PEER_HOST = `198.51.100.${SLOT + 1}`;
const PEER = `198.51.100.${SLOT + 2}`;
const NS = `wbt${process.pid}`;

const PEER_SERVER = `
const http = require('node:http');
let n = 0;
for (const port of [80, 8081, 8082])
  http.createServer((req, res) => res.end('peer:' + port + ':' + req.url))
    .listen(port, process.argv[1], () => { if (++n === 3) process.stdout.write('ready\\n'); });
`;

// [proto, host, port] -> 'connected' | 'sent' | errno | 'timeout'. An nft drop on output fails a
// UDP send with EPERM at once; a dropped TCP SYN is only retried, so TCP drops time out.
const CONNECT_PROBE = `
const net = require('node:net');
const dgram = require('node:dgram');
const tcp = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port });
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(2500, () => done('timeout'));
  s.once('connect', () => done('connected'));
  s.once('error', (e) => done(e.code));
});
const udp = (host, port) => new Promise((resolve) => {
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from('x'), port, host, (e) => { s.close(); resolve(e ? e.code : 'sent'); });
});
Promise.all(JSON.parse(process.argv[1]).map(([proto, host, port]) =>
  proto === 'udp' ? udp(host, port) : tcp(host, port),
)).then((r) => process.stdout.write(JSON.stringify(r)));
`;

// The sandbox netns gets a ULA address and a default route on tap0 (from the host, through the
// guarded nsenter helper), so an IPv6 datagram is routable and only nft can stop it.
const V6_ADDR = 'fd77:6b78::100/64';
const V6_PROBE = `
const dgram = require('node:dgram');
const send = (host) => new Promise((resolve) => {
  const s = dgram.createSocket('udp6');
  s.send(Buffer.from('x'), 9, host, (e) => { s.close(); resolve(e ? e.code : 'sent'); });
});
Promise.all(['2001:db8::1', 'fd77:6b78::1'].map(send)).then((r) => process.stdout.write(JSON.stringify(r)));
`;

// One NFT_MSG_DELTABLE for inet/workbox in an nfnetlink batch; prints the kernel's ack errno.
const NFT_DELETE = `
socket(my $s, 16, 3, 12) or die "socket: $!";
sub msg { my ($type, $flags, $seq, $payload) = @_; pack("LSSLL", 16 + length($payload), $type, $flags, $seq, 0) . $payload }
my $name = "workbox\\0";
my $attr = pack("SS", 4 + length($name), 1) . $name;
my $batch = msg(0x10, 1, 1, pack("CCn", 0, 0, 10))
  . msg((10 << 8) | 2, 1 | 4, 2, pack("CCn", 1, 0, 0) . $attr)
  . msg(0x11, 1, 3, pack("CCn", 0, 0, 10));
send($s, $batch, 0, pack("SSLL", 16, 0, 0, 0)) or die "send: $!";
my $buf;
defined(recv($s, $buf, 65536, 0)) or die "recv: $!";
my ($len, $type, $flags, $seq, $pid, $err) = unpack("LSSLLl", $buf);
print "type=$type err=$err\\n";
`;

/** A real UDP DNS server answering A records from `records`; NXDOMAIN otherwise. */
async function dnsServer(records) {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    let off = 12;
    const labels = [];
    while (msg[off] !== 0) {
      labels.push(msg.subarray(off + 1, off + 1 + msg[off]).toString());
      off += msg[off] + 1;
    }
    const qtype = msg.readUInt16BE(off + 1);
    const addr = records[labels.join('.').toLowerCase()];
    const answers = addr && qtype === 1 ? [addr] : [];
    const head = Buffer.alloc(12);
    msg.copy(head, 0, 0, 2);
    head.writeUInt16BE(addr ? 0x8180 : 0x8183, 2);
    head.writeUInt16BE(1, 4);
    head.writeUInt16BE(answers.length, 6);
    const parts = [head, msg.subarray(12, off + 5)];
    for (const a of answers) {
      const rr = Buffer.alloc(16);
      rr.writeUInt16BE(0xc00c, 0);
      rr.writeUInt16BE(1, 2);
      rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(60, 6);
      rr.writeUInt16BE(4, 10);
      a.split('.').forEach((o, i) => rr.writeUInt8(Number(o), 12 + i));
      parts.push(rr);
    }
    sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
  });
  sock.bind(0, '127.0.0.1');
  await once(sock, 'listening');
  return sock;
}

function ip(...args) {
  execFileSync('ip', args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function startPeer() {
  const a = `${NS}a`;
  const b = `${NS}b`;
  ip('netns', 'add', NS);
  ip('link', 'add', a, 'type', 'veth', 'peer', 'name', b, 'netns', NS);
  ip('addr', 'add', `${PEER_HOST}/30`, 'dev', a);
  ip('link', 'set', a, 'up');
  ip('-n', NS, 'addr', 'add', `${PEER}/30`, 'dev', b);
  ip('-n', NS, 'link', 'set', b, 'up');
  ip('-n', NS, 'link', 'set', 'lo', 'up');
  const child = spawn('ip', ['netns', 'exec', NS, process.execPath, '-e', PEER_SERVER, PEER], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', (code) => reject(new Error(`peer exited ${code}`)));
  });
  return child;
}

function stopPeer(child) {
  child?.kill('SIGKILL');
  try {
    ip('netns', 'del', NS);
  } catch {
    // never created
  }
  try {
    ip('link', 'del', `${NS}a`);
  } catch {
    // went with the namespace
  }
}

/** Run `argv` in a sandbox netns from the host, through the host-namespace guard. */
async function inNetns(nsPid, argv) {
  const r = await runInNetns(nsPid, argv);
  assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

const hostRuleset = (nsPid) => inNetns(nsPid, ['nft', 'list', 'ruleset']);

function auditOf(eng, sandboxId, action) {
  const dir = eng.config.paths.audit;
  assert.equal(Audit.verify(dir).ok, true);
  return auditFiles(dir)
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean))
    .map((line) => JSON.parse(line))
    .filter((e) => e.sandboxId === sandboxId && e.action === action);
}

/**
 * The host's own uplink address, other than the test peer's veth: a public one when the host has
 * it, else (on a host behind NAT, such as a CI runner) its private one, which must be just as
 * unreachable from the box.
 */
function hostPublicAddress() {
  const v4 = [...hostAddresses()].filter(
    (a) => /^\d+\.\d+\.\d+\.\d+$/.test(a) && a !== PEER_HOST && !a.startsWith('127.'),
  );
  const pick = v4.find((a) => !isPrivateIpv4(a)) ?? v4.find((a) => a !== NET_DEFAULTS.proxyHost);
  assert.ok(pick, 'the host has an IPv4 address besides loopback and the test peer');
  return pick;
}

function boxOf(manager, id) {
  const exec = (argv) => manager.exec(id, { argv, timeoutMs: 60_000 });
  return {
    id,
    exec,
    sh: (script) => exec(['sh', '-c', script]),
    wbJson: async (args) => {
      const r = await exec(['wb', ...args, '--json']);
      assert.equal(r.exitCode, 0, r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').at(-1));
    },
    connect: async (targets) => {
      const r = await exec([NODE, '-e', CONNECT_PROBE, JSON.stringify(targets)]);
      assert.equal(r.exitCode, 0, r.stderr);
      return JSON.parse(r.stdout);
    },
    /** curl through this box's proxy, ignoring NO_PROXY; `tunnel` forces CONNECT. */
    viaProxy: async (url, tunnel = false) => {
      const flags = tunnel ? '-p ' : '';
      const r = await exec([
        'sh',
        '-c',
        `env -u NO_PROXY -u no_proxy curl -sg ${flags}--max-time 10 -x "$HTTP_PROXY" -w '\\n%{http_code} %{http_connect}' '${url}'`,
      ]);
      const lines = r.stdout.split('\n');
      const [code, connect] = lines.at(-1).split(' ');
      return { code, connect, body: lines.slice(0, -1).join('\n') };
    },
  };
}

async function until(fn, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function interfaces(stdout) {
  return stdout
    .split('\n')
    .slice(2)
    .map((l) => l.split(':')[0].trim())
    .filter(Boolean)
    .sort();
}

async function checkNone(box, manager, eng) {
  const dev = await box.sh('cat /proc/net/dev');
  assert.equal(dev.exitCode, 0, dev.stderr);
  assert.deepEqual(interfaces(dev.stdout), ['lo']);
  const env = await box.sh('printenv HTTP_PROXY HTTPS_PROXY || echo unset');
  assert.equal(env.stdout.trim(), 'unset');
  assert.deepEqual(
    await box.connect([
      ['tcp', PEER, 8081],
      ['udp', PEER, 9],
    ]),
    ['ENETUNREACH', 'ENETUNREACH'],
  );
  const rules = await hostRuleset(manager.nets.get(box.id).nsPid);
  assert.match(rules, /table inet workbox/);
  assert.match(rules, /policy drop/);
  const policy = await box.wbJson(['net', 'policy']);
  assert.equal(policy.mode, 'none');
  assert.equal(policy.proxy, null);
  const probe = await box.wbJson(['net', 'test', 'pub.test', '8081']);
  assert.equal(probe.allowed, false);
  assert.equal(probe.reason, 'network-none');
  assert.equal(probe.reachable, false);
  assert.equal(auditOf(eng, box.id, 'net.policy').length, 1);
  assert.equal(auditOf(eng, box.id, 'net.test').length, 1);
}

async function checkEgress(box, manager, eng, hostPort, hostHits) {
  const sbNet = manager.nets.get(box.id);
  const proxyHost = NET_DEFAULTS.proxyHost;
  const hostPublic = hostPublicAddress();
  assert.equal(sbNet.proxy.address().address, proxyHost);
  assert.ok(os.networkInterfaces()[PROXY_LINK].some((i) => i.address === proxyHost));
  const env = await box.sh('echo "$HTTP_PROXY|$HTTPS_PROXY|$NO_PROXY"');
  const [httpProxy, httpsProxy, noProxy] = env.stdout.trim().split('|');
  assert.match(httpProxy, new RegExp(`^http://${proxyHost.replaceAll('.', '\\.')}:\\d+$`));
  assert.equal(httpProxy, sbNet.proxyUrl);
  assert.equal(httpsProxy, httpProxy);
  assert.match(noProxy, /localhost/);
  const dev = await box.sh('cat /proc/net/dev');
  assert.deepEqual(interfaces(dev.stdout), ['lo', 'tap0']);

  // Public destinations: directly, and through the proxy by name (resolved on the host).
  const direct = await box.sh(`curl -s --noproxy '*' --max-time 10 http://${PEER}:8081/direct`);
  assert.equal(direct.stdout, 'peer:8081:/direct', direct.stderr);
  const byName = await box.viaProxy('http://pub.test:8081/named');
  assert.equal(byName.code, '200');
  assert.equal(byName.body, 'peer:8081:/named');
  const tunnel = await box.viaProxy('http://pub.test:8082/tunnel', true);
  assert.equal(tunnel.connect, '200');
  assert.equal(tunnel.body, 'peer:8082:/tunnel');

  // H13: the proxy never reaches blocked ranges, host loopback or the host itself.
  const proxyPort = Number(new URL(httpProxy).port);
  const denied = [
    [`http://127.0.0.1:${hostPort}/`, 'blocked-address'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked-address'],
    [`http://[::ffff:127.0.0.1]:${hostPort}/`, 'blocked-address'],
    [`http://localhost:${hostPort}/`, 'denied-name'],
    ['http://meta.test/latest/', 'blocked-address'],
    [`http://${PEER_HOST}:8081/`, 'host-address'],
    [`http://${hostPublic}:${hostPort}/`, 'host-address'],
    [`http://${proxyHost}:${proxyPort}/`, 'blocked-address'],
  ];
  for (const [url] of denied) assert.equal((await box.viaProxy(url)).code, '403', url);
  const viaConnect = await box.viaProxy(`http://127.0.0.1:${hostPort}/`, true);
  assert.equal(viaConnect.connect, '403');
  assert.equal(hostHits(), 0);
  const denials = auditOf(eng, box.id, 'net.deny');
  for (const [, reason] of denied)
    assert.ok(
      denials.some((d) => d.data.reason === reason),
      `audit has a ${reason} denial`,
    );
  assert.ok(denials.some((d) => d.data.method === 'CONNECT' && d.data.host === '127.0.0.1'));
  assert.ok(auditOf(eng, box.id, 'net.allow').some((d) => d.data.host === 'pub.test'));

  // nft: RFC1918, the gateway and the host's own addresses are dropped (EPERM on output).
  const dropped = [
    ['10.0.2.2', 80],
    ['10.0.2.2', proxyPort],
    ['10.0.0.1', 80],
    ['172.16.0.1', 80],
    ['192.168.0.1', 80],
    ['169.254.169.254', 80],
    [PEER_HOST, 8081],
    [proxyHost, 22],
    [hostPublic, 80],
    [hostPublic, hostPort],
  ];
  const udp = await box.connect([
    ['udp', PEER, 9],
    ['udp', '10.0.2.3', 53],
    ...dropped.map(([h, p]) => ['udp', h, p]),
  ]);
  assert.deepEqual(udp, ['sent', 'sent', ...Array(dropped.length).fill('EPERM')]);
  const tcp = await box.connect([
    ['tcp', '10.0.2.2', 80],
    ['tcp', PEER_HOST, 8081],
    ['tcp', hostPublic, 22],
  ]);
  for (const r of tcp) assert.ok(['EPERM', 'timeout'].includes(r), r);

  const policy = await box.wbJson(['net', 'policy']);
  assert.equal(policy.mode, 'egress');
  assert.equal(policy.proxy, httpProxy);
  const ok = await box.wbJson(['net', 'test', 'pub.test', '8081']);
  assert.equal(ok.allowed, true);
  assert.equal(ok.address, PEER);
  assert.equal(ok.reachable, true);
  const meta = await box.wbJson(['net', 'test', '169.254.169.254', '80']);
  assert.equal(meta.allowed, false);
  assert.equal(meta.reason, 'blocked-address');
  const tests = auditOf(eng, box.id, 'net.test');
  assert.deepEqual(
    tests.map((e) => [e.data.host, e.data.allowed]),
    [
      ['pub.test', true],
      ['169.254.169.254', false],
    ],
  );
}

async function checkIpv6Dropped(box, manager) {
  const nsPid = manager.nets.get(box.id).nsPid;
  await inNetns(nsPid, ['ip', '-6', 'addr', 'add', V6_ADDR, 'dev', 'tap0', 'nodad']);
  await inNetns(nsPid, ['ip', '-6', 'route', 'replace', 'default', 'dev', 'tap0']);
  const route = await inNetns(nsPid, ['ip', '-6', 'route', 'get', '2001:db8::1']);
  assert.match(route, /dev tap0/);
  assert.match(await hostRuleset(nsPid), /meta nfproto ipv6 drop/);
  const v6 = await box.exec([NODE, '-e', V6_PROBE]);
  assert.equal(v6.exitCode, 0, v6.stderr);
  assert.deepEqual(JSON.parse(v6.stdout), ['EPERM', 'EPERM']);
}

async function checkDns(box) {
  let hostResolves = true;
  try {
    await dns.promises.lookup('example.com');
  } catch {
    hostResolves = false;
  }
  if (!hostResolves) return 'host cannot resolve example.com';
  const r = await box.sh('getent ahostsv4 example.com');
  assert.equal(r.exitCode, 0, `in-box DNS through 10.0.2.3: ${r.stderr}`);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\.\d+\s/);
  return null;
}

async function checkRulesImmutable(box, manager) {
  const nsPid = manager.nets.get(box.id).nsPid;
  const before = await hostRuleset(nsPid);
  const caps = await box.sh("grep -E '^Cap(Eff|Bnd)' /proc/self/status");
  for (const line of caps.stdout.trim().split('\n')) {
    const mask = BigInt(`0x${line.split(/\s+/)[1]}`);
    assert.equal(mask & (1n << 12n), 0n, `CAP_NET_ADMIN absent: ${line}`);
  }
  const del = await box.exec(['perl', '-e', NFT_DELETE]);
  assert.equal(del.exitCode, 0, del.stderr);
  assert.equal(del.stdout.trim(), 'type=2 err=-1');
  assert.equal(await hostRuleset(nsPid), before);
  assert.match(before, /meta nfproto ipv6 drop/);
}

async function checkAllowlistA(a, b, eng) {
  assert.equal((await a.viaProxy('http://pub.test:8081/a')).body, 'peer:8081:/a');
  assert.equal((await a.viaProxy('http://pub.test/a80')).body, 'peer:80:/a80');
  const undeclared = await a.viaProxy('http://pub.test:8082/');
  assert.equal(undeclared.code, '403');
  const rebind = await a.viaProxy('http://rebind.test:8081/');
  assert.equal(rebind.code, '403');
  const rawIp = await a.viaProxy(`http://${PEER}:8081/`);
  assert.equal(rawIp.code, '403');
  const unlisted = await a.viaProxy('http://other.test:443/', true);
  assert.equal(unlisted.connect, '403');
  const bHost = new URL(b.proxyUrl).hostname;
  const bPort = Number(new URL(b.proxyUrl).port);
  const udp = await a.connect([
    ['udp', '10.0.2.3', 53],
    ['udp', PEER, 8081],
    ['udp', PEER, 80],
    ['udp', '10.0.2.2', 80],
    ['udp', bHost, bPort],
  ]);
  assert.deepEqual(udp, ['sent', 'EPERM', 'EPERM', 'EPERM', 'EPERM']);
  const tcp = await a.connect([
    ['tcp', PEER, 8081],
    ['tcp', bHost, bPort],
  ]);
  for (const r of tcp) assert.ok(['EPERM', 'timeout'].includes(r), r);
  const reasons = auditOf(eng, a.id, 'net.deny').map((d) => [
    d.data.method,
    d.data.host,
    d.data.reason,
  ]);
  assert.deepEqual(reasons, [
    ['GET', 'pub.test', 'port-not-declared'],
    ['GET', 'rebind.test', 'blocked-address'],
    ['GET', PEER, 'not-allowlisted'],
    ['CONNECT', 'other.test', 'not-allowlisted'],
  ]);
  const rebindDeny = auditOf(eng, a.id, 'net.deny').find((d) => d.data.host === 'rebind.test');
  assert.equal(rebindDeny.data.address, '10.0.0.1');
}

async function checkAllowlistB(b, a) {
  assert.equal((await b.viaProxy('http://other.test/b')).body, 'peer:80:/b');
  assert.equal((await b.viaProxy(`http://${PEER}/raw`)).body, 'peer:80:/raw');
  assert.equal((await b.viaProxy('http://pub.test:8081/')).code, '403');
  const aHost = new URL(a.proxyUrl).hostname;
  const aPort = Number(new URL(a.proxyUrl).port);
  const [udp, tcp] = await b.connect([
    ['udp', aHost, aPort],
    ['tcp', aHost, aPort],
  ]);
  assert.equal(udp, 'EPERM');
  assert.ok(['EPERM', 'timeout'].includes(tcp), tcp);
}

test('network: none, egress and allowlist against real slirp4netns, nft and the proxy', async (t) => {
  const eng = await testEngine({ network: 'none' });
  let peer = null;
  let dnsSock = null;
  let hits = 0;
  const hostListener = http.createServer((req, res) => {
    hits += 1;
    res.end('host-loopback');
  });
  let manager = null;
  const ids = [];
  try {
    peer = await startPeer();
    dnsSock = await dnsServer({
      'pub.test': PEER,
      'other.test': PEER,
      'rebind.test': '10.0.0.1',
      'meta.test': '169.254.169.254',
    });
    hostListener.listen(0, '127.0.0.1');
    await once(hostListener, 'listening');
    const newManager = () =>
      new Manager({
        config: eng.config,
        store: eng.store,
        audit: eng.audit,
        cgroups: eng.cgroups,
        rootfs: eng.rootfs,
        runtime: eng.runtime,
        logger: eng.logger,
        netResolver: [`127.0.0.1:${dnsSock.address().port}`],
      });
    manager = newManager();
    const create = async (name, network) => {
      const sb = await manager.create({
        name,
        profile: { network, limits: { memoryBytes: 256 * MiB, pids: 128 } },
      });
      ids.push(sb.id);
      return boxOf(manager, sb.id);
    };
    const none = await create('netnone', { mode: 'none' });
    await t.test(
      'req 1 ac_5: none has only loopback, rules installed, wb net against the broker',
      () => checkNone(none, manager, eng),
    );
    const egress = await create('netegress', { mode: 'egress' });
    await t.test('req 5 ac_1 + H13: egress reaches public, never private, gateway or host', () =>
      checkEgress(egress, manager, eng, hostListener.address().port, () => hits),
    );
    await t.test('H13: an IPv6 packet from egress is dropped by nft', () =>
      checkIpv6Dropped(egress, manager),
    );
    await t.test('req 5 ac_1: DNS works in egress', async (st) => {
      const skipped = await checkDns(egress);
      if (skipped) st.skip(skipped);
    });
    await t.test('req 5 ac_3: rules are installed from the host and unmodifiable inside', () =>
      checkRulesImmutable(egress, manager),
    );
    const a = await create('netallowa', {
      mode: 'allowlist',
      allow: ['pub.test', 'rebind.test'],
      ports: [8081],
    });
    const b = await create('netallowb', { mode: 'allowlist', allow: ['other.test', `${PEER}/32`] });
    a.proxyUrl = manager.nets.get(a.id).proxyUrl;
    b.proxyUrl = manager.nets.get(b.id).proxyUrl;
    assert.notEqual(a.proxyUrl, b.proxyUrl);
    await t.test('req 5 ac_2: allowlist enforced by the proxy, 403 + audit, rest dropped', () =>
      checkAllowlistA(a, b, eng),
    );
    await t.test("H12: sandbox B cannot use A's proxy or allowlist", () => checkAllowlistB(b, a));
    let liveSlirps = 3;
    await t.test(
      'restart: reconcile brings back proxy and slirp; health is SUSPECT without them',
      async () => {
        const old = manager.nets.get(egress.id);
        const urls = { egress: old.proxyUrl, a: manager.nets.get(a.id).proxyUrl };
        const oldSlirp = old.child.pid;
        // b loses its record, as a sandbox created before the record existed has none.
        fs.rmSync(path.join(eng.config.paths.sandboxes, b.id, NET_STATE_FILE));
        manager.close();
        await until(() => !hasTap(old.nsPid));

        manager = newManager();
        const rec = await manager.reconcile();
        assert.deepEqual(rec.attached.sort(), [none.id, egress.id, a.id].sort());
        assert.deepEqual(rec.suspect, [b.id]);
        assert.deepEqual(rec.quarantined, []);
        const net = manager.nets.get(egress.id);
        assert.equal(net.proxyUrl, urls.egress, 'the proxy is back on the URL the box holds');
        assert.notEqual(net.child.pid, oldSlirp, 'a new slirp4netns serves the same netns');
        assert.ok(hasTap(net.nsPid));
        assert.equal(manager.nets.get(a.id).proxyUrl, urls.a);
        assert.equal(manager.nets.has(b.id), false);

        const e2 = boxOf(manager, egress.id);
        const direct = await e2.sh(`curl -s --noproxy '*' --max-time 10 http://${PEER}:8081/after`);
        assert.equal(direct.stdout, 'peer:8081:/after', direct.stderr);
        assert.equal((await e2.viaProxy('http://pub.test:8081/after')).body, 'peer:8081:/after');
        assert.equal((await e2.viaProxy(`http://${hostPublicAddress()}:8081/`)).code, '403');
        const a2 = boxOf(manager, a.id);
        assert.equal((await a2.viaProxy('http://pub.test:8081/a')).body, 'peer:8081:/a');
        assert.equal((await a2.viaProxy('http://other.test/')).code, '403');
        assert.equal(auditOf(eng, egress.id, 'net.resume').length, 1);

        assert.equal(manager.supervisor(egress.id).observeHealth(), 'HEALTHY');
        assert.equal(manager.supervisor(none.id).observeHealth(), 'HEALTHY');
        assert.equal(manager.get(b.id).health, 'SUSPECT');
        assert.equal(manager.supervisor(b.id).observeHealth(), 'SUSPECT');
        process.kill(net.child.pid, 'SIGKILL');
        await until(() => !hasTap(net.nsPid));
        assert.equal(
          manager.supervisor(egress.id).observeHealth(),
          'SUSPECT',
          'a slirp4netns that dies under a live sandbox turns it SUSPECT',
        );
        liveSlirps = 2;
      },
    );
    await t.test('teardown: destroy stops slirp and the proxy', async () => {
      const slirps = ids.map((id) => manager.nets.get(id)?.child?.pid).filter(Boolean);
      const proxies = ids.map((id) => manager.nets.get(id)?.proxy).filter(Boolean);
      assert.equal(slirps.length, liveSlirps);
      for (const id of ids.splice(0)) await manager.destroy(id, { timeoutMs: 10_000 });
      assert.equal(manager.nets.size, 0);
      const gone = (pid) => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (e) {
          return e.code === 'ESRCH';
        }
      };
      for (let i = 0; i < 50 && !slirps.every(gone); i++)
        await new Promise((r) => setTimeout(r, 100));
      for (const pid of slirps) assert.ok(gone(pid), `slirp4netns ${pid} exited`);
      for (const p of proxies) assert.equal(p.listening, false);
    });
  } finally {
    for (const id of ids) await manager?.destroy(id, { timeoutMs: 10_000 }).catch(() => undefined);
    manager?.close();
    hostListener.closeAllConnections();
    hostListener.close();
    dnsSock?.close();
    stopPeer(peer);
    await eng.cleanup();
  }
});
