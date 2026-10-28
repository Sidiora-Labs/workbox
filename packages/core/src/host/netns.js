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
 * unreachable; the proxy listens on a non-loopback host address on a port of its own, and nft
 * admits only that address and port.
 */

/** Default slirp addressing. */
export const NET_DEFAULTS = Object.freeze({
  address: '10.0.2.100',
  gateway: '10.0.2.2',
  dns: '10.0.2.3',
  mtu: 1500,
});

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
  const host = assertIpv4(policy.proxyHost ?? NET_DEFAULTS.gateway, 'proxyHost');
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

/** The host address the proxy binds to: the first non-loopback IPv4 of any interface. */
export function proxyHostAddress() {
  const v4 = [...hostAddresses()].filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const pick = v4.find((a) => !a.startsWith('127.'));
  if (!pick) throw E.unavailable('no non-loopback IPv4 host address for the sandbox proxy');
  return pick;
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
 * The first process in `pid`'s tree whose network namespace is not the host's. The launch pid is
 * the outer bwrap, which stays in the host netns; nft and slirp must never target that.
 * @param {number} pid
 * @returns {number}
 */
export function netnsPid(pid) {
  const host = fs.readlinkSync('/proc/self/ns/net');
  const queue = [pid];
  const seen = new Set();
  while (queue.length > 0 && seen.size < 256) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    let ns;
    try {
      ns = fs.readlinkSync(`/proc/${p}/ns/net`);
    } catch {
      continue;
    }
    if (ns !== host) return p;
    queue.push(...childrenOf(p));
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
      const host = this.proxyHost ?? proxyHostAddress();
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
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
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
      const { argv } = installArgv(this.nsPid ?? netnsPid(this.pid), file);
      const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
      });
      const [code] = await once(child, 'close');
      if (code !== 0) throw E.unavailable(`nft install failed (${code}): ${err.trim()}`);
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
