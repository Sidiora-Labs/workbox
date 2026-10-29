import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WorkboxClient } from '@workbox/sdk';
import {
  CONTROL_COMMANDS,
  CONTROL_USAGE,
  parseCpTarget,
  signalName,
  sandboxCp,
  sandboxKill,
  sandboxLogs,
  sandboxRun,
  sandboxWait,
} from '../../src/control.js';
import { sandboxCommand } from '../../src/commands.js';

/** A loopback URL nothing listens on. */
async function closedUrl() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return `http://127.0.0.1:${port}`;
}

test('cp operands: <id>:<path> is a sandbox path, anything else is local', () => {
  assert.deepEqual(parseCpTarget('sb_01ABC:/workspace/out.txt'), {
    id: 'sb_01ABC',
    path: '/workspace/out.txt',
  });
  assert.deepEqual(parseCpTarget('box-1.a:/a:b'), { id: 'box-1.a', path: '/a:b' });
  for (const local of ['./a:b', '/tmp/x', 'file.txt', 'x:'])
    assert.deepEqual(parseCpTarget(local), { local }, local);
});

test('signal names gain the SIG prefix and upper case', () => {
  assert.equal(signalName('term'), 'SIGTERM');
  assert.equal(signalName('KILL'), 'SIGKILL');
  assert.equal(signalName('SIGINT'), 'SIGINT');
});

test('every command checks its arguments before any request', async () => {
  const ctx = { out: { write() {} }, err: { write() {} } };
  const usage = (key) => (e) => e.code === 'E_INVALID_PARAMS' && e.message === CONTROL_USAGE[key];
  await assert.rejects(sandboxRun(ctx, []), usage('run'));
  await assert.rejects(sandboxRun(ctx, ['sb-1', 'echo']), usage('run'));
  await assert.rejects(sandboxRun(ctx, ['sb-1', '--']), usage('run'));
  await assert.rejects(sandboxLogs(ctx, ['sb-1']), usage('logs'));
  await assert.rejects(sandboxWait(ctx, ['sb-1']), usage('wait'));
  await assert.rejects(sandboxWait(ctx, ['sb-1', 'se-1', '--timeout', 'soon']), /--timeout/);
  assert.throws(() => sandboxKill(ctx, ['sb-1']), usage('kill'));
  await assert.rejects(sandboxCp(ctx, ['only-one']), usage('cp'));
  await assert.rejects(sandboxCp(ctx, ['a.txt', 'b.txt']), /exactly one side/);
  await assert.rejects(sandboxCp(ctx, ['sb-1:/a', 'sb-2:/b']), /exactly one side/);
  await assert.rejects(sandboxRun(ctx, ['sb-1', '--', 'true']), /needs a local engine or --server/);
});

test('sandbox subcommands route to these commands', async () => {
  assert.deepEqual(Object.keys(CONTROL_COMMANDS).sort(), ['cp', 'kill', 'logs', 'run', 'wait']);
  const ctx = { out: { write() {} }, err: { write() {} } };
  await assert.rejects(sandboxCommand(ctx, ['logs', 'sb-1']), (e) =>
    e.message.startsWith('workbox sandbox logs'),
  );
  await assert.rejects(sandboxCommand(ctx, ['nope']), /unknown sandbox subcommand nope/);
});

test('an upload of a missing or non-file local path fails before any request', async (t) => {
  const client = new WorkboxClient({ baseUrl: await closedUrl(), token: 't', retries: 0 });
  const ctx = { client, out: { write() {} }, err: { write() {} } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-cp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await assert.rejects(sandboxCp(ctx, [path.join(dir, 'missing'), 'sb-1:/tmp/x']), {
    code: 'E_NOT_FOUND',
  });
  await assert.rejects(sandboxCp(ctx, [dir, 'sb-1:/tmp/x']), { code: 'E_INVALID_PARAMS' });
});

test('against a server that is gone each command fails E_UNAVAILABLE and leaves no file', async (t) => {
  const client = new WorkboxClient({ baseUrl: await closedUrl(), token: 't', retries: 0 });
  const ctx = { client, out: { write() {} }, err: { write() {} } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-cp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'a.txt');
  fs.writeFileSync(local, 'a');
  const gone = { code: 'E_UNAVAILABLE' };
  await assert.rejects(sandboxRun(ctx, ['sb-1', '--', 'true']), gone);
  await assert.rejects(sandboxLogs(ctx, ['sb-1', 'se-1']), gone);
  await assert.rejects(sandboxWait(ctx, ['sb-1', 'se-1', '--timeout', '10']), gone);
  await assert.rejects(sandboxKill(ctx, ['sb-1', 'se-1', '--signal', 'int']), gone);
  await assert.rejects(sandboxCp(ctx, [local, 'sb-1:/tmp/']), gone);
  await assert.rejects(sandboxCp(ctx, ['sb-1:/tmp/b.txt', dir]), gone);
  assert.deepEqual(fs.readdirSync(dir), ['a.txt']);
});
