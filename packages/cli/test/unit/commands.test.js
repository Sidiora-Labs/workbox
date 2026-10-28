import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOpts,
  connectionOpts,
  withoutConnection,
  sandboxCommand,
  doctorCommand,
} from '../../src/commands.js';

test('option parsing and remote sandbox routing', async () => {
  assert.deepEqual(
    connectionOpts(['--server', 'http://x', '--token', 't', 'rest']).server,
    'http://x',
  );
  assert.equal(parseOpts(['--name', 'n'], new Set(['name'])).opts.name, 'n');
  const calls = [];
  const client = {
    createSandbox: async (input) => {
      calls.push(input);
      return { id: 'sb-1', row: { id: 'sb-1' } };
    },
    listSandboxes: async () => ({ items: [] }),
    sandbox: () => ({ inspect: async () => ({ id: 'sb-1' }), exec: async () => ({ exitCode: 0 }) }),
  };
  const ctx = { client, out: { write() {} }, err: { write() {} } };
  assert.deepEqual(await sandboxCommand(ctx, ['ls']), { items: [] });
  assert.deepEqual(await sandboxCommand(ctx, ['inspect', 'sb-1']), { id: 'sb-1' });
  assert.throws(() => parseOpts(['--name'], new Set(['name'])), /needs a value/);
});

test('connection flags are dropped anywhere before --, and kept after it', () => {
  assert.deepEqual(
    withoutConnection(['--server', 'http://x', 'rm', '--token', 't', 'sb-1', '--json']),
    ['rm', 'sb-1', '--json'],
  );
  assert.deepEqual(
    withoutConnection(['exec', 'sb-1', '--token', 't', '--', 'x', '--server', 'y']),
    ['exec', 'sb-1', '--', 'x', '--server', 'y'],
  );
  assert.deepEqual(withoutConnection(['--config', 'c.json', 'ls']), ['--config', 'c.json', 'ls']);
});

test('doctor without a local engine probes this host from the environment config', async (t) => {
  const parent = `workbox-cli-doctor-${process.pid}`;
  const saved = { root: process.env.WORKBOX_ROOT, parent: process.env.WORKBOX_CGROUP_PARENT };
  process.env.WORKBOX_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'workbox-cli-doctor-'));
  process.env.WORKBOX_CGROUP_PARENT = parent;
  t.after(() => {
    fs.rmSync(process.env.WORKBOX_ROOT, { recursive: true, force: true });
    if (fs.existsSync(`/sys/fs/cgroup/${parent}`)) fs.rmdirSync(`/sys/fs/cgroup/${parent}`);
    for (const [k, v] of [
      ['WORKBOX_ROOT', saved.root],
      ['WORKBOX_CGROUP_PARENT', saved.parent],
    ])
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const lines = [];
  const ctx = { client: {}, out: { write: (s) => lines.push(s) }, err: { write() {} } };
  const report = await doctorCommand(ctx, ['--json']);
  assert.ok(report.checks.find((c) => c.id === 'cgroup').detail.includes(parent));
  assert.equal(typeof report.ok, 'boolean');
  const ids = report.checks.map((c) => c.id);
  for (const id of ['bwrap', 'subuid', 'cgroup', 'overlay', 'node', 'proxy-link', 'docker'])
    assert.ok(ids.includes(id), `missing probe ${id}`);
  for (const c of report.checks) {
    assert.ok(['pass', 'fail', 'warn'].includes(c.status), c.id);
    if (c.status !== 'pass') assert.ok(c.remedy, `${c.id} has no remedy`);
  }
  assert.deepEqual(lines, []);
  const text = await doctorCommand(ctx, []);
  assert.equal(text.text, true);
  assert.match(lines.join(''), /doctor: host is (NOT )?ready\n$/);
});
