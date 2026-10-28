import { E } from '../errors.js';

/**
 * nftables rulesets for a sandbox network namespace (req 5). Pure rendering here; installation
 * runs `nft -f -` inside the namespace via nsenter (netns.js) before the payload starts and
 * before CAP_NET_ADMIN is dropped, so rules are unmodifiable from inside.
 */

/** CIDRs denied in egress mode: RFC1918, link-local, multicast, CGNAT, loopback-off-device. */
export const DENIED_CIDRS = Object.freeze([
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
  '224.0.0.0/4',
  '0.0.0.0/8',
  '240.0.0.0/4',
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

/**
 * Render the ruleset for a network mode.
 * @param {{mode: 'none'|'egress'|'allowlist', gateway?: string, proxyPort?: number, dns?: string}} policy
 * @returns {string}
 */
export function renderRuleset(policy) {
  const { mode } = policy;
  if (!['none', 'egress', 'allowlist'].includes(mode))
    throw E.invalid(`unknown network mode ${String(mode)}`, { mode });
  const gateway = assertIpv4(policy.gateway ?? '10.0.2.2', 'gateway');
  const dns = assertIpv4(policy.dns ?? '10.0.2.3', 'dns');
  const proxyPort = policy.proxyPort ?? 8080;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535)
    throw E.invalid('proxyPort must be in 1..65535', { proxyPort });
  const lines = [
    'flush ruleset',
    'table inet workbox {',
    '  chain output {',
    '    type filter hook output priority 0; policy drop;',
    '    oif "lo" accept',
    '    ct state established,related accept',
  ];
  if (mode === 'egress' || mode === 'allowlist') {
    lines.push(`    ip daddr ${dns} udp dport 53 accept`);
    lines.push(`    ip daddr ${dns} tcp dport 53 accept`);
    lines.push(`    ip daddr ${gateway} tcp dport ${proxyPort} accept`);
  }
  if (mode === 'egress') {
    for (const cidr of DENIED_CIDRS) lines.push(`    ip daddr ${cidr} drop`);
    lines.push(`    ip daddr ${gateway} drop`);
    lines.push('    ip daddr != 0.0.0.0/0 drop');
    lines.push('    accept');
  }
  lines.push('  }', '  chain input {', '    type filter hook input priority 0; policy drop;');
  lines.push('    iif "lo" accept', '    ct state established,related accept', '  }', '}');
  return `${lines.join('\n')}\n`;
}

/**
 * Argv to install a rendered ruleset inside the netns of `pid` (rules fed on stdin).
 * @param {number} pid
 * @returns {{argv: string[]}}
 */
export function installArgv(pid) {
  if (!Number.isInteger(pid) || pid < 1) throw E.invalid('pid must be a positive integer', { pid });
  return { argv: ['nsenter', '-t', String(pid), '-n', 'nft', '-f', '-'] };
}
