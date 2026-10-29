import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, WebhookDispatcher } from '../../../core/src/index.js';
import { Manager } from '../../../core/src/sandbox/manager.js';
import { testEngine } from '../../../core/test/helpers/engine.js';
import { receiver, until } from '../../../core/test/helpers/receiver.js';
import { createServer, SCOPE_MATRIX } from '../../../server/src/index.js';
import { KEYS, TOKENS, auditEntries } from '../../../server/test/helpers/real-server.js';
import { WorkboxClient, WorkboxApiError, verifyWebhook } from '../../src/index.js';

/** Route templates with at least one 2xx in the server's `workbox_http_requests_total`. */
function okRoutes(metrics) {
  const re =
    /^workbox_http_requests_total\{method="[A-Z]+",route="([^"]+)",status="2\d\d"\} \d+$/gm;
  return new Set([...metrics.matchAll(re)].map((m) => m[1]));
}

const quiet = () => createLogger({ component: 'server', level: 'silent', stream: { write() {} } });

/**
 * A real engine and Manager, a webhook dispatcher that may deliver to this host over plain HTTP
 * (the receivers below listen on 127.0.0.1), and the server, wired the way `workbox serve` wires
 * them.
 */
async function boot() {
  const eng = await testEngine();
  const manager = new Manager({
    config: eng.config,
    store: eng.store,
    audit: eng.audit,
    cgroups: eng.cgroups,
    rootfs: eng.rootfs,
    runtime: eng.runtime,
    logger: eng.logger,
    enableNetwork: false,
  });
  const dispatcher = new WebhookDispatcher({
    store: eng.store,
    config: { allowPrivate: true, allowHttp: true, timeoutMs: 3000, retryDelaysMs: [200, 200] },
    pollMs: 100,
  });
  manager.on('logged', () => dispatcher.notify());
  const logs = [];
  const logger = createLogger({ component: 'server', stream: { write: (l) => logs.push(l) } });
  const app = createServer({ manager, keys: KEYS, audit: eng.audit, logger, webhooks: dispatcher });
  const ids = new Set();
  manager.on('sandbox', (row) => ids.add(row.id));
  const { port } = await app.listen(0);
  dispatcher.start();
  return {
    eng,
    manager,
    dispatcher,
    logs,
    base: `http://127.0.0.1:${port}`,
    async stop() {
      await app.close({ timeoutMs: 2000 });
      await dispatcher.stop({ timeoutMs: 1000 });
      for (const id of ids) await manager.destroy(id).catch(() => undefined);
      manager.close();
      await eng.cleanup();
    },
  };
}

const parsed = (hit) => JSON.parse(hit.body);
const rejectsWith = (status, code) => (e) =>
  e instanceof WorkboxApiError && e.status === status && e.code === code;

test('webhooks deliver signed sandbox events through outages, filtered and owned', async (t) => {
  const srv = await boot();
  const store = srv.eng.store;
  const r = await receiver((hit) => {
    if (hit.url === '/flaky')
      return r.at('/flaky').length === 1 ? { status: 500, body: 'boom' } : { status: 200 };
    if (hit.url === '/gone') return { status: 410, body: 'gone' };
    return { status: 204 };
  });
  const rb = `http://127.0.0.1:${r.port}`;
  const admin = new WorkboxClient({ baseUrl: srv.base, token: TOKENS.admin, retryDelayMs: 5 });
  /** Every delivery done: each webhook has queued up to the newest event and none is pending. */
  const settled = () =>
    until(() => {
      const top = store.db.prepare('SELECT COALESCE(MAX(seq), 0) AS top FROM events').get().top;
      const caughtUp = store.listActiveWebhooks().every((w) => w.lastSeq >= top);
      return caughtUp && store.nextWebhookDeliveryAt() === null && srv.dispatcher.busy === 0;
    }, 15_000);
  const secrets = [];
  try {
    const [sa, sb] = await Promise.all([
      admin.createSandbox({ name: 'wh-a', labels: { team: 'a' } }),
      admin.createSandbox({ name: 'wh-b', labels: { team: 'b' } }),
    ]);
    const exits = await admin.createWebhook({
      url: `${rb}/exits`,
      types: ['session.exited'],
      sandboxId: sa.id,
      description: 'build results',
    });
    const all = await admin.createWebhook({ url: `${rb}/all` });
    const execs = await admin.createWebhook({
      url: `${rb}/execs`,
      types: ['exec.*'],
      labels: { team: 'b' },
    });
    secrets.push(exits.secret, all.secret, execs.secret);

    await t.test('a session exit produces a signed delivery the SDK verifies', async () => {
      assert.match(exits.id, /^wh_/);
      assert.match(exits.secret, /^whsec_[A-Za-z0-9+/]{32}$/);
      assert.deepEqual(
        [exits.types, exits.sandboxId, exits.ownerKey, exits.binding, exits.enabled],
        [['session.exited'], sa.id, 'root', null, true],
      );
      const shown = await admin.getWebhook(exits.id);
      assert.equal('secret' in shown, false, 'the secret is shown only at creation');
      assert.equal(JSON.stringify(await admin.listWebhooks()).includes(exits.secret), false);

      const { sessionId } = await sa.startSession({ argv: ['sh', '-c', 'exit 3'] });
      const hit = await until(
        () => r.at('/exits').find((h) => parsed(h).data.payload.sessionId === sessionId),
        15_000,
        'the session.exited delivery',
      );
      const payload = verifyWebhook(exits.secret, hit.headers, hit.body);
      assert.equal(payload.type, 'session.exited');
      assert.equal(payload.timestamp, new Date(payload.data.at).toISOString());
      assert.equal(payload.data.sandboxId, sa.id);
      assert.equal(payload.data.source, 'host');
      assert.equal(typeof payload.data.seq, 'number');
      assert.deepEqual([payload.data.payload.sessionId, payload.data.payload.code], [sessionId, 3]);
      assert.deepEqual(payload.data, store.getEvent(payload.data.seq));
      assert.match(hit.headers['webhook-id'], /^msg_/);
      assert.equal(hit.headers['content-type'], 'application/json');
      assert.match(hit.headers['user-agent'], /^Workbox-Webhooks\//);
      assert.throws(
        () => verifyWebhook(exits.secret, hit.headers, hit.body.replace('3', '0')),
        (e) => e.code === 'E_WEBHOOK_INVALID',
      );
      assert.throws(
        () => verifyWebhook(all.secret, hit.headers, hit.body),
        (e) => e.code === 'E_WEBHOOK_INVALID',
        'another webhook secret does not verify it',
      );
    });

    await t.test('types, sandboxId and labels choose the events a webhook gets', async () => {
      await sa.exec({ argv: ['true'] });
      await sb.exec({ argv: ['true'] });
      await sb.startSession({ argv: ['true'] });
      await until(
        () =>
          r
            .at('/all')
            .map(parsed)
            .some((p) => p.type === 'session.exited' && p.data.sandboxId === sb.id),
        15_000,
        'b session exit',
      );
      await settled();
      const exitHits = r.at('/exits').map(parsed);
      assert.ok(exitHits.length >= 1);
      assert.deepEqual(
        new Set(exitHits.map((p) => `${p.type} ${p.data.sandboxId}`)),
        new Set([`session.exited ${sa.id}`]),
      );
      const execHits = r.at('/execs').map(parsed);
      assert.deepEqual(
        execHits.map((p) => [p.type, p.data.sandboxId]),
        [['exec.finished', sb.id]],
      );
      const allHits = r.at('/all').map(parsed);
      const types = new Set(allHits.map((p) => p.type));
      for (const type of ['session.started', 'session.exited', 'exec.finished'])
        assert.ok(types.has(type), type);
      assert.deepEqual(new Set(allHits.map((p) => p.data.sandboxId)), new Set([sa.id, sb.id]));
      const seqs = allHits.map((p) => p.data.seq);
      assert.equal(new Set(seqs).size, seqs.length, 'each event once');
      for (const hit of r.at('/all')) verifyWebhook(all.secret, hit.headers, hit.body);
    });

    await t.test('a receiver answering 500 then 200 gets the retry with the same id', async () => {
      const flaky = await admin.createWebhook({ url: `${rb}/flaky`, types: ['build.never'] });
      secrets.push(flaky.secret);
      const queued = await admin.testWebhook(flaky.id);
      assert.deepEqual(
        [queued.status, queued.eventSeq, queued.event.type],
        ['pending', null, 'webhook.test'],
      );
      await until(() => r.at('/flaky').length === 2, 10_000, 'the retry');
      const [first, second] = r.at('/flaky');
      assert.equal(first.headers['webhook-id'], queued.id);
      assert.equal(second.headers['webhook-id'], queued.id);
      assert.equal(first.body, second.body, 'the same payload');
      for (const hit of [first, second]) {
        const p = verifyWebhook(flaky.secret, hit.headers, hit.body);
        assert.deepEqual(
          [p.type, p.data.seq, p.data.payload],
          ['webhook.test', null, { webhookId: flaky.id }],
        );
      }
      const done = await until(async () => {
        const [d] = (await admin.listWebhookDeliveries(flaky.id)).items;
        return d.status === 'delivered' && d;
      });
      assert.deepEqual([done.attempts, done.lastStatus], [2, 200]);
    });

    await t.test('410 disables the webhook; enabling it clears the reason', async () => {
      const gone = await admin.createWebhook({ url: `${rb}/gone`, types: ['build.never'] });
      secrets.push(gone.secret);
      await admin.testWebhook(gone.id);
      const disabled = await until(async () => {
        const w = await admin.getWebhook(gone.id);
        return !w.enabled && w;
      });
      assert.match(disabled.disabledReason, /410/);
      const failed = await admin.listWebhookDeliveries(gone.id, { status: 'failed' });
      assert.deepEqual(
        failed.items.map((d) => [d.attempts, d.lastStatus, d.lastError]),
        [[1, 410, 'gone']],
      );
      assert.equal(r.at('/gone').length, 1, 'no retry after 410');
      const back = await admin.updateWebhook(gone.id, { enabled: true, description: 'again' });
      assert.deepEqual(
        [back.enabled, back.disabledReason, back.description],
        [true, null, 'again'],
      );
    });

    let late;
    await t.test(
      'events logged while the dispatcher is stopped are delivered after start',
      async () => {
        await srv.dispatcher.stop();
        late = await admin.createWebhook({
          url: `${rb}/late`,
          types: ['exec.finished'],
          sandboxId: sa.id,
        });
        secrets.push(late.secret);
        await sa.exec({ argv: ['sh', '-c', 'exit 4'] });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(r.at('/late').length, 0, 'nothing is sent while stopped');
        srv.dispatcher.start();
        await until(() => r.at('/late').length === 1, 10_000, 'the late delivery');
        const p = verifyWebhook(late.secret, r.at('/late')[0].headers, r.at('/late')[0].body);
        assert.deepEqual(
          [p.type, p.data.sandboxId, p.data.payload.exitCode],
          ['exec.finished', sa.id, 4],
        );
      },
    );

    await t.test('rotate, list, retry and delete through the SDK', async () => {
      const rotated = await admin.rotateWebhookSecret(exits.id);
      secrets.push(rotated.secret);
      assert.notEqual(rotated.secret, exits.secret);
      assert.equal(rotated.id, exits.id);
      const probe = await admin.testWebhook(exits.id);
      const ofProbe = () => r.at('/exits').filter((h) => h.headers['webhook-id'] === probe.id);
      await until(() => ofProbe().length === 1);
      const [hit] = ofProbe();
      assert.equal(verifyWebhook(rotated.secret, hit.headers, hit.body).type, 'webhook.test');
      assert.throws(
        () => verifyWebhook(exits.secret, hit.headers, hit.body),
        /no webhook-signature/,
      );
      await until(
        async () => (await admin.listWebhookDeliveries(exits.id)).items[0].status === 'delivered',
      );
      const everything = await admin.listWebhookDeliveries(exits.id, { limit: 100 });
      assert.equal(everything.complete, true);
      const first = await admin.listWebhookDeliveries(exits.id, { limit: 1 });
      assert.deepEqual([first.items.map((d) => d.id), first.complete], [[probe.id], false]);
      const rest = await admin.listWebhookDeliveries(exits.id, {
        limit: 100,
        cursor: first.cursor,
      });
      assert.equal(rest.complete, true);
      assert.deepEqual(
        rest.items.map((d) => d.id),
        everything.items.slice(1).map((d) => d.id),
      );
      assert.ok(rest.items.every((d) => d.event.type === 'session.exited'));
      const again = await admin.retryWebhookDelivery(exits.id, probe.id);
      assert.equal(again.status, 'pending');
      await until(() => ofProbe().length === 2, 10_000, 'the manual retry');
      assert.equal(ofProbe()[1].headers['webhook-id'], probe.id);
      await assert.rejects(
        admin.retryWebhookDelivery(exits.id, 'msg_none'),
        rejectsWith(404, 'E_NOT_FOUND'),
      );
      await assert.rejects(
        admin.listWebhookDeliveries(exits.id, { status: 'odd' }),
        rejectsWith(400, 'E_INVALID_PARAMS'),
      );
      const removed = await admin.deleteWebhook(late.id);
      assert.equal(removed.id, late.id);
      await assert.rejects(admin.getWebhook(late.id), rejectsWith(404, 'E_NOT_FOUND'));
    });

    await t.test(
      'a bound key gets only its sandboxes and cannot reach other webhooks',
      async () => {
        const minted = await admin.createKey({
          name: 'agent-a',
          scopes: ['admin'],
          labels: { team: 'a' },
        });
        const agent = new WorkboxClient({ baseUrl: srv.base, token: minted.token, retries: 0 });
        const mine = await agent.createWebhook({ url: `${rb}/agent` });
        secrets.push(mine.secret);
        assert.deepEqual([mine.ownerKey, mine.binding], [minted.id, { labels: { team: 'a' } }]);
        assert.deepEqual(
          (await agent.listWebhooks()).webhooks.map((w) => w.id),
          [mine.id],
        );
        assert.ok((await admin.listWebhooks()).webhooks.some((w) => w.id === mine.id));
        const hidden = rejectsWith(404, 'E_NOT_FOUND');
        await assert.rejects(agent.getWebhook(exits.id), hidden);
        await assert.rejects(agent.updateWebhook(exits.id, { enabled: false }), hidden);
        await assert.rejects(agent.testWebhook(exits.id), hidden);
        await assert.rejects(agent.rotateWebhookSecret(exits.id), hidden);
        await assert.rejects(agent.listWebhookDeliveries(exits.id), hidden);
        await assert.rejects(agent.deleteWebhook(exits.id), hidden);
        await assert.rejects(agent.createWebhook({ url: `${rb}/agent`, sandboxId: sb.id }), hidden);
        assert.equal((await admin.getWebhook(exits.id)).enabled, true, 'untouched');

        await sb.exec({ argv: ['true'] });
        await sa.exec({ argv: ['sh', '-c', 'exit 5'] });
        await until(() => r.at('/agent').length >= 1, 10_000, 'the agent delivery');
        await settled();
        const got = r.at('/agent').map((h) => verifyWebhook(mine.secret, h.headers, h.body));
        assert.ok(got.length >= 1);
        assert.deepEqual(new Set(got.map((p) => p.data.sandboxId)), new Set([sa.id]));
        assert.ok(got.some((p) => p.type === 'exec.finished' && p.data.payload.exitCode === 5));

        await admin.revokeKey(minted.id);
        const before = r.at('/agent').length;
        await sa.exec({ argv: ['true'] });
        await settled();
        assert.equal(r.at('/agent').length, before, 'a revoked owner gets nothing more');
      },
    );

    await t.test('with the default config, private targets are refused with 400', async () => {
      const app = createServer({ manager: srv.manager, keys: KEYS, logger: quiet() });
      const { port } = await app.listen(0);
      try {
        const strict = new WorkboxClient({
          baseUrl: `http://127.0.0.1:${port}`,
          token: TOKENS.admin,
        });
        for (const url of [
          'https://127.0.0.1/hook',
          'https://localhost/hook',
          'https://[::ffff:127.0.0.1]/hook',
          `${rb}/strict`,
        ])
          await assert.rejects(
            strict.createWebhook({ url }),
            rejectsWith(400, 'E_INVALID_PARAMS'),
            url,
          );
        await assert.rejects(
          strict.updateWebhook(exits.id, { url: 'https://localhost/x' }),
          rejectsWith(400, 'E_INVALID_PARAMS'),
        );
        const reader = new WorkboxClient({
          baseUrl: `http://127.0.0.1:${port}`,
          token: TOKENS.read,
        });
        await assert.rejects(
          reader.createWebhook({ url: 'https://8.8.8.8/' }),
          rejectsWith(403, 'E_DENIED'),
        );
        assert.ok((await reader.listWebhooks()).webhooks.length >= 1, 'read may list');
      } finally {
        await app.close({ timeoutMs: 1000 });
      }
    });

    await t.test(
      'every webhook route answered 2xx; secrets reach no audit entry or log',
      async () => {
        const ok = okRoutes(await admin.metrics());
        const routes = Object.keys(SCOPE_MATRIX).filter((k) => k.includes(' /v1/webhooks'));
        assert.equal(routes.length, 9);
        assert.deepEqual(
          routes.filter((k) => !ok.has(k)),
          [],
        );
        const entries = auditEntries(srv.eng.config.paths.audit);
        for (const action of ['create', 'update', 'delete', 'rotate', 'test', 'retry'])
          assert.ok(
            entries.some((e) => e.action === `api.webhook.${action}`),
            action,
          );
        const recorded = JSON.stringify(entries) + srv.logs.join('');
        for (const secret of secrets) {
          assert.equal(recorded.includes(secret), false);
          assert.equal(recorded.includes(secret.slice(6)), false);
        }
        const rows = JSON.stringify(store.db.prepare('SELECT * FROM webhook_deliveries').all());
        for (const secret of secrets) assert.equal(rows.includes(secret.slice(6)), false);
      },
    );
  } finally {
    await srv.stop();
    await r.close();
  }
});
