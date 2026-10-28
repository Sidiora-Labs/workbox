import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { E } from '../errors.js';
import { renderRuleset, installArgv, assertIpv4 } from './nft.js';

/**
 * slirp4netns lifecycle for one sandbox plus nft installation (task 2.1). The sandbox is spawned
 * with `--unshare-net`; the host attaches slirp to the sandbox pid's netns, giving it a tap at
 * 10.0.2.100/24 with gateway 10.0.2.2 and DNS 10.0.2.3 (matching supervisor resolv.conf).
 */

/** Default slirp addressing. */
export const NET_DEFAULTS = Object.freeze({
  address: '10.0.2.100',
  gateway: '10.0.2.2',
  dns: '10.0.2.3',
  mtu: 1500,
});

/**
 * @param {{pid: number, tap?: string, mtu?: number}} opts
 * @returns {string[]}
 */
export function slirpArgv(opts) {
  if (!Number.isInteger(opts.pid) || opts.pid < 1)
    throw E.invalid('pid must be a positive integer', { pid: opts.pid });
  const tap = opts.tap ?? 'tap0';
  if (!/^[A-Za-z0-9_]{1,15}$/.test(tap)) throw E.invalid(`invalid tap name ${tap}`, { tap });
  return [
    'slirp4netns',
    '--configure',
    '--mtu',
    String(opts.mtu ?? NET_DEFAULTS.mtu),
    '--disable-host-loopback',
    String(opts.pid),
    tap,
  ];
}

/**
 * Proxy environment injected into the sandbox for egress/allowlist modes.
 * @param {{mode: string, gateway?: string, proxyPort?: number}} policy
 * @returns {Record<string, string>}
 */
export function proxyEnv(policy) {
  if (policy.mode === 'none') return {};
  const gateway = assertIpv4(policy.gateway ?? NET_DEFAULTS.gateway, 'gateway');
  const url = `http://${gateway}:${policy.proxyPort ?? 8080}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: 'localhost,127.0.0.1',
  };
}

/** Attach slirp + install nft rules for a sandbox pid. */
export class SandboxNet {
  /**
   * @param {{pid: number, mode: string, gateway?: string, dns?: string, proxyPort?: number, spawnFn?: typeof spawn}} opts
   */
  constructor(opts) {
    this.pid = opts.pid;
    this.policy = {
      mode: opts.mode,
      gateway: opts.gateway ?? NET_DEFAULTS.gateway,
      dns: opts.dns ?? NET_DEFAULTS.dns,
      proxyPort: opts.proxyPort ?? 8080,
    };
    this.spawnFn = opts.spawnFn ?? spawn;
    this.child = null;
  }

  /** Start slirp (egress/allowlist) and install the ruleset. No-op for `none` beyond rules. */
  async start() {
    if (this.policy.mode !== 'none') {
      const argv = slirpArgv({ pid: this.pid });
      this.child = this.spawnFn(argv[0], argv.slice(1), { stdio: ['ignore', 'ignore', 'pipe'] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 1500);
        this.child.once('error', (e) => {
          clearTimeout(timer);
          reject(E.unavailable(`slirp4netns failed: ${e.message}`));
        });
        this.child.once('exit', (code) => {
          clearTimeout(timer);
          reject(E.unavailable(`slirp4netns exited early with ${code}`));
        });
      }).catch((e) => {
        if (this.child && this.child.exitCode === null) return undefined;
        throw e;
      });
    }
    await this.installRules();
    return { policy: this.policy, env: proxyEnv(this.policy) };
  }

  /** Install (or reinstall) the nft ruleset in the sandbox netns. */
  async installRules() {
    const rules = renderRuleset(this.policy);
    const { argv } = installArgv(this.pid);
    const child = this.spawnFn(argv[0], argv.slice(1), { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr?.on('data', (d) => {
      err += d;
    });
    child.stdin.end(rules);
    const [code] = await once(child, 'close');
    if (code !== 0) throw E.unavailable(`nft install failed (${code}): ${err.trim()}`);
    return rules;
  }

  /** Tear slirp down; the netns itself dies with the sandbox. */
  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill('SIGTERM');
    this.child = null;
  }
}
