import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { selfSigned } from '../../../server/test/helpers/tls.js';

const SDK = pathToFileURL(fileURLToPath(new URL('../../src/index.js', import.meta.url))).href;

/** Run `script` as an ES module in a fresh node; resolves with its exit code and output. */
function runNode(script, env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: { ...process.env, ...env }, timeout: 120_000 },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const CLIENT = `
import { WorkboxClient } from ${JSON.stringify(SDK)};
const as = (token) => new WorkboxClient({ baseUrl: process.env.WB_BASE, token, retries: 0 });
const admin = as(process.env.WB_ADMIN);
const harness = as(process.env.WB_EXEC);
const out = { health: await admin.health() };
const sb = await admin.createSandbox({ name: 'sdk-tls' });
out.state = sb.row.state;
const box = harness.sandbox(sb.id);
out.exec = await box.exec({ argv: ['sh', '-c', 'echo over-tls'] });
const { sessionId } = await box.startSession({
  argv: ['sh', '-c', 'read line; echo "got:$line"'],
  name: 'sdk-tls-echo',
});
const stream = box.attach(sessionId);
stream.input('ping\\n');
const events = [];
for await (const evt of stream) events.push(evt);
out.output = events
  .filter((e) => e.type === 'session.output')
  .map((e) => Buffer.from(e.params.data, 'base64').toString())
  .join('');
out.last = events.at(-1);
console.log(JSON.stringify(out));
`;

const UNTRUSTED = `
import { WorkboxClient } from ${JSON.stringify(SDK)};
try {
  await new WorkboxClient({ baseUrl: process.env.WB_BASE, retries: 0 }).health();
  console.log(JSON.stringify({ ok: true }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, code: e.code, status: e.status, message: e.message }));
}
`;

test('the sdk drives an HTTPS server and streams a session over WSS, trusting a private CA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sdk-tls-'));
  const cert = selfSigned(dir, 'sdk-tls');
  const srv = await bootServer({ server: { tls: { cert: cert.cert, key: cert.key } } });
  try {
    assert.match(srv.base, /^https:\/\//);
    const env = { WB_BASE: srv.base, WB_ADMIN: TOKENS.admin, WB_EXEC: TOKENS.exec };
    const run = await runNode(CLIENT, { ...env, NODE_EXTRA_CA_CERTS: cert.certFile });
    assert.equal(run.code, 0, run.stderr);
    const out = JSON.parse(run.stdout.trim().split('\n').at(-1));
    assert.deepEqual(out.health, { ok: true });
    assert.equal(out.state, 'READY');
    assert.equal(out.exec.stdout, 'over-tls\n');
    assert.equal(out.exec.exitCode, 0);
    assert.equal(out.output, 'got:ping\n');
    assert.equal(out.last.type, 'session.exit');
    assert.equal(out.last.params.code, 0);

    const untrusted = await runNode(UNTRUSTED, env);
    assert.equal(untrusted.code, 0, untrusted.stderr);
    const refused = JSON.parse(untrusted.stdout.trim().split('\n').at(-1));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'E_UNAVAILABLE');
    assert.equal(refused.status, 0);
    assert.match(refused.message, /self-signed|certificate/i);
  } finally {
    await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
