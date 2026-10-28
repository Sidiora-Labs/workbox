import { AGENTS, agentSandboxInput, agentSessionParams } from '@workbox/sdk';
import { runInteractive, runSession } from './commands.js';

/**
 * `workbox agent`: Claude Code or Codex in a box of the `agents` rootfs, from the SDK recipes.
 * Interactive on this terminal, headless with `-p`, or started detached with `--detach`, against
 * the local engine or `--server`.
 */

/** Usage line of `workbox agent`. */
export const AGENT_USAGE =
  'workbox agent <claude|codex> [<sandbox-id>] [-p|--prompt TEXT] [--name N] ' +
  '[--network allowlist|egress|none] [--allow HOST|@set]... [--secret REF[=ENV]]... ' +
  '[--no-secret] [--detach] [--server URL --token T]';

/** Where an engine reads host secrets unless WORKBOX_SECRETS_FILE moves it. */
const SECRETS_FILE = '/etc/workbox/secrets.json';

function invalid(message) {
  return Object.assign(new Error(message), { code: 'E_INVALID_PARAMS' });
}

/** `REF`, or `REF=ENV` when the CLI reads the secret under another name. */
const credentialRef = (c) => (c.ref === c.env ? c.ref : `${c.ref}=${c.env}`);

/** @param {string[]} argv */
function parseArgs(argv) {
  const opts = { allow: [], secrets: [], noSecret: false, detach: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw invalid(`${a} needs a value; usage: ${AGENT_USAGE}`);
      return argv[++i];
    };
    if (a === '-p' || a === '--prompt') opts.prompt = value();
    else if (a === '--name') opts.name = value();
    else if (a === '--network') opts.network = value();
    else if (a === '--allow') opts.allow.push(value());
    else if (a === '--secret') opts.secrets.push(value());
    else if (a === '--no-secret') opts.noSecret = true;
    else if (a === '--detach') opts.detach = true;
    else if (a.startsWith('-')) throw invalid(`unknown option ${a}; usage: ${AGENT_USAGE}`);
    else positional.push(a);
  }
  return { opts, positional };
}

/**
 * Turn `workbox agent` arguments into what runs: the `createSandbox` input of a new box (null when
 * a sandbox id is given) and the `session.start` params, both with the same secret refs. The
 * refs default to the agent's first credential; `--secret` replaces it and `--no-secret` grants
 * none.
 * @param {string[]} argv the arguments after `agent`, without `--server`/`--token`
 * @param {{rows?: number, cols?: number}} [term] the terminal size an interactive session gets
 * @returns {{agent: string, id: string|null, prompt: string|null, detach: boolean, secretRefs: string[], create: object|null, session: object}}
 */
export function planAgent(argv, term = {}) {
  const { opts, positional } = parseArgs(argv);
  const [agent, id = null, extra] = positional;
  if (!agent) throw invalid(`usage: ${AGENT_USAGE}`);
  if (!Object.hasOwn(AGENTS, agent))
    throw invalid(`unknown agent ${agent}; known agents: ${Object.keys(AGENTS).join(', ')}`);
  if (extra !== undefined) throw invalid(`unexpected argument ${extra}; usage: ${AGENT_USAGE}`);
  if (opts.noSecret && opts.secrets.length)
    throw invalid('--secret and --no-secret exclude each other');
  if (id && (opts.name !== undefined || opts.network !== undefined || opts.allow.length))
    throw invalid(`--name, --network and --allow set up a new box; sandbox ${id} already exists`);
  const a = AGENTS[agent];
  let secretRefs = [credentialRef(a.credentials[0])];
  if (opts.noSecret) secretRefs = [];
  else if (opts.secrets.length) secretRefs = [...opts.secrets];
  const create = id
    ? null
    : agentSandboxInput(agent, {
        name: opts.name,
        network: opts.network,
        allow: opts.allow,
        secretRefs,
      });
  const session = agentSessionParams(agent, {
    prompt: opts.prompt,
    secretRefs,
    rows: term.rows || undefined,
    cols: term.cols || undefined,
  });
  return {
    agent,
    id,
    prompt: opts.prompt ?? null,
    detach: opts.detach,
    secretRefs,
    create,
    session,
  };
}

/**
 * The error of a host that lacks a secret: where to configure it, the agent's other credentials
 * and the sign-in inside the box. Code E_NOT_FOUND, like the engine's own.
 * @param {string} agent
 * @param {string} ref the host secret reference, without `=ENV`
 */
export function missingSecretError(agent, ref) {
  const a = AGENTS[agent];
  const others = a.credentials
    .filter((c) => c.ref !== ref)
    .map((c) => `--secret ${credentialRef(c)} (${c.summary})`);
  const alternatives = [...others, '--secret REF=ENV for another host secret'].join(' or ');
  return Object.assign(
    new Error(
      `secret ${ref} is not configured on the host: add it to ${SECRETS_FILE} ` +
        `(a 0600 JSON object {"${ref}": "<value>"}) or set WORKBOX_SECRET_${ref} in the engine's ` +
        `environment; or use ${alternatives}; or pass --no-secret and sign in inside the box ` +
        `with \`${a.signIn}\``,
    ),
    { code: 'E_NOT_FOUND', details: { ref } },
  );
}

/** The ref a session start failed on for want of a host secret, else null. */
function missingRef(e) {
  if (e?.code !== 'E_NOT_FOUND') return null;
  return /^secret (\S+) is not configured on the host/.exec(e.message ?? '')?.[1] ?? null;
}

const refName = (r) => r.split('=')[0];

/** Box operations on the local manager or, with `ctx.client`, the server. @param {object} ctx */
function boxes(ctx) {
  const c = ctx.client;
  if (c)
    return {
      local: null,
      inspect: (id) => c.sandbox(id).inspect(),
      create: (input) => c.createSandbox(input),
      start: (id, params) => c.sandbox(id).startSession(params),
      destroy: (id) => c.sandbox(id).destroy(),
    };
  const m = ctx.engine?.manager;
  if (!m) throw invalid('workbox agent needs a local engine or --server');
  return {
    local: m,
    inspect: async (id) => m.inspect(id),
    create: (input) => m.create(input),
    start: (id, params) => m.request(id, 'session.start', params),
    destroy: (id) => m.destroy(id),
  };
}

/**
 * What the local engine refuses up front: `--detach` while this CLI would carry the box's
 * network, and a secret the host does not have.
 */
function checkLocal(ctx, m, plan, row) {
  const mode =
    plan.create?.profile.network.mode ??
    row?.profile?.network?.mode ??
    ctx.engine.config.network.mode;
  if (plan.detach && mode !== 'none')
    throw invalid(
      `--detach on the local engine needs --network none: this CLI runs the box's ${mode} ` +
        'network (its proxy and slirp4netns), which would stop when the CLI exits; run the ' +
        'box under `workbox serve` and pass --server URL --token T',
    );
  const lacking = plan.secretRefs.map(refName).find((r) => !m.secrets?.has(r));
  if (lacking) throw missingSecretError(plan.agent, lacking);
}

/**
 * `workbox agent <claude|codex> [<sandbox-id>] ...` (see {@link AGENT_USAGE}). Without a sandbox
 * id it creates a box from `agentSandboxInput` and names it on stderr; with one it reuses that
 * box, which must run the `agents` rootfs. Interactive runs go through `runInteractive`,
 * headless runs (`-p`) stream the agent's stdout and stderr live and give its exit code, and
 * `--detach` returns `{sandboxId, sessionId}` at once. A host without the granted secret fails
 * with {@link missingSecretError}, and a box created for the run is removed again.
 * @param {object} ctx `{engine}` or `{client}`, with `in`/`out`/`err`
 * @param {string[]} argv
 */
export async function agentCommand(ctx, argv) {
  const input = ctx.in ?? process.stdin;
  const out = ctx.out ?? process.stdout;
  const err = ctx.err ?? process.stderr;
  const plan = planAgent(argv, { rows: out.rows, cols: out.columns });
  const { agent } = plan;
  if (plan.prompt === null && !plan.detach && !input.isTTY)
    throw invalid(
      `an interactive ${agent} session needs a terminal on stdin; pass -p TEXT for a headless run`,
    );
  const box = boxes(ctx);
  const row = plan.id ? await box.inspect(plan.id) : null;
  if (row && row.rootfs !== AGENTS[agent].rootfs)
    throw invalid(
      `sandbox ${plan.id} runs the ${row.rootfs} rootfs; ${agent} needs a box of the ` +
        `${AGENTS[agent].rootfs} rootfs (omit the sandbox id to create one)`,
    );
  if (box.local) checkLocal(ctx, box.local, plan, row);
  const id = row ? plan.id : (await box.create(plan.create)).id;
  if (!row)
    err.write(
      `workbox: new sandbox ${id} for ${agent}; reuse it with: workbox agent ${agent} ${id}\n`,
    );
  try {
    if (plan.detach) {
      const started = await box.start(id, plan.session);
      return { sandboxId: id, sessionId: started.sessionId };
    }
    if (plan.prompt === null) return await runInteractive(ctx, id, plan.session, { input, out });
    return await runSession(ctx, id, plan.session, { input, out, err });
  } catch (e) {
    const ref = missingRef(e);
    if (!ref) throw e;
    if (!row) await box.destroy(id).catch(() => undefined);
    throw missingSecretError(agent, ref);
  }
}
