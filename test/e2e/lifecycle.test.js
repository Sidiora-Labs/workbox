import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkboxClient } from '../../packages/sdk/src/index.js';
import { bootServer, TOKENS } from '../../packages/server/test/helpers/real-server.js';

/**
 * End-to-end through the public surfaces: SDK -> HTTP server -> Manager -> real sandboxes, plus
 * the req 7.5 density measurement shape (20 concurrent creates; p50/p95 + process RSS recorded
 * to docs/measurements.md).
 */

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

test('sdk lifecycle against a real engine: create, exec, checkpoints, destroy; 20-way density', async () => {
  const srv = await bootServer();
  const client = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.admin });
  try {
    const sb = await client.createSandbox({ name: 'e2e' });
    const out = await sb.exec({ argv: ['echo', 'e2e'] });
    assert.equal(out.stdout, 'e2e\n');
    assert.equal(out.exitCode, 0);
    assert.deepEqual((await sb.listCheckpoints()).checkpoints, []);
    assert.equal((await sb.destroy()).state, 'DELETED');

    const durations = [];
    await Promise.all(
      Array.from({ length: 20 }, async (_v, i) => {
        const t0 = Date.now();
        const s = await client.createSandbox({ name: `density-${i}` });
        durations.push(Date.now() - t0);
        assert.equal(s.row.state, 'READY');
      }),
    );
    const live = await client.listSandboxes({ limit: 100 });
    assert.equal(live.items.length, 20);
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    await Promise.all(live.items.map((s) => client.sandbox(s.id).destroy()));
    assert.deepEqual((await client.listSandboxes()).items, []);
    durations.sort((a, b) => a - b);
    const body = `# Measurements

Recorded by test/e2e/lifecycle.test.js on ${new Date().toISOString()} against the real engine (SDK -> server -> Manager -> sandboxes, network setup off).

| Metric | Value |
|---|---|
| Concurrent creates | 20 |
| create-to-ready p50 | ${percentile(durations, 50)} ms |
| create-to-ready p95 | ${percentile(durations, 95)} ms |
| Server process RSS at measurement | ${rssMb} MiB |

Thresholds are an owner decision (spec req 7.5 records values only).
`;
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'measurements.md'), body);
    assert.ok(fs.existsSync(path.join(docsDir, 'measurements.md')));
  } finally {
    await srv.stop();
  }
});
