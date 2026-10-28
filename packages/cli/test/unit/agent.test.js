import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AGENTS } from '@workbox/sdk';
import { agentCommand, planAgent, missingSecretError, AGENT_USAGE } from '../../src/agent.js';
import { main, HELP } from '../../src/main.js';
import { openLocalEngine } from '../../src/local.js';

const EXTRAS = ['@github', '@node', '@python'];
const prepared = (agent) => ['sh', '-c', `${AGENTS[agent].prepare}\nexec "$@"`, 'sh'];
const STDIN_NULL = ['sh', '-c', 'exec "$@" </dev/null', 'sh'];

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

const refused = (argv, message) =>
  assert.throws(
    () => planAgent(argv),
    (e) => e.code === 'E_INVALID_PARAMS' && e.message === message,
    argv.join(' '),
  );

test('interactive claude: a new allowlist box and a terminal session with the API key', () => {
  assert.deepEqual(planAgent(['claude'], { rows: 50, cols: 160 }), {
    agent: 'claude',
    id: null,
    prompt: null,
    detach: false,
    secretRefs: ['ANTHROPIC_API_KEY'],
    create: {
      name: 'agent-claude',
      rootfs: 'agents',
      profile: { network: { mode: 'allowlist', allow: ['@anthropic', ...EXTRAS] } },
      secretRefs: ['ANTHROPIC_API_KEY'],
      labels: { 'workbox.agent': 'claude' },
    },
    session: {
      argv: [...prepared('claude'), 'claude', '--dangerously-skip-permissions'],
      cwd: '/workspace',
      env: { IS_SANDBOX: '1' },
      name: 'agent-claude',
      secretRefs: ['ANTHROPIC_API_KEY'],
      pty: true,
      rows: 50,
      cols: 160,
    },
  });
  const noTerm = planAgent(['claude']).session;
  assert.equal(noTerm.rows, 24);
  assert.equal(noTerm.cols, 80);
});

test('headless codex: the key as CODEX_API_KEY, --allow extends the allowlist', () => {
  assert.deepEqual(
    planAgent([
      'codex',
      '-p',
      '-v is a prompt',
      '--name',
      'fix-bug',
      '--allow',
      'pypi.org',
      '--allow',
      '@go',
    ]),
    {
      agent: 'codex',
      id: null,
      prompt: '-v is a prompt',
      detach: false,
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
      create: {
        name: 'fix-bug',
        rootfs: 'agents',
        profile: {
          network: { mode: 'allowlist', allow: ['@openai', ...EXTRAS, 'pypi.org', '@go'] },
        },
        secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
        labels: { 'workbox.agent': 'codex' },
      },
      session: {
        argv: [
          ...STDIN_NULL,
          'codex',
          'exec',
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
          '--',
          '-v is a prompt',
        ],
        cwd: '/workspace',
        env: {},
        name: 'agent-codex',
        secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
        pty: false,
      },
    },
  );
});

test('--secret replaces the default credential, --no-secret grants none', () => {
  const oauth = planAgent(['claude', '--prompt', 'hi', '--secret', 'CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(oauth.secretRefs, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(oauth.create.secretRefs, ['CLAUDE_CODE_OAUTH_TOKEN']);
  assert.deepEqual(oauth.session.secretRefs, ['CLAUDE_CODE_OAUTH_TOKEN']);
  const two = planAgent(['codex', '--secret', 'MY_KEY=CODEX_API_KEY', '--secret', 'GH_TOKEN']);
  assert.deepEqual(two.session.secretRefs, ['MY_KEY=CODEX_API_KEY', 'GH_TOKEN']);
  const none = planAgent(['codex', '--no-secret', '--network', 'egress', '--detach']);
  assert.deepEqual(none.secretRefs, []);
  assert.deepEqual(none.create.secretRefs, []);
  assert.deepEqual(none.create.profile, { network: { mode: 'egress' } });
  assert.deepEqual(none.session.secretRefs, []);
  assert.equal(none.detach, true);
  assert.deepEqual(planAgent(['claude', '--network', 'none']).create.profile, {
    network: { mode: 'none' },
  });
});

test('a sandbox id reuses that box: no create input, the same session', () => {
  const plan = planAgent(['claude', 'sb-123', '-p', 'go on']);
  assert.equal(plan.id, 'sb-123');
  assert.equal(plan.create, null);
  assert.deepEqual(plan.session.argv, [
    ...STDIN_NULL,
    'claude',
    '--dangerously-skip-permissions',
    '-p',
    '--',
    'go on',
  ]);
  assert.deepEqual(plan.session.secretRefs, ['ANTHROPIC_API_KEY']);
});

test('every argument error names what is wrong', () => {
  refused([], `usage: ${AGENT_USAGE}`);
  refused(['gemini'], 'unknown agent gemini; known agents: claude, codex');
  refused(['toString'], 'unknown agent toString; known agents: claude, codex');
  refused(['claude', 'sb-1', 'extra'], `unexpected argument extra; usage: ${AGENT_USAGE}`);
  refused(['claude', '-p'], `-p needs a value; usage: ${AGENT_USAGE}`);
  refused(['claude', '--secret'], `--secret needs a value; usage: ${AGENT_USAGE}`);
  refused(['claude', '--json'], `unknown option --json; usage: ${AGENT_USAGE}`);
  refused(['claude', '-x'], `unknown option -x; usage: ${AGENT_USAGE}`);
  refused(
    ['claude', '--secret', 'A', '--no-secret'],
    '--secret and --no-secret exclude each other',
  );
  for (const flags of [
    ['--network', 'none'],
    ['--allow', 'x.org'],
    ['--name', 'n'],
  ])
    refused(
      ['claude', 'sb-1', ...flags],
      '--name, --network and --allow set up a new box; sandbox sb-1 already exists',
    );
  refused(['claude', '--network', 'open'], 'network must be allowlist, egress or none, got open');
  refused(
    ['claude', '--network', 'egress', '--allow', 'x.org'],
    'allow and extras apply to the allowlist network, not egress',
  );
  refused(['claude', '-p', ''], 'prompt must be a non-empty string');
  refused(['claude', '--secret', 'A=B=C'], 'secret reference A=B=C must be REF or REF=ENV');
});

test('a missing host secret names the file, the env, the alternatives and the sign-in', () => {
  const claude = missingSecretError('claude', 'ANTHROPIC_API_KEY');
  assert.equal(claude.code, 'E_NOT_FOUND');
  assert.deepEqual(claude.details, { ref: 'ANTHROPIC_API_KEY' });
  assert.equal(
    claude.message,
    'secret ANTHROPIC_API_KEY is not configured on the host: add it to ' +
      '/etc/workbox/secrets.json (a 0600 JSON object {"ANTHROPIC_API_KEY": "<value>"}) or set ' +
      "WORKBOX_SECRET_ANTHROPIC_API_KEY in the engine's environment; or use --secret " +
      'CLAUDE_CODE_OAUTH_TOKEN (Claude subscription OAuth token printed by `claude setup-token`) ' +
      'or --secret REF=ENV for another host secret; or pass --no-secret and sign in inside the ' +
      'box with `claude setup-token`',
  );
  const oauth = missingSecretError('claude', 'CLAUDE_CODE_OAUTH_TOKEN');
  assert.match(oauth.message, /^secret CLAUDE_CODE_OAUTH_TOKEN is not configured on the host/);
  assert.match(oauth.message, /or use --secret ANTHROPIC_API_KEY \(Claude API key from/);
  const codex = missingSecretError('codex', 'OPENAI_API_KEY');
  assert.match(codex.message, /WORKBOX_SECRET_OPENAI_API_KEY in the engine's environment; or use/);
  assert.match(codex.message, /or use --secret REF=ENV for another host secret; or pass/);
  assert.match(codex.message, /sign in inside the box with `codex login --device-auth`$/);
});

test('the help lists agent and sandbox attach', () => {
  assert.ok(HELP.includes('workbox agent <claude|codex> [<sandbox-id>] [-p|--prompt TEXT]'));
  assert.ok(HELP.includes('workbox sandbox attach <id> <sessionId>'));
  assert.ok(HELP.includes('--no-secret'));
});

test('the local engine refuses before it creates a box', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-agent-'));
  const engine = await openLocalEngine({
    env: {},
    overrides: { root: dir, secretsFile: path.join(dir, 'secrets.json') },
  });
  t.after(() => {
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = async (argv) => {
    const out = capture();
    const err = capture();
    const code = await main(argv, { engine, out: out.stream, err: err.stream });
    return { code, out: out.text(), err: err.text() };
  };
  const lacking = await run(['agent', 'claude', '-p', 'hi', '--network', 'none']);
  assert.equal(lacking.code, 3);
  assert.equal(
    lacking.err,
    `workbox: ${missingSecretError('claude', 'ANTHROPIC_API_KEY').message} (E_NOT_FOUND)\n`,
  );
  const codex = await run(['agent', 'codex', '-p', 'hi', '--network', 'none']);
  assert.equal(codex.code, 3);
  assert.match(codex.err, /^workbox: secret OPENAI_API_KEY is not configured on the host/);
  const detach = await run(['agent', 'claude', '-p', 'hi', '--detach', '--no-secret']);
  assert.equal(detach.code, 2);
  assert.equal(
    detach.err,
    "workbox: --detach on the local engine needs --network none: this CLI runs the box's " +
      'allowlist network (its proxy and slirp4netns), which would stop when the CLI exits; run ' +
      'the box under `workbox serve` and pass --server URL --token T (E_INVALID_PARAMS)\n',
  );
  const egress = await run(['agent', 'codex', '--network', 'egress', '--detach', '--no-secret']);
  assert.equal(egress.code, 2);
  assert.match(egress.err, /runs the box's egress network/);
  const missing = await run(['agent', 'claude', 'sb-nope', '-p', 'hi']);
  assert.equal(missing.code, 3);
  assert.match(missing.err, /sb-nope.*\(E_NOT_FOUND\)\n$/);
  const notty = await agentCommand(
    { engine, in: new PassThrough(), out: capture().stream, err: capture().stream },
    ['claude', '--no-secret'],
  ).then(
    () => null,
    (e) => e,
  );
  assert.equal(notty.code, 'E_INVALID_PARAMS');
  assert.equal(
    notty.message,
    'an interactive claude session needs a terminal on stdin; pass -p TEXT for a headless run',
  );
  await assert.rejects(agentCommand({ in: process.stdin }, ['claude', '-p', 'x']), {
    code: 'E_INVALID_PARAMS',
    message: 'workbox agent needs a local engine or --server',
  });
  assert.deepEqual(engine.store.listSandboxes().items, [], 'no refusal created a box');
});
