import { ProtocolError, Codes } from '@workbox/protocol';

/**
 * Preset recipes as data (task 2.4). Each step is an argv plus a verify argv whose first stdout
 * line is captured as the tool version. Versions are resolved once at install and recorded in
 * the manifest; re-install with an identical manifest is a no-op.
 */

const apt = (pkgs) => ({
  argv: [
    'sh',
    '-c',
    `apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${pkgs.join(' ')}`,
  ],
  verify: ['dpkg-query', '-W', pkgs[0]],
});

/** @typedef {{argv: string[], verify?: string[], tool?: string}} PresetStep */
/** @typedef {{summary: string, steps: PresetStep[]}} Preset */

/** All v1 presets, by name. @type {Record<string, Preset>} */
export const PRESETS = Object.freeze({
  web: {
    summary: 'Node 22, pnpm, bun and Chromium with Playwright system deps',
    steps: [
      {
        argv: [
          'sh',
          '-c',
          'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs',
        ],
        verify: ['node', '--version'],
        tool: 'node',
      },
      {
        argv: ['sh', '-c', 'corepack enable && corepack prepare pnpm@latest --activate'],
        verify: ['pnpm', '--version'],
        tool: 'pnpm',
      },
      {
        argv: ['sh', '-c', 'curl -fsSL https://bun.sh/install | bash'],
        verify: ['sh', '-c', '~/.bun/bin/bun --version'],
        tool: 'bun',
      },
      {
        argv: [
          'sh',
          '-c',
          'npx -y playwright install-deps chromium && npx -y playwright install chromium',
        ],
        verify: ['sh', '-c', 'npx -y playwright --version'],
        tool: 'playwright',
      },
    ],
  },
  python: {
    summary: 'Python 3.12 and uv',
    steps: [
      {
        ...apt(['python3', 'python3-venv', 'python3-pip']),
        verify: ['python3', '--version'],
        tool: 'python3',
      },
      {
        argv: ['sh', '-c', 'curl -LsSf https://astral.sh/uv/install.sh | sh'],
        verify: ['sh', '-c', '~/.local/bin/uv --version'],
        tool: 'uv',
      },
    ],
  },
  rust: {
    summary: 'rustup with the stable toolchain',
    steps: [
      {
        argv: [
          'sh',
          '-c',
          'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable',
        ],
        verify: ['sh', '-c', '~/.cargo/bin/rustc --version'],
        tool: 'rustc',
      },
    ],
  },
  go: {
    summary: 'Latest stable Go tarball into /usr/local/go',
    steps: [
      {
        argv: [
          'sh',
          '-c',
          'v=$(curl -fsSL "https://go.dev/VERSION?m=text" | head -1) && curl -fsSL "https://go.dev/dl/$v.linux-amd64.tar.gz" -o /tmp/go.tgz && rm -rf /usr/local/go && tar -C /usr/local -xzf /tmp/go.tgz',
        ],
        verify: ['/usr/local/go/bin/go', 'version'],
        tool: 'go',
      },
    ],
  },
  system: {
    summary: 'build-essential, clang, cmake, pkg-config',
    steps: [
      {
        ...apt(['build-essential', 'clang', 'cmake', 'pkg-config']),
        verify: ['cc', '--version'],
        tool: 'cc',
      },
    ],
  },
  agents: {
    summary: 'Claude Code and Codex CLIs (hyperfide when WORKBOX_HYPERFIDE_URL is set)',
    steps: [
      {
        argv: [
          'sh',
          '-c',
          'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && npm i -g @anthropic-ai/claude-code @openai/codex',
        ],
        verify: ['sh', '-c', 'claude --version'],
        tool: 'claude',
      },
    ],
  },
});

/** @returns {{name: string, summary: string}[]} */
export function listPresets() {
  return Object.entries(PRESETS)
    .map(([name, p]) => ({ name, summary: p.summary }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** @param {string} name @returns {Preset} */
export function getPreset(name) {
  const preset = PRESETS[name];
  if (!preset)
    throw new ProtocolError(Codes.NOT_FOUND, `unknown preset ${name}`, {
      known: Object.keys(PRESETS),
    });
  return preset;
}
