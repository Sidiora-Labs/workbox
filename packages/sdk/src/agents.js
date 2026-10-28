/**
 * Coding agents in a box: Claude Code and Codex as data. The `agents` rootfs (rootfs/agents)
 * bakes both CLIs with the configuration that lets them run unattended, because the Workbox
 * sandbox is the isolation boundary; these recipes turn a choice of agent into the exact
 * `createSandbox` input and `session.start` params the server accepts. Dependency-free.
 */

/** Working directory of agent sessions; the rootfs marks it trusted for both agents. */
export const AGENT_CWD = '/workspace';

const freeze = (o) => Object.freeze(o);
const credential = (ref, env, summary) => freeze({ ref, env, summary });

/**
 * @typedef {object} AgentCredential
 * @property {string} ref host secret reference (`ref=env` in secretRefs)
 * @property {string} env environment variable the CLI reads it from
 * @property {string} summary
 */
/**
 * @typedef {object} Agent
 * @property {string} summary
 * @property {string} rootfs
 * @property {readonly string[]} hostSets the allowlist host sets of the agent's API and sign-in
 * @property {readonly string[]} extras further allowlist entries a box gets unless replaced
 * @property {readonly AgentCredential[]} credentials what the CLI reads, in its order of preference
 * @property {string} signIn the in-box command of a subscription sign-in by code, no browser needed
 * @property {Readonly<Record<string, string>>} env non-secret session environment
 * @property {readonly string[]} interactive argv of the interactive CLI
 * @property {readonly string[]} headless argv prefix of a one-shot run; the prompt follows `--`
 */

/** The bundled agents, by name. @type {Readonly<Record<string, Agent>>} */
export const AGENTS = freeze({
  claude: freeze({
    summary: 'Claude Code 2.1.312',
    rootfs: 'agents',
    hostSets: freeze(['@anthropic']),
    extras: freeze(['@github', '@node', '@python']),
    credentials: freeze([
      credential(
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_API_KEY',
        'Claude API key from the Claude Console',
      ),
      credential(
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'Claude subscription OAuth token printed by `claude setup-token`',
      ),
    ]),
    signIn: 'claude setup-token',
    // Claude Code refuses bypassPermissions as root (box sessions are uid 0) unless IS_SANDBOX=1.
    env: freeze({ IS_SANDBOX: '1' }),
    interactive: freeze(['claude', '--dangerously-skip-permissions']),
    headless: freeze(['claude', '--dangerously-skip-permissions', '-p']),
  }),
  codex: freeze({
    summary: 'Codex 0.165.0',
    rootfs: 'agents',
    hostSets: freeze(['@openai']),
    extras: freeze(['@github', '@node', '@python']),
    credentials: freeze([
      // 0.165.0 authenticates from CODEX_API_KEY and ignores OPENAI_API_KEY in the environment.
      credential('OPENAI_API_KEY', 'CODEX_API_KEY', 'OpenAI API key, read by `codex exec`'),
    ]),
    signIn: 'codex login --device-auth',
    env: freeze({}),
    interactive: freeze(['codex', '--dangerously-bypass-approvals-and-sandbox']),
    headless: freeze([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
    ]),
  }),
});

/**
 * @param {string} agent
 * @returns {Agent}
 */
function agentOf(agent) {
  if (typeof agent === 'string' && Object.hasOwn(AGENTS, agent)) return AGENTS[agent];
  const known = Object.keys(AGENTS);
  throw Object.assign(
    new Error(`unknown agent ${String(agent)}; known agents: ${known.join(', ')}`),
    { code: 'E_INVALID_PARAMS', details: { agent, known } },
  );
}

function invalid(message, field) {
  return Object.assign(new Error(message), { code: 'E_INVALID_PARAMS', details: { field } });
}

function strings(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((s) => typeof s !== 'string' || s === ''))
    throw invalid(`${field} must be an array of non-empty strings`, field);
  return value;
}

function secretRefs(value) {
  const refs = strings(value, 'secretRefs');
  for (const r of refs)
    if (!/^[A-Za-z_][A-Za-z0-9_]*(=[A-Za-z_][A-Za-z0-9_]*)?$/.test(r))
      throw invalid(`secret reference ${r} must be REF or REF=ENV`, 'secretRefs');
  return [...refs];
}

/**
 * The `createSandbox` input of a box for one agent: the `agents` rootfs, an allowlist of the
 * agent's host sets plus the extras plus `allow` (or the whole public network with `egress`),
 * the secret policy and the `workbox.agent` label.
 * @param {string} agent `claude` or `codex`
 * @param {{name?: string, network?: 'allowlist'|'egress'|'none', allow?: string[], extras?: string[], secretRefs?: string[], labels?: Record<string, string>}} [opts]
 *   `name` defaults to `agent-<agent>`; `extras` replaces the agent's default extras; `allow`
 *   and `extras` apply to the allowlist only; `secretRefs` are `REF` or `REF=ENV`
 * @returns {{name: string, rootfs: string, profile: {network: {mode: string, allow?: string[]}}, secretRefs: string[], labels: Record<string, string>}}
 */
export function agentSandboxInput(agent, opts = {}) {
  const a = agentOf(agent);
  const mode = opts.network ?? 'allowlist';
  if (!['allowlist', 'egress', 'none'].includes(mode))
    throw invalid(`network must be allowlist, egress or none, got ${String(mode)}`, 'network');
  const allow = strings(opts.allow, 'allow');
  const extras = opts.extras === undefined ? a.extras : strings(opts.extras, 'extras');
  if (mode !== 'allowlist' && (allow.length || opts.extras !== undefined))
    throw invalid(`allow and extras apply to the allowlist network, not ${mode}`, 'allow');
  const network =
    mode === 'allowlist'
      ? { mode, allow: [...new Set([...a.hostSets, ...extras, ...allow])] }
      : { mode };
  return {
    name: opts.name ?? `agent-${agent}`,
    rootfs: a.rootfs,
    profile: { network },
    secretRefs: secretRefs(opts.secretRefs),
    labels: { ...opts.labels, 'workbox.agent': agent },
  };
}

/**
 * The `session.start` params that run an agent in its box: the interactive CLI on a terminal,
 * or with `prompt` a one-shot headless run (`claude -p`, `codex exec`) on plain pipes whose
 * stdin is the empty file, so neither CLI waits for piped input.
 * @param {string} agent `claude` or `codex`
 * @param {{prompt?: string, args?: string[], rows?: number, cols?: number, name?: string, cwd?: string, env?: Record<string, string>, secretRefs?: string[]}} [opts]
 *   `args` are extra CLI arguments placed before the prompt; `env` adds non-secret variables
 *   (credentials go through `secretRefs`); `rows`/`cols` size the terminal (default 24x80)
 * @returns {{argv: string[], cwd: string, env: Record<string, string>, name: string, pty: boolean, rows?: number, cols?: number, secretRefs: string[]}}
 */
export function agentSessionParams(agent, opts = {}) {
  const a = agentOf(agent);
  const args = strings(opts.args, 'args');
  const common = {
    cwd: opts.cwd ?? AGENT_CWD,
    env: { ...opts.env, ...a.env },
    name: opts.name ?? `agent-${agent}`,
    secretRefs: secretRefs(opts.secretRefs),
  };
  if (opts.prompt !== undefined) {
    if (typeof opts.prompt !== 'string' || opts.prompt === '')
      throw invalid('prompt must be a non-empty string', 'prompt');
    return {
      argv: ['sh', '-c', 'exec "$@" </dev/null', 'sh', ...a.headless, ...args, '--', opts.prompt],
      ...common,
      pty: false,
    };
  }
  return {
    argv: [...a.interactive, ...args],
    ...common,
    pty: true,
    rows: opts.rows ?? 24,
    cols: opts.cols ?? 80,
  };
}
