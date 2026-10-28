import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import dns from 'node:dns';
import { E } from '../errors.js';

/**
 * The host forward proxy (req 5.2): HTTP CONNECT + absolute-URI. One proxy serves one sandbox on
 * its own listener port, so the policy it enforces belongs to that sandbox by construction (nft in
 * each sandbox netns admits only its own port). Every name is resolved here on the host, the
 * answers are checked against the always-blocked ranges and the host's own addresses, and the
 * proxy connects to the address it checked with no second lookup (H13; the address policy is
 * derived from tryboxi internal/network/policy, MIT, see NOTICE). Every decision reaches
 * `onDecision`; denials answer 403.
 */

/** Destinations refused in every mode, whatever the allowlist says (H13). */
export const BLOCKED_CIDRS = Object.freeze([
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
  '::/128',
  '::1/128',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
  '::ffff:0:0/96',
]);

/** Ports a hostname or CIDR rule covers unless the policy declares more. */
export const DEFAULT_PORTS = Object.freeze([80, 443]);

const HOST_RE =
  /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const DENIED_NAME_RE = /(^|\.)(localhost|local|internal)$/;

/**
 * Per-family block lists. Node's BlockList matches IPv4 addresses against IPv4-mapped IPv6
 * subnets, so each family gets its own list and addresses are unmapped before the check.
 * @param {string[]} cidrs
 */
function cidrLists(cidrs) {
  const lists = { ipv4: new net.BlockList(), ipv6: new net.BlockList() };
  for (const cidr of cidrs) {
    const [addr, bits] = cidr.split('/');
    const family = net.isIPv6(addr) ? 'ipv6' : 'ipv4';
    lists[family].addSubnet(addr, Number(bits), family);
  }
  return lists;
}

const BLOCKED = cidrLists(BLOCKED_CIDRS);

/** @param {string} a IPv6 literal without brackets or zone @returns {number[]} eight groups */
function ipv6Groups(a) {
  let s = a;
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    s = `${s.slice(0, -dotted[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/**
 * Canonical address: brackets and zone stripped, IPv4-mapped IPv6 turned into IPv4.
 * @param {string} address
 */
export function unmapIp(address) {
  const a = String(address)
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase();
  if (!net.isIPv6(a)) return a;
  const g = ipv6Groups(a);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return a;
}

/** @param {string} address @returns {boolean} true for an always-blocked destination */
export function isBlockedAddress(address) {
  const a = unmapIp(address);
  if (net.isIPv4(a)) return BLOCKED.ipv4.check(a, 'ipv4');
  if (net.isIPv6(a)) return BLOCKED.ipv6.check(a, 'ipv6');
  return true;
}

/** Every address of this host's interfaces, unmapped. @returns {Set<string>} */
export function hostAddresses() {
  const out = new Set();
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list ?? []) out.add(unmapIp(i.address));
  return out;
}

/**
 * Normalise an allowlist entry: a hostname, `*.hostname`, or a CIDR (a bare IP becomes a /32 or
 * /128). Lower-cased.
 * @param {string} entry
 */
export function normalizeAllowEntry(entry) {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > 253)
    throw E.invalid(`invalid allowlist entry ${String(entry)}`);
  const lower = entry.toLowerCase();
  const [addr, bits, extra] = lower.split('/');
  if (net.isIP(addr)) {
    const max = net.isIPv6(addr) ? 128 : 32;
    const n = bits === undefined ? max : Number(bits);
    if (extra !== undefined || !/^\d{1,3}$/.test(String(n)) || n > max)
      throw E.invalid(`invalid allowlist CIDR ${entry}`);
    return `${addr}/${n}`;
  }
  const host = lower.startsWith('*.') ? lower.slice(2) : lower;
  if (!HOST_RE.test(host)) throw E.invalid(`invalid allowlist entry ${entry}`);
  return lower;
}

/** @param {string} entry normalised */
function isCidrEntry(entry) {
  return entry.includes('/');
}

/** @param {string} host @param {string[]} allow normalised hostname entries */
export function hostAllowed(host, allow) {
  const h = String(host).toLowerCase();
  return allow.some((entry) =>
    entry.startsWith('*.') ? h === entry.slice(2) || h.endsWith(entry.slice(1)) : h === entry,
  );
}

/**
 * Parse `host:port` or `[v6]:port` (default port 443 for CONNECT).
 * @param {string} target @param {number} [defPort]
 */
export function parseTarget(target, defPort = 443) {
  if (typeof target !== 'string' || target.length === 0) throw E.invalid('empty proxy target');
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(target) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(target);
  if (!m) throw E.invalid(`invalid proxy target ${target}`);
  const host = m[1];
  const port = m[2] === undefined ? defPort : Number(m[2]);
  if (!HOST_RE.test(host) && !net.isIP(host)) throw E.invalid(`invalid proxy host ${host}`);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw E.invalid(`invalid proxy port in ${target}`);
  return { host, port };
}

/**
 * Compile a sandbox network policy for repeated checks.
 * @param {{mode: 'egress'|'allowlist', allow?: string[], ports?: number[]}} policy
 * @param {Set<string>} [local] host addresses, always refused
 */
export function compilePolicy(policy, local = hostAddresses()) {
  if (!['egress', 'allowlist'].includes(policy?.mode))
    throw E.invalid(`proxy policy mode must be egress or allowlist, got ${String(policy?.mode)}`);
  const allow = (policy.allow ?? []).map(normalizeAllowEntry);
  const ports = new Set(DEFAULT_PORTS);
  for (const p of policy.ports ?? []) {
    if (!Number.isInteger(p) || p < 1 || p > 65535)
      throw E.invalid(`declared port must be in 1..65535, got ${String(p)}`);
    ports.add(p);
  }
  return {
    mode: policy.mode,
    hosts: allow.filter((e) => !isCidrEntry(e)),
    cidrs: cidrLists(allow.filter(isCidrEntry)),
    ports,
    local,
  };
}

function deny(reason, address) {
  return address === undefined ? { allowed: false, reason } : { allowed: false, reason, address };
}

function addressProblem(compiled, address) {
  if (isBlockedAddress(address)) return 'blocked-address';
  if (compiled.local.has(address)) return 'host-address';
  return null;
}

function checkAddress(compiled, ip, port) {
  const a = unmapIp(ip);
  const problem = addressProblem(compiled, a);
  if (problem) return deny(problem, a);
  if (compiled.mode === 'allowlist') {
    const family = net.isIPv6(a) ? 'ipv6' : 'ipv4';
    if (!compiled.cidrs[family].check(a, family)) return deny('not-allowlisted', a);
    if (!compiled.ports.has(port)) return deny('port-not-declared', a);
  }
  return { allowed: true, address: a };
}

/**
 * Decide one proxy target under a compiled policy. Names are resolved with `resolve` and every
 * answer must pass; the verdict carries the checked address to connect to.
 * @param {ReturnType<typeof compilePolicy>} compiled
 * @param {{host: string, port: number}} target
 * @param {(host: string) => Promise<string[]>} resolve
 * @returns {Promise<{allowed: boolean, reason?: string, address?: string}>}
 */
export async function checkTarget(compiled, target, resolve) {
  const host = String(target.host)
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (net.isIP(host)) return checkAddress(compiled, host, target.port);
  if (!HOST_RE.test(host)) return deny('invalid-host');
  if (DENIED_NAME_RE.test(host)) return deny('denied-name');
  if (compiled.mode === 'allowlist') {
    if (!hostAllowed(host, compiled.hosts)) return deny('not-allowlisted');
    if (!compiled.ports.has(target.port)) return deny('port-not-declared');
  }
  let answers;
  try {
    answers = (await resolve(host)).map(unmapIp);
  } catch {
    answers = [];
  }
  if (answers.length === 0) return deny('unresolved');
  for (const a of answers) {
    const problem = addressProblem(compiled, a);
    if (problem) return deny(problem, a);
  }
  return { allowed: true, address: answers[0] };
}

/**
 * Host-side name resolution: the system resolver, or the given DNS servers (`ip` or `ip:port`).
 * @param {string[]} [servers]
 * @returns {(host: string) => Promise<string[]>}
 */
export function makeResolver(servers) {
  if (!servers?.length)
    return async (host) =>
      (await dns.promises.lookup(host, { all: true, verbatim: true })).map((r) => r.address);
  const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 2 });
  resolver.setServers(servers);
  return async (host) => {
    const [a, aaaa] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    return [
      ...(a.status === 'fulfilled' ? a.value : []),
      ...(aaaa.status === 'fulfilled' ? aaaa.value : []),
    ];
  };
}

function forwardRequest(req, res, url, verdict, timeoutMs) {
  const headers = { ...req.headers, host: url.host };
  delete headers['proxy-connection'];
  delete headers['proxy-authorization'];
  const upstream = http.request(
    {
      host: verdict.address,
      port: Number(url.port || 80),
      path: `${url.pathname}${url.search}`,
      method: req.method,
      headers,
      timeout: timeoutMs,
      // A forward proxy connects directly; never chain through an ambient env proxy.
      agent: false,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  req.pipe(upstream);
}

async function handleRequest(req, res, decide, timeoutMs) {
  let url;
  try {
    url = new URL(req.url);
    if (url.protocol !== 'http:') throw new Error('only http: absolute URIs');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('proxy requires an absolute http URI\n');
    return;
  }
  const verdict = await decide(req.method, { host: url.hostname, port: Number(url.port || 80) });
  if (!verdict.allowed) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    res.end(`denied by workbox proxy policy: ${verdict.reason}\n`);
    return;
  }
  forwardRequest(req, res, url, verdict, timeoutMs);
}

async function handleConnect(req, clientSocket, head, decide, timeoutMs) {
  clientSocket.on('error', () => clientSocket.destroy());
  let target;
  try {
    target = parseTarget(req.url);
  } catch {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const verdict = await decide('CONNECT', target);
  if (!verdict.allowed) {
    clientSocket.end(`HTTP/1.1 403 Forbidden\r\nx-workbox-deny: ${verdict.reason}\r\n\r\n`);
    return;
  }
  const upstream = net.connect(target.port, verdict.address, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.setTimeout(timeoutMs, () => upstream.destroy());
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('close', () => upstream.destroy());
}

/**
 * The proxy for one sandbox. Connections from anything but this host's own addresses (where
 * slirp4netns connects from) are dropped before a byte is read.
 * @param {{policy: {mode: 'egress'|'allowlist', allow?: string[], ports?: number[]}, resolver?: string[], onDecision?: (info: object) => void, timeoutMs?: number, acceptFrom?: Set<string>}} opts
 * @returns {http.Server & {check: (target: {host: string, port: number}) => Promise<object>}}
 */
export function createProxy(opts) {
  const local = hostAddresses();
  const compiled = compilePolicy(opts.policy, local);
  const resolve = makeResolver(opts.resolver);
  const onDecision = opts.onDecision ?? (() => {});
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const acceptFrom = opts.acceptFrom ?? local;
  const check = (target) =>
    checkTarget(compiled, target, resolve).catch(() => deny('check-failed'));
  const decide = async (method, target) => {
    const verdict = await check(target);
    onDecision({ method, host: target.host, port: target.port, ...verdict });
    return verdict;
  };
  const server = http.createServer((req, res) => {
    handleRequest(req, res, decide, timeoutMs).catch(() => res.destroy());
  });
  server.on('connection', (socket) => {
    if (!acceptFrom.has(unmapIp(socket.remoteAddress ?? ''))) socket.destroy();
  });
  server.on('connect', (req, socket, head) => {
    handleConnect(req, socket, head, decide, timeoutMs).catch(() => socket.destroy());
  });
  return Object.assign(server, { check });
}
