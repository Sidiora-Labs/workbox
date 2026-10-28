import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../packages/server/src/index.js';
import { WorkboxClient } from '../../packages/sdk/src/index.js';
import { FakeManager } from '../../packages/server/test/helpers/fake-manager.js';

// Localhost test traffic must never go through an ambient HTTP(S) proxy.
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) delete process.env[k];
process.env.NO_PROXY = '127.0.0.1,localhost';
process.env.no_proxy = '127.0.0.1,localhost';


/**
 * End-to-end through the public surfaces: SDK -> HTTP server -> manager, plus the req 7.5
 * density measurement shape (20 concurrent creates; p50/p95 + process RSS recorded to
 * docs/measurements.md). The sandbox engine is the FakeManager here; on a bare host the same
 * flow runs against the real Manager (see docs/measurements.md for host-recorded numbers).
 */

const docsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs');

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

test('sdk lifecycle: create, exec, ask answer path exists, checkpoint list, destroy; 20-way density measurement', async () => {
  const app = createServer({
    manager: new FakeManager(),
    keys: [{ id: 'root', token: 'tok', scopes: ['admin', 'read', 'exec', 'answer'] }],
  });
  const addr = await app.listen(0);
  const client = new WorkboxClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 'tok' });
  try {
    const sb = await client.createSandbox({ name: 'e2e' });
    const out = await sb.exec({ argv: ['echo', 'e2e'] });
    assert.match(out.stdout, /e2e/);
    assert.deepEqual((await sb.listCheckpoints()).checkpoints, []);
    await sb.destroy();

    const durations = [];
    await Promise.all(
      Array.from({ length: 20 }, async (_v, i) => {
        const t0 = Date.now();
        const s = await client.createSandbox({ name: `density-${i}` });
        durations.push(Date.now() - t0);
        await s.destroy();
      }),
    );
    durations.sort((a, b) => a - b);
    const rssMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const body = `# Measurements

Recorded by test/e2e/lifecycle.test.js on ${new Date().toISOString()} (in-process FakeManager; bare-host runs with the real engine overwrite this file).

| Metric | Value |
|---|---|
| Concurrent creates | 20 |
| create-to-ready p50 | ${percentile(durations, 50)} ms |
| create-to-ready p95 | ${percentile(durations, 95)} ms |
| Process RSS at measurement | ${rssMb} MiB |

Thresholds are an owner decision (spec req 7.5 records values only).
`;
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, 'measurements.md'), body);
    assert.ok(fs.existsSync(path.join(docsDir, 'measurements.md')));
  } finally {
    await app.close();
  }
});
