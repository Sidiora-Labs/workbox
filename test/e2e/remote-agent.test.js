import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig, Manager } from '../../packages/core/src/index.js';
import { testEngine } from '../../packages/core/test/helpers/engine.js';
import { receiver, until } from '../../packages/core/test/helpers/receiver.js';
import { rawUpgrade } from '../../packages/server/test/helpers/real-server.js';
import { serveCommand } from '../../packages/cli/src/serve.js';
import { WorkboxClient, WorkboxApiError, verifyWebhook } from '../../packages/sdk/src/index.js';

/**
 * An outside agent driving Workbox with nothing but the server's URL and one stored key. The
 * server is `serveCommand`, the function behind `workbox serve`, over a real engine and Manager,
 * so the webhook dispatcher runs exactly as it does there; the engine configuration allows
 * webhooks to plain HTTP on this host so the receiver can listen on 127.0.0.1. The operator mints
 * a key bound to one label; the agent uploads a project, builds it as a background session and
 * learns of the exit by long-poll, event WebSocket and a signed webhook, then reads the output,
 * the result file and the artifact the build stored. A sandbox without the label, the fleet routes
 * and the operator's webhook stay out of the key's reach, and revoking the key cuts it off.
 */

const OPERATOR_TOKEN = `operator-${process.pid}-${Date.now().toString(36)}`;
const PROJECT = '/workspace/project';

const BUILD_SH = `#!/bin/sh
set -eu
cd "$(dirname "$0")"
sleep 1
if [ "\${1:-}" = broken ]; then
  echo 'build.sh: src/missing.txt: no such file' >&2
  exit 3
fi
echo "building $(cat src/greeting.txt)"
mkdir -p out
tr a-z A-Z < src/greeting.txt > out/result.txt
wb artifact put --json out/result.txt
echo 'build ok'
`;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const parsed = (hit) => JSON.parse(hit.body);
const refused = (status, code) => (e) =>
  e instanceof WorkboxApiError && e.status === status && e.code === code;
const streamText = (out, stream) =>
  out.chunks
    .filter((c) => c.stream === stream)
    .map((c) => c.data)
    .join('');

/**
 * A real engine whose configuration file turns on `webhooks.allowPrivate` and
 * `webhooks.allowHttp`, a Manager over it (network setup off, as in the other e2e tests) and
 * `serveCommand` listening on an ephemeral 127.0.0.1 port with WORKBOX_TOKEN as the operator key.
 */
async function boot() {
  const eng = await testEngine({ cgroupParent: `workbox-e2e-remote-${process.pid}` });
  const file = path.join(eng.dir, 'workbox.json');
  fs.writeFileSync(file, JSON.stringify({ webhooks: { allowPrivate: true, allowHttp: true } }));
  const config = loadConfig({
    file,
    env: {
      WORKBOX_ROOT: eng.dir,
      WORKBOX_CGROUP_PARENT: eng.config.cgroup.parent,
      WORKBOX_NETWORK_MODE: 'none',
    },
  });
  const manager = new Manager({
    config,
    store: eng.store,
    audit: eng.audit,
    cgroups: eng.cgroups,
    rootfs: eng.rootfs,
    runtime: eng.runtime,
    logger: eng.logger,
    enableNetwork: false,
  });
  const ids = new Set();
  manager.on('sandbox', (row) => ids.add(row.id));
  let said = '';
  let announce;
  const listening = new Promise((resolve) => {
    announce = resolve;
  });
  const out = {
    write(chunk) {
      said += chunk;
      const m = /listening on (http:\/\/127\.0\.0\.1:(\d+))\n/.exec(said);
      if (m) announce({ base: m[1], port: Number(m[2]) });
      return true;
    },
  };
  const err = { write: (chunk) => process.stderr.write(chunk) };
  const engine = { config, store: eng.store, audit: eng.audit, logger: eng.logger, manager };
  const stopping = new AbortController();
  const served = serveCommand({ engine, out, err }, ['--host', '127.0.0.1', '--port', '0'], {
    env: { WORKBOX_TOKEN: OPERATOR_TOKEN },
    signal: stopping.signal,
  });
  const ended = served.then(() => {
    throw new Error(`workbox serve ended before it listened: ${said}`);
  });
  let addr;
  try {
    addr = await Promise.race([listening, ended]);
  } catch (e) {
    manager.close();
    await eng.cleanup();
    throw e;
  }
  ended.catch(() => undefined);
  return {
    ...addr,
    async stop() {
      stopping.abort();
      await served;
      for (const id of ids) await manager.destroy(id).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    },
  };
}

test(
  'an outside agent with one bound key builds in a sandbox and is told when it finishes',
  { timeout: 300_000 },
  async (t) => {
    const srv = await boot();
    const r = await receiver([{ status: 204 }]);
    const hookUrl = (name) => `http://127.0.0.1:${r.port}/${name}`;
    const operator = new WorkboxClient({ baseUrl: srv.base, token: OPERATOR_TOKEN });
    const owner = `dots-${process.pid}-${Date.now().toString(36)}`;
    const stream = { events: [], error: null, handle: null, pump: null };
    try {
      const key = await operator.createKey({
        name: 'dots',
        scopes: ['read', 'exec', 'admin'],
        labels: { owner },
        ttlSeconds: 3600,
      });
      const agent = new WorkboxClient({ baseUrl: srv.base, token: key.token });
      const opBox = await operator.createSandbox({ name: 'operator-only' });
      const opHook = await operator.createWebhook({
        url: hookUrl('operator'),
        types: ['session.exited'],
        labels: { owner },
        description: 'operator view of the agent sandboxes',
      });
      let box;
      let agentHook;
      let cursor;

      await t.test('the operator mints a bound key with a lifetime', async () => {
        assert.match(key.token, /^wbk_[A-Za-z0-9_-]{43}$/);
        assert.deepEqual(key.scopes, ['read', 'exec', 'admin']);
        assert.deepEqual(key.binding, { labels: { owner } });
        assert.equal(key.expiresAt - key.createdAt, 3600 * 1000);
        const listed = (await operator.listKeys()).keys.find((k) => k.id === key.id);
        assert.equal(listed.name, 'dots');
        assert.equal(JSON.stringify(listed).includes(key.token), false, 'no token in listings');
      });

      await t.test('the agent sees its binding and creates a sandbox carrying it', async () => {
        const api = await new WorkboxClient({ baseUrl: srv.base }).openapi();
        assert.equal(api.openapi, '3.1.0');
        for (const route of ['/v1/whoami', '/v1/sandboxes/{id}/files/raw', '/v1/events'])
          assert.ok(api.paths[route], route);
        assert.deepEqual(await agent.whoami(), {
          id: key.id,
          scopes: ['read', 'exec', 'admin'],
          binding: { labels: { owner } },
          source: 'store',
          expiresAt: key.expiresAt,
        });
        await assert.rejects(
          agent.createSandbox({ name: 'elsewhere', labels: { owner: 'someone-else' } }),
          refused(403, 'E_DENIED'),
        );
        box = await agent.createSandbox({ name: 'dots-build' });
        assert.equal(box.row.state, 'READY');
        assert.deepEqual(box.row.labels, { owner });
        assert.deepEqual(
          (await agent.listSandboxes()).items.map((s) => s.id),
          [box.id],
        );
      });

      await t.test('the agent uploads a project and registers a webhook', async () => {
        const script = await box.upload(`${PROJECT}/build.sh`, BUILD_SH, {
          mkdirs: true,
          mode: 0o755,
        });
        assert.deepEqual(script, {
          path: `${PROJECT}/build.sh`,
          bytes: Buffer.byteLength(BUILD_SH),
        });
        await box.upload(`${PROJECT}/src/greeting.txt`, 'hello from dots\n', { mkdirs: true });
        const listed = await box.listFiles(PROJECT);
        assert.deepEqual(listed.entries.map((e) => e.name).sort(), ['build.sh', 'src']);

        agentHook = await agent.createWebhook({ url: hookUrl('agent'), types: ['session.*'] });
        assert.match(agentHook.secret, /^whsec_/);
        assert.deepEqual(
          [agentHook.ownerKey, agentHook.binding, agentHook.types],
          [key.id, { labels: { owner } }, ['session.*']],
        );
      });

      /**
       * Start `build.sh` with `args` as a background session and check that the long-poll, the
       * event WebSocket and the webhook each report its exit with `code`.
       */
      const build = async (args, code) => {
        let settled = false;
        const polled = agent
          .listEvents({ afterSeq: cursor, types: ['session.exited'], waitMs: 30_000 })
          .finally(() => {
            settled = true;
          });
        const started = await box.startSession({
          argv: ['sh', 'build.sh', ...args],
          cwd: PROJECT,
          name: 'build',
        });
        const { sessionId } = started;
        assert.equal(settled, false, 'the long-poll waits while the build runs');

        const page = await polled;
        assert.equal(page.events.length, 1, JSON.stringify(page));
        const [exit] = page.events;
        assert.deepEqual(
          [exit.type, exit.sandboxId, exit.payload.sessionId, exit.payload.code],
          ['session.exited', box.id, sessionId, code],
        );
        assert.equal(page.nextSeq, exit.seq);
        cursor = page.nextSeq;

        const waited = await box.session(sessionId).wait({ timeoutMs: 60_000 });
        assert.equal(waited.exited.code, code);

        const streamed = await until(
          () => stream.error ?? stream.events.find((e) => e.payload.sessionId === sessionId),
          15_000,
          'the exit on the event WebSocket',
        );
        if (stream.error) throw stream.error;
        assert.equal(streamed.seq, exit.seq);

        const hit = await until(
          () =>
            r
              .at('/agent')
              .find(
                (h) =>
                  parsed(h).type === 'session.exited' &&
                  parsed(h).data.payload.sessionId === sessionId,
              ),
          20_000,
          'the session.exited webhook delivery',
        );
        const delivered = verifyWebhook(agentHook.secret, hit.headers, hit.body);
        assert.equal(delivered.type, 'session.exited');
        assert.deepEqual(delivered.data, exit);
        assert.equal(delivered.data.payload.code, code);
        return sessionId;
      };

      await t.test('a build reports its exit by long-poll, WebSocket and webhook', async () => {
        cursor = (await agent.listEvents({ limit: 1000 })).nextSeq;
        stream.handle = agent.events({ afterSeq: cursor, types: ['session.exited'] });
        stream.pump = (async () => {
          try {
            for await (const event of stream.handle) stream.events.push(event);
          } catch (e) {
            stream.error = e;
          }
        })();

        const sessionId = await build([], 0);
        const out = await box.session(sessionId).output({ encoding: 'text' });
        assert.equal(out.exited.code, 0);
        assert.equal(out.truncated, false);
        const stdout = streamText(out, 'stdout');
        assert.match(stdout, /^building hello from dots\n/);
        assert.match(stdout, /\nbuild ok\n$/);
        const put = JSON.parse(stdout.split('\n').find((l) => l.startsWith('{')));

        const result = await box.download(`${PROJECT}/out/result.txt`);
        assert.equal(result.toString(), 'HELLO FROM DOTS\n');
        assert.deepEqual(put, { sha256: sha256(result), size: result.length });
        const { items } = await box.listArtifacts();
        const ref = items.find((a) => a.name === 'result.txt');
        assert.equal(ref?.sha256, put.sha256, JSON.stringify(items));
        assert.deepEqual(await box.downloadArtifact(put.sha256), result);

        const hits = r.at('/agent').map(parsed);
        const types = hits.filter((p) => p.data.payload.sessionId === sessionId).map((p) => p.type);
        assert.ok(types.includes('session.started'), JSON.stringify(types));
      });

      await t.test('a failing build is reported with its exit code the same way', async () => {
        const sessionId = await build(['broken'], 3);
        const out = await box.session(sessionId).output({ encoding: 'text' });
        assert.equal(out.exited.code, 3);
        assert.equal(streamText(out, 'stderr'), 'build.sh: src/missing.txt: no such file\n');
        assert.equal(streamText(out, 'stdout'), '');
      });

      await t.test('the agent cannot reach what its key does not cover', async () => {
        const hidden = agent.sandbox(opBox.id);
        const notFound = refused(404, 'E_NOT_FOUND');
        await assert.rejects(hidden.inspect(), notFound);
        await assert.rejects(hidden.exec({ argv: ['true'] }), notFound);
        await assert.rejects(hidden.readFile('/etc/hostname'), notFound);
        await assert.rejects(hidden.download('/etc/hostname'), notFound);
        await assert.rejects(hidden.upload('/workspace/x', 'x'), notFound);
        await assert.rejects(hidden.listEvents(), notFound);
        const follow = hidden.events({ follow: true })[Symbol.asyncIterator]();
        await assert.rejects(follow.next(), notFound);
        const auth = { Authorization: `Bearer ${key.token}` };
        assert.match(
          await rawUpgrade(srv.port, `/v1/sandboxes/${opBox.id}/events/ws`, auth),
          /^HTTP\/1\.1 404 /,
        );
        assert.match(
          await rawUpgrade(srv.port, `/v1/sandboxes/${opBox.id}/sessions/s/ws`, auth),
          /^HTTP\/1\.1 404 /,
        );
        assert.match(
          await rawUpgrade(srv.port, `/v1/sandboxes/${box.id}/events/ws`, auth),
          /^HTTP\/1\.1 101 /,
        );
        const seen = await agent.listEvents({ limit: 1000 });
        assert.ok(seen.events.length > 0);
        assert.ok(seen.events.every((e) => e.sandboxId === box.id));

        const denied = refused(403, 'E_DENIED');
        await assert.rejects(agent.metrics(), denied);
        await assert.rejects(agent.reconcile(), denied);
        await assert.rejects(agent.listKeys(), denied);
        await assert.rejects(agent.createKey({ name: 'more', scopes: ['admin'] }), denied);

        assert.deepEqual(
          (await agent.listWebhooks()).webhooks.map((w) => w.id),
          [agentHook.id],
        );
        await assert.rejects(agent.getWebhook(opHook.id), notFound);
        await assert.rejects(agent.listWebhookDeliveries(opHook.id), notFound);
        await assert.rejects(agent.deleteWebhook(opHook.id), notFound);
        const all = (await operator.listWebhooks()).webhooks.map((w) => w.id);
        assert.deepEqual(all.sort(), [agentHook.id, opHook.id].sort());
      });

      await t.test('revoking the key cuts the agent and its webhook off', async () => {
        stream.handle.close();
        await stream.pump;
        assert.equal(stream.error, null);
        assert.deepEqual(
          stream.events.map((e) => e.payload.code),
          [0, 3],
        );

        const revoked = await operator.revokeKey(key.id);
        assert.equal(typeof revoked.revokedAt, 'number');
        await assert.rejects(agent.whoami(), refused(401, 'E_DENIED'));
        await assert.rejects(agent.listSandboxes(), refused(401, 'E_DENIED'));

        const { sessionId } = await operator
          .sandbox(box.id)
          .startSession({ argv: ['true'], name: 'after-revoke' });
        const seen = await until(
          () => r.at('/operator').find((h) => parsed(h).data.payload.sessionId === sessionId),
          20_000,
          'the operator webhook delivery',
        );
        verifyWebhook(opHook.secret, seen.headers, seen.body);
        await delay(1000);
        const late = r.at('/agent').filter((h) => parsed(h).data.payload.sessionId === sessionId);
        assert.deepEqual(late, [], 'no delivery to the revoked key webhook');
        const { items } = await operator.listWebhookDeliveries(agentHook.id, { limit: 100 });
        assert.equal(
          items.some((d) => d.event.payload?.sessionId === sessionId && d.status === 'delivered'),
          false,
        );
      });

      await t.test('the operator destroys every sandbox', async () => {
        for (const id of [box.id, opBox.id])
          assert.equal((await operator.sandbox(id).destroy()).state, 'DELETED');
        assert.deepEqual((await operator.listSandboxes()).items, []);
      });
    } finally {
      stream.handle?.close();
      await stream.pump;
      await srv.stop();
      await r.close();
    }
  },
);
