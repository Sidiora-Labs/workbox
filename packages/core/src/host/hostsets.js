import { E } from '../errors.js';

/**
 * Named host sets for allowlist policies (task 2.4): the entry `@name` stands for every host of
 * the set. The lists include the CDNs real installs hit; `@ubuntu` also carries the Debian
 * mirrors the rootfs apt uses, and `@browsers` the Microsoft mirror `playwright install` also
 * fetches from.
 *
 * `@anthropic` and `@openai` are the hosts the coding agents in the `agents` rootfs need for API
 * use and sign-in, without telemetry. `@anthropic` covers the API and the claude.ai and Console
 * sign-in hosts from Claude Code's network requirements (code.claude.com/docs/en/network-config);
 * Claude Code sends its OAuth token exchange to platform.claude.com and everything else to
 * api.anthropic.com. `@openai` covers what Codex reaches: the API (api.openai.com), the ChatGPT
 * sign-in issuer with its device-code and token endpoints (auth.openai.com) and the ChatGPT
 * backend a signed-in Codex talks to (chatgpt.com).
 */
export const HOST_SETS = Object.freeze({
  node: Object.freeze([
    'registry.npmjs.org',
    '*.npmjs.org',
    'registry.yarnpkg.com',
    '*.yarnpkg.com',
    'repo.yarnpkg.com',
    'nodejs.org',
    'registry.npmmirror.com',
    'binaries.prisma.sh',
    'deb.nodesource.com',
    'bun.sh',
  ]),
  python: Object.freeze([
    'pypi.org',
    'files.pythonhosted.org',
    'download.pytorch.org',
    'astral.sh',
    '*.anaconda.org',
    'conda.anaconda.org',
  ]),
  go: Object.freeze([
    'proxy.golang.org',
    'sum.golang.org',
    'go.dev',
    'golang.org',
    'dl.google.com',
    'storage.googleapis.com',
  ]),
  rust: Object.freeze([
    'crates.io',
    'static.crates.io',
    'index.crates.io',
    'static.rust-lang.org',
    'sh.rustup.rs',
  ]),
  ubuntu: Object.freeze([
    'ports.ubuntu.com',
    'archive.ubuntu.com',
    'security.ubuntu.com',
    'ppa.launchpadcontent.net',
    'keyserver.ubuntu.com',
    'deb.debian.org',
    'security.debian.org',
  ]),
  github: Object.freeze([
    'github.com',
    '*.github.com',
    '*.githubusercontent.com',
    'codeload.github.com',
  ]),
  docker: Object.freeze([
    'docker.io',
    '*.docker.io',
    '*.docker.com',
    'ghcr.io',
    'pkg-containers.githubusercontent.com',
    'quay.io',
    '*.quay.io',
    'public.ecr.aws',
    'mcr.microsoft.com',
    '*.data.mcr.microsoft.com',
  ]),
  browsers: Object.freeze([
    'playwright.azureedge.net',
    'playwright-akamai.azureedge.net',
    'playwright-verizon.azureedge.net',
    'cdn.playwright.dev',
    'playwright.download.prss.microsoft.com',
    'googlechromelabs.github.io',
    'storage.googleapis.com',
    'edgedl.me.gvt1.com',
    'dl.google.com',
  ]),
  huggingface: Object.freeze(['huggingface.co', '*.huggingface.co', '*.hf.co']),
  anthropic: Object.freeze(['api.anthropic.com', 'claude.ai', 'platform.claude.com']),
  openai: Object.freeze(['api.openai.com', 'auth.openai.com', 'chatgpt.com']),
});

/** @param {unknown} entry @returns {boolean} true for an `@name` allowlist entry */
export function isHostSetEntry(entry) {
  return typeof entry === 'string' && entry.startsWith('@');
}

/**
 * The hosts of one `@name` entry (case-insensitive); an unknown set is a coded error.
 * @param {string} entry
 * @returns {readonly string[]}
 */
export function hostSet(entry) {
  const name = String(entry).slice(1).toLowerCase();
  if (!Object.hasOwn(HOST_SETS, name))
    throw E.invalid(`unknown allowlist host set ${entry}`, {
      known: Object.keys(HOST_SETS).map((n) => `@${n}`),
    });
  return HOST_SETS[name];
}

/**
 * Replace every `@name` entry with its hosts, keeping the other entries; duplicates collapse to
 * their first occurrence.
 * @param {string[]} entries
 * @returns {string[]}
 */
export function expandHostSets(entries) {
  const out = new Set();
  for (const entry of entries)
    for (const host of isHostSetEntry(entry) ? hostSet(entry) : [entry]) out.add(host);
  return [...out];
}
