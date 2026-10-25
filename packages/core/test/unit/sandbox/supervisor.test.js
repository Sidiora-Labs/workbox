import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import {
  evaluateChecks,
  connectWithRetry,
  DEFAULT_HEALTH_INTERVAL_MS,
} from '../../../src/sandbox/supervisor.js';
import { CAPABILITY_MASK } from '../../../src/host/launch.js';
import { tmpDir } from '../../helpers/tmp.js';

const uid = { base: 200000, count: 65536 };
const good = () => ({
  ok: true,
  problems: [],
  pid: 2,
  caps: { eff: CAPABILITY_MASK, bnd: CAPABILITY_MASK },
  noNewPrivs: true,
  mountDenied: true,
  uidMap: [{ inner: 0, outer: 200000, count: 65536 }],
  gidMap: [{ inner: 0, outer: 200000, count: 65536 }],
});

test('evaluateChecks accepts the exact profile and names every deviation', () => {
  assert.deepEqual(evaluateChecks(good(), { uid }), { ok: true, problems: [] });
  assert.deepEqual(evaluateChecks(null, { uid }), {
    ok: false,
    problems: ['runner returned no checks'],
  });
  const bad = good();
  bad.caps.eff = '000001ffffffffff';
  bad.caps.bnd = '000001ffffffffff';
  bad.noNewPrivs = false;
  bad.mountDenied = false;
  bad.pid = 1;
  bad.uidMap = [{ inner: 0, outer: 0, count: 4294967295 }];
  bad.gidMap = [];
  bad.problems = ['from runner', 'from runner'];
  const r = evaluateChecks(bad, { uid });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [
    'from runner',
    'effective capabilities 000001ffffffffff != 00000000a80425fb',
    'bounding capabilities 000001ffffffffff != 00000000a80425fb',
    'no_new_privs not set',
    'uid map [{"inner":0,"outer":0,"count":4294967295}] != [0 200000 65536]',
    'gid map [] != [0 200000 65536]',
    'mount(2) not denied inside the sandbox',
    'runner pid 1 != 2',
  ]);
  const wrongBase = good();
  wrongBase.uidMap[0].outer = 300000;
  assert.equal(evaluateChecks(wrongBase, { uid }).problems.length, 1);
  assert.equal(DEFAULT_HEALTH_INTERVAL_MS, 2000);
});

test('connectWithRetry waits for a late socket, aborts when the process is gone, and times out', async () => {
  const { dir, cleanup } = tmpDir();
  try {
    const sock = path.join(dir, 's.sock');
    const server = net.createServer();
    setTimeout(() => server.listen(sock), 150);
    const t0 = Date.now();
    const conn = await connectWithRetry(sock, { timeoutMs: 5000, pollMs: 20 });
    assert.ok(Date.now() - t0 >= 100);
    conn.destroy();
    server.close();
    await once(server, 'close');
    await assert.rejects(
      connectWithRetry(path.join(dir, 'never.sock'), { timeoutMs: 100, pollMs: 10 }),
      (e) => e.code === 'E_TIMEOUT',
    );
    let alive = true;
    setTimeout(() => (alive = false), 50);
    await assert.rejects(
      connectWithRetry(path.join(dir, 'never.sock'), {
        timeoutMs: 5000,
        pollMs: 10,
        alive: () => alive,
      }),
      (e) => e.code === 'E_UNAVAILABLE',
    );
    fs.writeFileSync(sock, 'stale');
    await assert.rejects(
      connectWithRetry(sock, { timeoutMs: 120, pollMs: 10 }),
      (e) => e.code === 'E_TIMEOUT' && /ECONNREFUSED|ENOTSOCK/.test(e.message),
    );
  } finally {
    cleanup();
  }
});
