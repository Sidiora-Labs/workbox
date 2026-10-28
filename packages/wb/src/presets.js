import { createHash } from 'node:crypto';
import { ProtocolError, Codes } from '@workbox/protocol';

/**
 * Preset recipes as data (task 2.4). Each step is an argv run as root in the box plus, per tool it
 * provides, a verify argv whose first output line is captured as the version and the path whose
 * resolved file is digested into the manifest. Versions are pinned here with the publisher's
 * sha256 wherever a download is fetched; the floating ones the spec names ("stable" rust, "latest
 * stable" go) are `resolve` argvs run once at install, recorded in the manifest and reused on every
 * re-install. Each preset names the allowlist host sets (`@name`) its downloads need.
 */

/** Where the in-box preparation manifests live. */
export const PRESET_DIR = '/var/lib/workbox-preset';

const WORK = '/var/cache/workbox-preset';
const bash = (script) => ['bash', '-c', `set -euo pipefail; ${script}`];
const fetchChecked = (url, sha256, dest) =>
  `mkdir -p ${WORK} && curl -fsSL --retry 3 -o ${dest} "${url}" && echo "${sha256}  ${dest}" | sha256sum -c -`;
const apt = (pkgs) =>
  `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgs.join(' ')}`;
const tool = (bin, ...args) => ({ verify: [bin, ...(args.length ? args : ['--version'])], bin });

const NODE = {
  version: 'v22.23.4',
  sha256: '1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce',
};
const UV = {
  version: '0.13.6',
  sha256: 'f29c3e94ffabd7e6f3ba521dba169a9b7ec12100bf3257087f0f24f6123f3645',
};
const NPM_PINS = {
  pnpm: '12.15.0',
  bun: '1.4.4',
  playwright: '1.64.1',
  claude: '2.1.312',
  codex: '0.165.0',
};

const nodeStep = {
  argv: bash(
    `${fetchChecked(`https://nodejs.org/dist/${NODE.version}/node-${NODE.version}-linux-x64.tar.xz`, NODE.sha256, `${WORK}/node.tar.xz`)} && tar -C /usr/local --strip-components=1 --no-same-owner -xJf ${WORK}/node.tar.xz`,
  ),
  tools: { node: tool('/usr/local/bin/node'), npm: tool('/usr/local/bin/npm') },
};

/**
 * @typedef {object} ToolCheck
 * @property {string[]} verify version command; its first stdout line (else stderr) is the version
 * @property {string} bin path whose resolved file is sha256-digested into the manifest
 */
/**
 * @typedef {object} PresetStep
 * @property {string[]} argv install command
 * @property {Record<string, ToolCheck>} tools the tools this step provides, by manifest name
 * @property {string} [when] run only when this environment variable is set
 */
/**
 * @typedef {object} Preset
 * @property {string} summary
 * @property {string[]} hosts the `@name` host sets an allowlist policy must name
 * @property {Record<string, string[]>} [resolve] floating versions: argv printing the version,
 *   exposed to the steps as `WB_PIN_<KEY>`
 * @property {PresetStep[]} steps
 */

/** All v1 presets, by name. @type {Readonly<Record<string, Preset>>} */
export const PRESETS = Object.freeze({
  web: {
    summary: 'Node 22, pnpm, bun and Chromium with Playwright system deps',
    hosts: ['@node', '@browsers', '@ubuntu'],
    steps: [
      nodeStep,
      {
        argv: bash(
          `npm install -g pnpm@${NPM_PINS.pnpm} bun@${NPM_PINS.bun} playwright@${NPM_PINS.playwright}`,
        ),
        tools: {
          pnpm: tool('/usr/local/bin/pnpm'),
          bun: tool('/usr/local/bin/bun'),
          playwright: tool('/usr/local/bin/playwright'),
        },
      },
      {
        argv: bash(
          'export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright; playwright install --with-deps chromium && ln -sfT "$(find /ms-playwright -path "*/chrome-linux*/chrome" -type f | head -1)" /usr/local/bin/workbox-chromium',
        ),
        tools: { chromium: tool('/usr/local/bin/workbox-chromium') },
      },
    ],
  },
  python: {
    summary: 'Python 3.12 and uv',
    hosts: ['@python', '@github'],
    steps: [
      {
        argv: bash(
          `${fetchChecked(`https://github.com/astral-sh/uv/releases/download/${UV.version}/uv-x86_64-unknown-linux-gnu.tar.gz`, UV.sha256, `${WORK}/uv.tar.gz`)} && tar -C ${WORK} -xzf ${WORK}/uv.tar.gz && install -m 0755 -T ${WORK}/uv-x86_64-unknown-linux-gnu/uv /usr/local/bin/uv && install -m 0755 -T ${WORK}/uv-x86_64-unknown-linux-gnu/uvx /usr/local/bin/uvx`,
        ),
        tools: { uv: tool('/usr/local/bin/uv') },
      },
      {
        argv: bash(
          'export UV_PYTHON_INSTALL_DIR=/opt/workbox-python UV_PYTHON_BIN_DIR=/usr/local/bin UV_PYTHON_PREFERENCE=only-managed; /usr/local/bin/uv python install 3.12 && ln -sfT "$(/usr/local/bin/uv python find 3.12)" /usr/local/bin/python3',
        ),
        tools: { python3: tool('/usr/local/bin/python3') },
      },
    ],
  },
  rust: {
    summary: 'rustup with the stable toolchain',
    hosts: ['@rust'],
    resolve: {
      rust: bash(
        `curl -fsSL https://static.rust-lang.org/dist/channel-rust-stable.toml | sed -n '/^\\[pkg\\.rust\\]$/,/^version/s/^version = "\\([0-9.]*\\) .*/\\1/p'`,
      ),
    },
    steps: [
      {
        argv: bash(
          `export RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo; mkdir -p ${WORK} && curl --proto "=https" --tlsv1.2 -fsSL -o ${WORK}/rustup-init.sh https://sh.rustup.rs && sh ${WORK}/rustup-init.sh -y --no-modify-path --profile minimal --default-toolchain "$WB_PIN_RUST" && for b in rustc cargo; do ln -sfT "$RUSTUP_HOME/toolchains/$WB_PIN_RUST-x86_64-unknown-linux-gnu/bin/$b" /usr/local/bin/$b; done`,
        ),
        tools: { rustc: tool('/usr/local/bin/rustc'), cargo: tool('/usr/local/bin/cargo') },
      },
    ],
  },
  go: {
    summary: 'Latest stable Go tarball into /usr/local/go',
    hosts: ['@go'],
    resolve: { go: bash('curl -fsSL "https://go.dev/VERSION?m=text" | head -1') },
    steps: [
      {
        argv: bash(
          `u="https://dl.google.com/go/$WB_PIN_GO.linux-amd64.tar.gz"; ${fetchChecked('$u', '$(curl -fsSL "$u.sha256")', `${WORK}/go.tgz`)} && rm -rf /usr/local/go && tar -C /usr/local -xzf ${WORK}/go.tgz && ln -sfT /usr/local/go/bin/go /usr/local/bin/go && ln -sfT /usr/local/go/bin/gofmt /usr/local/bin/gofmt`,
        ),
        tools: { go: tool('/usr/local/go/bin/go', 'version') },
      },
    ],
  },
  system: {
    summary: 'build-essential, clang, cmake, pkg-config',
    hosts: ['@ubuntu'],
    steps: [
      {
        argv: bash(apt(['build-essential', 'clang', 'cmake', 'pkg-config'])),
        tools: {
          cc: tool('/usr/bin/cc'),
          clang: tool('/usr/bin/clang'),
          cmake: tool('/usr/bin/cmake'),
          'pkg-config': tool('/usr/bin/pkg-config'),
        },
      },
    ],
  },
  agents: {
    summary: 'Claude Code and Codex CLIs (hyperfide when WORKBOX_HYPERFIDE_URL is set)',
    hosts: ['@node'],
    steps: [
      nodeStep,
      {
        argv: bash(
          `npm install -g @anthropic-ai/claude-code@${NPM_PINS.claude} @openai/codex@${NPM_PINS.codex}`,
        ),
        tools: { claude: tool('/usr/local/bin/claude'), codex: tool('/usr/local/bin/codex') },
      },
      {
        when: 'WORKBOX_HYPERFIDE_URL',
        argv: bash(
          `${fetchChecked('$WORKBOX_HYPERFIDE_URL', '$WORKBOX_HYPERFIDE_SHA256', `${WORK}/hyperfide`)} && install -m 0755 -T ${WORK}/hyperfide /usr/local/bin/hyperfide`,
        ),
        tools: { hyperfide: tool('/usr/local/bin/hyperfide') },
      },
    ],
  },
});

/** @returns {{name: string, summary: string, hosts: string[]}[]} */
export function listPresets() {
  return Object.entries(PRESETS)
    .map(([name, p]) => ({ name, summary: p.summary, hosts: [...p.hosts] }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** @param {string} name @returns {Preset} */
export function getPreset(name) {
  const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
  if (!preset)
    throw new ProtocolError(Codes.NOT_FOUND, `unknown preset ${name}`, {
      known: Object.keys(PRESETS),
    });
  return preset;
}

/** sha256 of the recipe data: a changed pin or step is a different recipe. @param {Preset} preset */
export function recipeDigest(preset) {
  return createHash('sha256').update(JSON.stringify(preset)).digest('hex');
}

/**
 * Refuse an install the sandbox network cannot serve, before any step runs: `none` never can, and
 * an allowlist must already name every host set the preset needs. The policy is the host's; this
 * never asks to widen it.
 * @param {string} name @param {Preset} preset
 * @param {{mode: string, allow?: string[]}} policy as `broker.net.policy` reports it
 */
export function assertPresetNetwork(name, preset, policy) {
  if (policy.mode === 'none')
    throw new ProtocolError(Codes.DENIED, `preset ${name} needs network; the sandbox has none`, {
      reason: 'network-none',
      hosts: [...preset.hosts],
    });
  if (policy.mode !== 'allowlist') return;
  const named = new Set((policy.allow ?? []).map((e) => String(e).toLowerCase()));
  const missing = preset.hosts.filter((h) => !named.has(h));
  if (missing.length)
    throw new ProtocolError(
      Codes.DENIED,
      `preset ${name} needs allowlist host set(s) ${missing.join(', ')}; ask the operator to add them to the sandbox network policy`,
      { reason: 'host-set-missing', missing },
    );
}
