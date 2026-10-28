import { E } from '../errors.js';

/**
 * nftables rulesets for a sandbox network namespace (req 5). Pure rendering here; installation
 * runs `nft -f` inside the namespace via nsenter (netns.js) before the payload starts. The box
 * holds no CAP_NET_ADMIN, so the rules are unmodifiable from inside. The ruleset only ever
 * replaces its own `inet workbox` table, never the whole ruleset.
 */

/** CIDRs denied in egress mode: the IPv4 half of the proxy's always-blocked ranges (H13). */
export const DENIED_CIDRS = Object.freeze([
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '255.255.255.255/32',
]);

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** @param {string} ip */
export function assertIpv4(ip, name = 'address') {
  if (typeof ip !== 'string' || !IP_RE.test(ip) || ip.split('.').some((o) => Number(o) > 255))
    throw E.invalid(`${name} must be an IPv4 address, got ${String(ip)}`, { [name]: ip });
  return ip;
}

/** @param {string} ip */
export function isPrivateIpv4(ip) {
  assertIpv4(ip);
  const n = ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
  return DENIED_CIDRS.some((cidr) => {
    const [base, bits] = cidr.split('/');
    const b = base.split('.').reduce((a, o) => a * 256 + Number(o), 0);
    const shift = 32 - Number(bits);
    return Math.floor(n / 2 ** shift) === Math.floor(b / 2 ** shift);
  });
}

/** @param {number} port @param {string} name */
export function assertPort(port, name) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw E.invalid(`${name} must be in 1..65535`, { [name]: port });
  return port;
}

/**
 * Render the ruleset for a network mode. In egress and allowlist the box reaches DNS at `dns`
 * and its own proxy listener at `proxyHost:proxyPort`; egress additionally reaches public IPv4,
 * never the blocked ranges, the gateway or any `hostAddresses`. IPv6 is dropped in every mode.
 * @param {{mode: 'none'|'egress'|'allowlist', gateway?: string, dns?: string, proxyHost?: string, proxyPort?: number, hostAddresses?: string[]}} policy
 * @returns {string}
 */
export function renderRuleset(policy) {
  const { mode } = policy;
  if (!['none', 'egress', 'allowlist'].includes(mode))
    throw E.invalid(`unknown network mode ${String(mode)}`, { mode });
  const gateway = assertIpv4(policy.gateway ?? '10.0.2.2', 'gateway');
  const dns = assertIpv4(policy.dns ?? '10.0.2.3', 'dns');
  const lines = [
    'table inet workbox',
    'delete table inet workbox',
    'table inet workbox {',
    '  chain output {',
    '    type filter hook output priority 0; policy drop;',
    '    oif "lo" accept',
    '    meta nfproto ipv6 drop',
    '    ct state established,related accept',
  ];
  if (mode === 'egress' || mode === 'allowlist') {
    const proxyHost = assertIpv4(policy.proxyHost ?? gateway, 'proxyHost');
    const proxyPort = assertPort(policy.proxyPort ?? 8080, 'proxyPort');
    lines.push(`    ip daddr ${dns} udp dport 53 accept`);
    lines.push(`    ip daddr ${dns} tcp dport 53 accept`);
    lines.push(`    ip daddr ${proxyHost} tcp dport ${proxyPort} accept`);
  }
  if (mode === 'egress') {
    for (const cidr of DENIED_CIDRS) lines.push(`    ip daddr ${cidr} drop`);
    lines.push(`    ip daddr ${gateway} drop`);
    for (const addr of policy.hostAddresses ?? [])
      lines.push(`    ip daddr ${assertIpv4(addr, 'hostAddress')} drop`);
    lines.push('    meta nfproto ipv4 accept');
  }
  lines.push('  }', '  chain input {', '    type filter hook input priority 0; policy drop;');
  lines.push('    iif "lo" accept', '    meta nfproto ipv6 drop');
  lines.push('    ct state established,related accept', '  }', '}');
  return `${lines.join('\n')}\n`;
}

/**
 * Argv to install a rendered ruleset file inside the netns of `pid`. nft >= 1.0.9 reads `-f`
 * only from a regular file, so the ruleset is never piped.
 * @param {number} pid
 * @param {string} file absolute path of the rendered ruleset
 * @returns {{argv: string[]}}
 */
export function installArgv(pid, file) {
  if (!Number.isInteger(pid) || pid < 1) throw E.invalid('pid must be a positive integer', { pid });
  if (typeof file !== 'string' || !file.startsWith('/'))
    throw E.invalid('ruleset file must be an absolute path', { file });
  return { argv: ['nsenter', '-t', String(pid), '-n', 'nft', '-f', file] };
}
