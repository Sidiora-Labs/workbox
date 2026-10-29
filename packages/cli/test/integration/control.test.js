import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { main } from '../../src/main.js';

function capture() {
  const chunks = [];
  return {
    stream: { write: (d) => chunks.push(Buffer.from(d)) },
    text: () => Buffer.concat(chunks).toString(),
  };
}

/**
 * The background session and copy commands, run through `main` against the real engine both
 * ways: as the local engine and through `--server` to the real server over that engine.
 */
test(
  'run, logs, wait, kill and cp, locally and through --server',
  { timeout: 300_000 },
  async (t) => {
    const srv = await bootServer();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-control-'));
    const engine = { manager: srv.manager, store: srv.eng.store, config: srv.eng.config };
    try {
      const { version: runtime } = await srv.eng.runtime.ensureFresh();
      const box = await srv.manager.create({ name: 'cli-control', runtime });
      const modes = {
        local: { deps: { engine }, flags: [] },
        remote: { deps: {}, flags: ['--server', srv.base, '--token', TOKENS.exec] },
      };
      for (const [mode, { deps, flags }] of Object.entries(modes)) {
        const cli = async (...argv) => {
          const out = capture();
          const err = capture();
          const code = await main([argv[0], ...flags, ...argv.slice(1)], {
            ...deps,
            out: out.stream,
            err: err.stream,
          });
          return { code, out: out.text(), err: err.text() };
        };
        const json = (r) => JSON.parse(r.out);

        await t.test(`${mode}: run --wait prints the output and exits with the code`, async () => {
          const r = await cli(
            'sandbox',
            'run',
            box.id,
            '--wait',
            '--',
            'sh',
            '-c',
            'echo hi; echo oops >&2; exit 4',
          );
          assert.equal(r.code, 4, r.err);
          assert.equal(r.out, 'hi\n');
          assert.equal(r.err, 'oops\n');
        });

        await t.test(`${mode}: run in the background, then wait and read its logs`, async () => {
          const started = await cli(
            'sandbox',
            'run',
            box.id,
            '--name',
            `bg-${mode}`,
            '--',
            'sh',
            '-c',
            'sleep 0.2; echo done',
          );
          assert.equal(started.code, 0, started.err);
          const { sessionId } = json(started);
          assert.ok(sessionId);
          const waited = await cli('sandbox', 'wait', box.id, sessionId, '--timeout', '30000');
          assert.equal(waited.code, 0, waited.err);
          assert.equal(json(waited).exited.code, 0);
          const logs = await cli('sandbox', 'logs', box.id, sessionId);
          assert.equal(logs.code, 0, logs.err);
          assert.equal(logs.out, 'done\n');
        });

        await t.test(`${mode}: a wait times out, a kill ends the session`, async () => {
          const { sessionId } = json(await cli('sandbox', 'run', box.id, '--', 'sleep', '600'));
          const early = await cli('sandbox', 'wait', box.id, sessionId, '--timeout', '200');
          assert.equal(early.code, 5, 'E_TIMEOUT');
          assert.match(early.err, /still running after 200 ms \(E_TIMEOUT\)/);
          const killed = await cli('sandbox', 'kill', box.id, sessionId, '--signal', 'KILL');
          assert.equal(killed.code, 0, killed.err);
          assert.deepEqual(json(killed), { sessionId, signal: 'SIGKILL' });
          const waited = await cli('sandbox', 'wait', box.id, sessionId);
          assert.equal(waited.code, 137, 'a signalled session exits 128 + its number');
          assert.equal(json(waited).exited.signal, 'SIGKILL');
          const missing = await cli('sandbox', 'logs', box.id, 'se-missing');
          assert.equal(missing.code, 3);
        });

        await t.test(`${mode}: cp copies a multi-chunk file in and out`, async () => {
          const bytes = randomBytes(9 * 1024 * 1024 + 3);
          const src = path.join(dir, `${mode}-src.bin`);
          fs.writeFileSync(src, bytes, { mode: 0o640 });
          const up = await cli('sandbox', 'cp', src, `${box.id}:/tmp/`);
          assert.equal(up.code, 0, up.err);
          assert.deepEqual(json(up), {
            from: src,
            to: `${box.id}:/tmp/${mode}-src.bin`,
            bytes: bytes.length,
          });
          const st = await srv.manager.request(box.id, 'fs.stat', { path: `/tmp/${mode}-src.bin` });
          assert.equal(st.size, bytes.length);
          assert.equal(st.mode, 0o640, 'the permission bits came along');
          const down = await cli('sandbox', 'cp', `${box.id}:/tmp/${mode}-src.bin`, dir);
          assert.equal(down.code, 0, down.err);
          const dest = path.join(dir, `${mode}-src.bin`);
          assert.equal(json(down).to, dest);
          assert.ok(fs.readFileSync(dest).equals(bytes));
          const named = path.join(dir, `${mode}-named.bin`);
          assert.equal(
            (await cli('sandbox', 'cp', `${box.id}:/tmp/${mode}-src.bin`, named)).code,
            0,
          );
          assert.ok(fs.readFileSync(named).equals(bytes));
          const nope = await cli('sandbox', 'cp', `${box.id}:/tmp/none`, path.join(dir, 'none'));
          assert.equal(nope.code, 3);
          assert.equal(fs.existsSync(path.join(dir, 'none')), false);
        });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await srv.stop();
    }
  },
);
