import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { E } from '../errors.js';
import { renderRuleset, installArgv, assertIpv4 } from './nft.js';
import { createProxy, hostAddresses } from './proxy.js';

/**
 * slirp4netns lifecycle, nft installation and the per-sandbox proxy (task 2.1). The sandbox is
 * spawned with `--unshare-net`; the host finds the first process of the sandbox that lives in
 * its own netns, attaches slirp to it (tap at 10.0.2.100/24, gateway 10.0.2.2, DNS 10.0.2.3) and
 * installs the ruleset there. slirp runs with `--disable-host-loopback`, so host loopback stays
 * unreachable; the proxy listens on a port of its own on the host-only dummy link `workbox0`
 * (198.18.0.1/32 by default, never a public interface), and nft admits only that address and
 * port. Every nsenter, nft and slirp4netns spawn goes through
 * `spawnGuarded`, which refuses a pid in the host's or this process's network namespace.
 */

/** Default slirp addressing. */
export const NET_DEFAULTS = Object.freeze({
  address: '10.0.2.100',
  gateway: '10.0.2.2',
  dns: '10.0.2.3',
  proxyHost: '198.18.0.1',
  mtu: 1500,
});

/** The host-only dummy link the sandbox proxies listen on. */
export const PROXY_LINK = 'workbox0';

/**
 * @param {{pid: number, tap?: string, mtu?: number, readyFd?: number}} opts
 * @returns {string[]}
 */
export function slirpArgv(opts) {
  if (!Number.isInteger(opts.pid) || opts.pid < 1)
    throw E.invalid('pid must be a positive integer', { pid: opts.pid });
  const tap = opts.tap ?? 'tap0';
  if (!/^[A-Za-z0-9_]{1,15}$/.test(tap)) throw E.invalid(`invalid tap name ${tap}`, { tap });
  const argv = [
    'slirp4netns',
    '--configure',
    '--mtu',
    String(opts.mtu ?? NET_DEFAULTS.mtu),
    '--disable-host-loopback',
  ];
  if (opts.readyFd !== undefined) argv.push(`--ready-fd=${opts.readyFd}`);
  argv.push(String(opts.pid), tap);
  return argv;
}

/**
 * Proxy environment injected into the sandbox for egress/allowlist modes.
 * @param {{mode: string, proxyHost?: string, proxyPort?: number}} policy
 * @returns {Record<string, string>}
 */
export function proxyEnv(policy) {
  if (policy.mode === 'none') return {};
  const host = assertIpv4(policy.proxyHost ?? NET_DEFAULTS.proxyHost, 'proxyHost');
  const url = `http://${host}:${policy.proxyPort ?? 8080}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };
}

/**
 * The three `ip` commands that put `address`/32 on the dummy link `workbox0` and bring it up.
 * @param {string} address IPv4
 * @returns {string[][]}
 */
export function proxyLinkArgv(address) {
  const a = assertIpv4(address, 'proxyHost');
  return [
    ['ip', 'link', 'add', PROXY_LINK, 'type', 'dummy'],
    ['ip', 'addr', 'replace', `${a}/32`, 'dev', PROXY_LINK],
    ['ip', 'link', 'set', PROXY_LINK, 'up'],
  ];
}

async function runHost(argv) {
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' },
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const [code] = await once(child, 'close');
  return { code, stderr: stderr.trim() };
}

/**
 * Create the host-only link the proxies bind to, idempotently: an existing `workbox0` is reused
 * and the address replaced. The link persists on the host after the sandboxes are gone; it is a
 * link with one /32 address and never touches the host firewall.
 * @param {string} [address]
 */
export async function ensureProxyLink(address = NET_DEFAULTS.proxyHost) {
  const [add, ...rest] = proxyLinkArgv(address);
  const added = await runHost(add);
  if (added.code !== 0 && !/File exists/.test(added.stderr))
    throw E.unavailable(`cannot create ${PROXY_LINK}: ${added.stderr}`, { code: added.code });
  for (const argv of rest) {
    const r = await runHost(argv);
    if (r.code !== 0) throw E.unavailable(`${argv.join(' ')} failed: ${r.stderr}`);
  }
}

function readNetns(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    return null;
  }
}

/**
 * The host-namespace guard: the network namespace of `pid`, refused with E_DENIED when it cannot
 * be read or is the host's (`/proc/1/ns/net`) or this process's own (`/proc/self/ns/net`).
 * @param {number} pid
 * @returns {string} the namespace link of `pid`, e.g. `net:[4026532481]`
 */
export function assertSandboxNetns(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw E.invalid('pid must be a positive integer', { pid });
  const ns = readNetns(pid);
  const host = readNetns(1);
  const self = readNetns('self');
  if (ns === null || host === null || self === null)
    throw E.denied(
      `refusing pid ${pid}: its network namespace cannot be compared with the host's`,
      {
        pid,
      },
    );
  if (ns === host || ns === self)
    throw E.denied(`refusing pid ${pid}: it is in the host network namespace`, { pid, netns: ns });
  return ns;
}

let spawned = 0;

/** Number of processes `spawnGuarded` has started in this process. */
export function guardedSpawnCount() {
  return spawned;
}

/**
 * Spawn an nsenter, nft or slirp4netns argv aimed at `pid`, with the host-namespace guard run
 * immediately before the spawn. Throws synchronously, before anything is spawned, on refusal.
 * @param {number} pid
 * @param {string[]} argv must name `pid`
 * @param {import('node:child_process').SpawnOptions} options
 */
export function spawnGuarded(pid, argv, options) {
  if (!Array.isArray(argv) || !argv.includes(String(pid)))
    throw E.invalid(`argv does not target pid ${pid}`, { pid });
  assertSandboxNetns(pid);
  spawned += 1;
  return spawn(argv[0], argv.slice(1), options);
}

/**
 * Run a guarded argv to completion.
 * @param {number} pid @param {string[]} argv
 * @returns {Promise<{code: number|null, stdout: string, stderr: string}>}
 */
export async function runGuarded(pid, argv) {
  const child = spawnGuarded(pid, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

/**
 * Run `argv` in the network namespace of sandbox process `pid` (nsenter -n), guarded.
 * @param {number} pid @param {string[]} argv
 */
export function runInNetns(pid, argv) {
  return runGuarded(pid, ['nsenter', '-t', String(pid), '-n', ...argv]);
}

function childrenOf(pid) {
  const out = [];
  let tasks = [];
  try {
    tasks = fs.readdirSync(`/proc/${pid}/task`);
  } catch {
    return out;
  }
  for (const tid of tasks) {
    try {
      const text = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf8').trim();
      if (text) out.push(...text.split(/\s+/).map(Number));
    } catch {
      // the task exited
    }
  }
  return out;
}

/**
 * The first process in `pid`'s tree, at most four levels down, whose network namespace is neither
 * the host's nor this process's. The launch pid is the outer bwrap, which stays in the host netns;
 * nft and slirp must never target that. pid 1 is refused: its tree is every host process.
 * @param {number} pid
 * @returns {number}
 */
export function netnsPid(pid) {
  if (pid === 1) throw E.denied('refusing pid 1: its process tree is the whole host', { pid });
  const host = new Set([readNetns(1), readNetns('self')]);
  const queue = [[pid, 0]];
  const seen = new Set();
  while (queue.length > 0 && seen.size < 256) {
    const [p, depth] = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const ns = readNetns(p);
    if (ns === null) continue;
    if (!host.has(ns)) return p;
    if (depth < 4) queue.push(...childrenOf(p).map((c) => [c, depth + 1]));
  }
  throw E.unavailable(`no process under pid ${pid} runs in its own network namespace`, { pid });
}

/** Attach slirp, start the sandbox's proxy and install nft rules for one sandbox. */
export class SandboxNet {
  /**
   * @param {{pid: number, sandboxId: string, policy: {mode: string, allow?: string[], ports?: number[]}, audit?: import('../audit.js').Audit, resolver?: string[], proxyHost?: string, readyTimeoutMs?: number}} opts
   */
  constructor(opts) {
    this.pid = opts.pid;
    this.sandboxId = opts.sandboxId;
    this.policy = {
      mode: opts.policy.mode,
      allow: [...(opts.policy.allow ?? [])],
      ports: [...(opts.policy.ports ?? [])],
    };
    this.audit = opts.audit ?? null;
    this.resolver = opts.resolver;
    this.proxyHost = opts.proxyHost;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;
    this.nsPid = null;
    this.child = null;
    this.proxy = null;
    this.proxyUrl = null;
    this.env = {};
    this.rules = null;
  }

  /** Start proxy and slirp (egress/allowlist), then install the ruleset; `none` gets rules only. */
  async start() {
    this.nsPid = netnsPid(this.pid);
    const rules = { mode: this.policy.mode, gateway: NET_DEFAULTS.gateway, dns: NET_DEFAULTS.dns };
    if (this.policy.mode !== 'none') {
      const host = assertIpv4(this.proxyHost ?? NET_DEFAULTS.proxyHost, 'proxyHost');
      await ensureProxyLink(host);
      const port = await this._startProxy(host);
      await this._startSlirp();
      Object.assign(rules, {
        proxyHost: host,
        proxyPort: port,
        hostAddresses: [...hostAddresses()].filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
      });
      this.env = proxyEnv({ mode: this.policy.mode, proxyHost: host, proxyPort: port });
      this.proxyUrl = this.env.HTTP_PROXY;
    }
    this.rules = await this.installRules(rules);
    return { policy: this.policy, env: this.env, proxy: this.proxyUrl };
  }

  async _startProxy(host) {
    this.proxy = createProxy({
      policy: this.policy,
      resolver: this.resolver,
      onDecision: (info) =>
        this.audit?.append({
          actor: 'proxy',
          action: info.allowed ? 'net.allow' : 'net.deny',
          sandboxId: this.sandboxId,
          data: info,
        }),
    });
    this.proxy.listen(0, host);
    await once(this.proxy, 'listening');
    return this.proxy.address().port;
  }

  async _startSlirp() {
    const argv = slirpArgv({ pid: this.nsPid, readyFd: 3 });
    const child = spawnGuarded(this.nsPid, argv, { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
    this.child = child;
    let err = '';
    child.stderr.on('data', (d) => {
      err += d;
    });
    await new Promise((resolve, reject) => {
      const fail = (msg) => {
        clearTimeout(timer);
        reject(E.unavailable(msg, { stderr: err.trim().slice(-2000) }));
      };
      const timer = setTimeout(() => fail('slirp4netns did not become ready'), this.readyTimeoutMs);
      child.stdio[3].once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('error', (e) => fail(`slirp4netns failed: ${e.message}`));
      child.once('exit', (code) => fail(`slirp4netns exited early with ${code}`));
    });
    child.stdio[3].destroy();
  }

  /**
   * Install (or reinstall) the nft ruleset in the sandbox netns.
   * @param {Parameters<typeof renderRuleset>[0]} policy
   */
  async installRules(policy) {
    const rules = renderRuleset(policy);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbox-nft-'));
    const file = path.join(dir, 'ruleset.nft');
    try {
      fs.writeFileSync(file, rules, { mode: 0o600 });
      const pid = this.nsPid ?? netnsPid(this.pid);
      const { code, stderr } = await runGuarded(pid, installArgv(pid, file).argv);
      if (code !== 0) throw E.unavailable(`nft install failed (${code}): ${stderr.trim()}`);
      return rules;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Decide a target exactly as this sandbox's proxy would. @param {{host: string, port: number}} target */
  check(target) {
    if (!this.proxy) return Promise.resolve({ allowed: false, reason: 'network-none' });
    return this.proxy.check(target);
  }

  /** Tear slirp and the proxy down; the netns itself dies with the sandbox. */
  stop() {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill('SIGTERM');
    this.child = null;
    if (this.proxy) {
      this.proxy.close();
      this.proxy.closeAllConnections();
    }
    this.proxy = null;
  }
}
