import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BODY_SCHEMAS } from '@workbox/server';
import { validate } from '../../../protocol/src/schema.js';
import { AGENTS, AGENT_CWD, agentSandboxInput, agentSessionParams } from '../../src/agents.js';
import { PRESETS } from '../../../wb/src/presets.js';

const DOCKERFILE = fileURLToPath(new URL('../../../../rootfs/agents/Dockerfile', import.meta.url));
const EXTRAS = ['@github', '@node', '@python'];
const STDIN_NULL = ['sh', '-c', 'exec "$@" </dev/null', 'sh'];

test('AGENTS: frozen recipes for claude and codex', () => {
  assert.deepEqual(Object.keys(AGENTS), ['claude', 'codex']);
  assert.ok(Object.isFrozen(AGENTS));
  for (const a of Object.values(AGENTS)) {
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.credentials) && Object.isFrozen(a.env));
    assert.equal(a.rootfs, 'agents');
    assert.deepEqual(a.extras, EXTRAS);
  }
  assert.deepEqual(AGENTS.claude.hostSets, ['@anthropic']);
  assert.deepEqual(AGENTS.codex.hostSets, ['@openai']);
  assert.deepEqual(
    AGENTS.claude.credentials.map(({ ref, env }) => [ref, env]),
    [
      ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY'],
      ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
    ],
  );
  assert.deepEqual(
    AGENTS.codex.credentials.map(({ ref, env }) => [ref, env]),
    [['OPENAI_API_KEY', 'CODEX_API_KEY']],
  );
  for (const c of [...AGENTS.claude.credentials, ...AGENTS.codex.credentials])
    assert.ok(c.summary.length > 0);
  assert.equal(AGENTS.claude.signIn, 'claude setup-token');
  assert.equal(AGENTS.codex.signIn, 'codex login --device-auth');
  assert.deepEqual(AGENTS.claude.env, { IS_SANDBOX: '1' });
  assert.deepEqual(AGENTS.codex.env, {});
  assert.equal(AGENT_CWD, '/workspace');
});

test('agentSandboxInput: allowlist by default, extras replaceable, egress and none', () => {
  assert.deepEqual(agentSandboxInput('claude'), {
    name: 'agent-claude',
    rootfs: 'agents',
    profile: { network: { mode: 'allowlist', allow: ['@anthropic', ...EXTRAS] } },
    secretRefs: [],
    labels: { 'workbox.agent': 'claude' },
  });
  assert.deepEqual(
    agentSandboxInput('codex', {
      name: 'fix-bug',
      allow: ['pypi.org', '@node', '10.0.0.0/8'],
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
      labels: { team: 'core', 'workbox.agent': 'spoofed' },
    }),
    {
      name: 'fix-bug',
      rootfs: 'agents',
      profile: {
        network: {
          mode: 'allowlist',
          allow: ['@openai', ...EXTRAS, 'pypi.org', '10.0.0.0/8'],
        },
      },
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
      labels: { team: 'core', 'workbox.agent': 'codex' },
    },
  );
  assert.deepEqual(
    agentSandboxInput('claude', { extras: [], allow: ['example.org'] }).profile.network,
    { mode: 'allowlist', allow: ['@anthropic', 'example.org'] },
  );
  assert.deepEqual(
    agentSandboxInput('claude', { network: 'allowlist', extras: ['@go'] }).profile.network,
    { mode: 'allowlist', allow: ['@anthropic', '@go'] },
  );
  assert.deepEqual(agentSandboxInput('codex', { network: 'egress' }).profile, {
    network: { mode: 'egress' },
  });
  assert.deepEqual(agentSandboxInput('claude', { network: 'none' }).profile, {
    network: { mode: 'none' },
  });
  assert.throws(
    () => agentSandboxInput('claude', { network: 'egress', allow: ['x.org'] }),
    (e) =>
      e.code === 'E_INVALID_PARAMS' && /apply to the allowlist network, not egress/.test(e.message),
  );
  assert.throws(() => agentSandboxInput('claude', { network: 'none', extras: [] }), /not none/);
  assert.throws(
    () => agentSandboxInput('claude', { network: 'open' }),
    /allowlist, egress or none/,
  );
  assert.throws(() => agentSandboxInput('claude', { allow: 'x.org' }), /allow must be an array/);
  assert.throws(
    () => agentSandboxInput('claude', { secretRefs: ['A=B=C'] }),
    /secret reference A=B=C must be REF or REF=ENV/,
  );
});

test('agentSandboxInput output passes the server create schema', () => {
  for (const input of [
    agentSandboxInput('claude', { secretRefs: ['ANTHROPIC_API_KEY'] }),
    agentSandboxInput('codex', { network: 'egress' }),
  ])
    assert.deepEqual(validate(BODY_SCHEMAS['POST /v1/sandboxes'], input), { ok: true });
});

test('agentSessionParams: interactive on a terminal with the bypass flags', () => {
  assert.deepEqual(agentSessionParams('claude'), {
    argv: ['claude', '--dangerously-skip-permissions'],
    cwd: '/workspace',
    env: { IS_SANDBOX: '1' },
    name: 'agent-claude',
    secretRefs: [],
    pty: true,
    rows: 24,
    cols: 80,
  });
  assert.deepEqual(
    agentSessionParams('codex', {
      rows: 50,
      cols: 200,
      name: 'pair',
      args: ['-m', 'gpt-6.1-sol'],
      env: { FOO: 'bar' },
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
      cwd: '/workspace/repo',
    }),
    {
      argv: ['codex', '--dangerously-bypass-approvals-and-sandbox', '-m', 'gpt-6.1-sol'],
      cwd: '/workspace/repo',
      env: { FOO: 'bar' },
      name: 'pair',
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
      pty: true,
      rows: 50,
      cols: 200,
    },
  );
  assert.deepEqual(agentSessionParams('claude', { env: { IS_SANDBOX: '0' } }).env, {
    IS_SANDBOX: '1',
  });
});

test('agentSessionParams: headless with a prompt, stdin the empty file', () => {
  assert.deepEqual(agentSessionParams('claude', { prompt: 'fix the tests' }), {
    argv: [...STDIN_NULL, 'claude', '--dangerously-skip-permissions', '-p', '--', 'fix the tests'],
    cwd: '/workspace',
    env: { IS_SANDBOX: '1' },
    name: 'agent-claude',
    secretRefs: [],
    pty: false,
  });
  assert.deepEqual(
    agentSessionParams('codex', {
      prompt: '-v is a prompt, not a flag',
      args: ['--json'],
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
    }),
    {
      argv: [
        ...STDIN_NULL,
        'codex',
        'exec',
        '--dangerously-bypass-approvals-and-sandbox',
        '--skip-git-repo-check',
        '--json',
        '--',
        '-v is a prompt, not a flag',
      ],
      cwd: '/workspace',
      env: {},
      name: 'agent-codex',
      secretRefs: ['OPENAI_API_KEY=CODEX_API_KEY'],
      pty: false,
    },
  );
  assert.throws(() => agentSessionParams('codex', { prompt: '' }), /prompt must be a non-empty/);
  assert.throws(() => agentSessionParams('codex', { args: [''] }), /args must be an array/);
});

test('agentSessionParams output passes the session.start schema', () => {
  for (const params of [
    agentSessionParams('claude', { secretRefs: ['ANTHROPIC_API_KEY'] }),
    agentSessionParams('codex', { prompt: 'hello' }),
  ])
    assert.deepEqual(validate(BODY_SCHEMAS['POST /v1/sandboxes/:id/sessions'], params), {
      ok: true,
    });
});

test('an unknown agent names the known ones', () => {
  for (const fn of [agentSandboxInput, agentSessionParams])
    for (const bad of ['gemini', 'toString', undefined])
      assert.throws(
        () => fn(bad),
        (e) =>
          e instanceof Error &&
          e.code === 'E_INVALID_PARAMS' &&
          e.message === `unknown agent ${String(bad)}; known agents: claude, codex` &&
          e.details.known.join() === 'claude,codex',
      );
});

test('rootfs/agents pins equal the agents preset of wb', () => {
  const text = fs.readFileSync(DOCKERFILE, 'utf8');
  const arg = (name) => text.match(new RegExp(`^ARG ${name}=(\\S+)$`, 'm'))?.[1];
  const preset = PRESETS.agents.steps.map((s) => s.argv.at(-1)).join('\n');
  const node = arg('NODE_VERSION');
  assert.match(node, /^v\d+\.\d+\.\d+$/);
  assert.ok(preset.includes(`/node-${node}-linux-x64.tar.xz`), `preset fetches node ${node}`);
  assert.ok(preset.includes(`"${arg('NODE_SHA256')}  `), 'preset checks the same node sha256');
  assert.ok(preset.includes(`@anthropic-ai/claude-code@${arg('CLAUDE_CODE_VERSION')} `));
  assert.ok(preset.includes(`@openai/codex@${arg('CODEX_VERSION')}`));
  assert.equal(AGENTS.claude.summary, `Claude Code ${arg('CLAUDE_CODE_VERSION')}`);
  assert.equal(AGENTS.codex.summary, `Codex ${arg('CODEX_VERSION')}`);
  assert.match(text, /sha256sum -c -/);
  assert.match(text, /npm cache clean --force/);
});
