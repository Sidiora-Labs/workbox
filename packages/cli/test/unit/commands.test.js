import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { WorkboxClient } from '@workbox/sdk';
import {
  parseOpts,
  connectionOpts,
  withoutConnection,
  sandboxCommand,
  doctorCommand,
  shellCommand,
  runInteractive,
  runSession,
  followSession,
  sessionExitCode,
} from '../../src/commands.js';

/** A loopback URL nothing listens on. */
async function closedUrl() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('session exit status: its code, else 128 + the signal number', () => {
  assert.equal(sessionExitCode({ code: 3, signal: null }), 3);
  assert.equal(sessionExitCode({ code: 0, signal: null }), 0);
  assert.equal(sessionExitCode({ code: null, signal: 'SIGKILL' }), 137);
  assert.equal(sessionExitCode({ code: null, signal: 'SIGHUP' }), 129);
});

test('interactive runs need a terminal; without one the shell starts detached', async () => {
  const client = new WorkboxClient({ baseUrl: await closedUrl(), token: 't', retries: 0 });
  const input = new PassThrough();
  const errs = [];
  const ctx = { client, in: input, out: new PassThrough(), err: { write: (s) => errs.push(s) } };
  await assert.rejects(
    runInteractive(ctx, 'sb-1', { argv: ['/bin/bash'] }),
    (e) => e.code === 'E_INVALID_PARAMS' && /needs a terminal on stdin/.test(e.message),
    'refused before any request: the closed server would have answered E_UNAVAILABLE',
  );
  await assert.rejects(runInteractive({}, 'sb-1', { argv: ['/bin/bash'] }, { input }), (e) =>
    /needs a terminal/.test(e.message),
  );
  await assert.rejects(shellCommand(ctx, ['sb-1']), (e) => e.code === 'E_UNAVAILABLE');
  assert.deepEqual(errs, [], 'nothing claims a detached session that never started');
  await assert.rejects(shellCommand(ctx, []), /workbox shell <id>/);
});

test('sandbox attach needs both ids; a server that is gone fails the follow', async () => {
  const client = new WorkboxClient({ baseUrl: await closedUrl(), token: 't', retries: 0 });
  const ctx = { client, in: new PassThrough(), out: new PassThrough(), err: new PassThrough() };
  for (const argv of [['attach'], ['attach', 'sb-1']])
    await assert.rejects(sandboxCommand(ctx, argv), {
      message: 'workbox sandbox attach <id> <sessionId>',
    });
  await assert.rejects(
    sandboxCommand(ctx, ['attach', 'sb-1', 'se-1']),
    (e) =>
      e.code === 'E_UNAVAILABLE' &&
      /^connection to http:\/\/127\.0\.0\.1:\d+ lost: .*; session se-1 keeps running in sandbox sb-1$/.test(
        e.message,
      ),
  );
  await assert.rejects(followSession(ctx, 'sb-1', 'se-1'), { code: 'E_UNAVAILABLE' });
  await assert.rejects(runSession(ctx, 'sb-1', { argv: ['true'] }), { code: 'E_UNAVAILABLE' });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP'])
    assert.equal(process.listenerCount(s), 0, `no ${s} handler is left behind`);
});

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
