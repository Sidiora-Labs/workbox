import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, WebhookDispatcher } from '@workbox/core';
import { createServer } from '@workbox/server';
import { verifyWebhook } from '@workbox/sdk';
import { receiver, until } from '../../../core/test/helpers/receiver.js';
import {
  webhookCommand,
  parseWebhookAdd,
  parseDeliveries,
  WEBHOOK_USAGE,
  LOCAL_OWNER,
} from '../../src/webhooks.js';
import { main, HELP } from '../../src/main.js';
import { openLocalEngine } from '../../src/local.js';
import { serveCommand } from '../../src/serve.js';

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

const invalid = (re) => (e) => e.code === 'E_INVALID_PARAMS' && re.test(e.message);
const LOCAL_TARGETS = { allowPrivate: true, allowHttp: true, retryDelaysMs: [50] };

/** A local engine on a fresh root whose webhooks may target this host over plain HTTP. */
async function localEngine(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wb-cli-${tag}-`));
  const engine = await openLocalEngine({
    env: {},
    overrides: { root: dir, webhooks: LOCAL_TARGETS },
  });
  return {
    engine,
    close() {
      engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function run(args, deps = {}) {
  const out = capture();
  const err = capture();
  const code = await main(args, { out: out.stream, err: err.stream, ...deps });
  return { code, out: out.text(), err: err.text() };
}

test('webhook add and deliveries parse their flags; the usage is in the help', () => {
  assert.deepEqual(parseWebhookAdd(['https://hooks.example/x']), {
    url: 'https://hooks.example/x',
  });
  assert.deepEqual(
    parseWebhookAdd([
      '--type',
      'session.exited',
      'https://hooks.example/x',
      '--type',
      'exec.*',
      '--sandbox',
      'sb-1',
      '--label',
      'team=a',
      '--label',
      'expr=x=y',
      '--description',
      'ci results',
    ]),
    {
      url: 'https://hooks.example/x',
      types: ['session.exited', 'exec.*'],
      sandboxId: 'sb-1',
      labels: { team: 'a', expr: 'x=y' },
      description: 'ci results',
    },
  );
  assert.throws(() => parseWebhookAdd([]), invalid(/url is required/));
  assert.throws(() => parseWebhookAdd(['a', 'b']), invalid(/unexpected argument b/));
  assert.throws(() => parseWebhookAdd(['u', '--type']), invalid(/--type needs a value/));
  assert.throws(() => parseWebhookAdd(['u', '--bogus', 'x']), invalid(/unknown argument --bogus/));
  assert.throws(() => parseWebhookAdd(['u', '--label', 'team']), invalid(/must be key=value/));
  assert.deepEqual(parseDeliveries(['wh_1']), { webhookId: 'wh_1' });
  assert.deepEqual(parseDeliveries(['--status', 'failed', 'wh_1', '--limit', '5']), {
    webhookId: 'wh_1',
    status: 'failed',
    limit: 5,
  });
  assert.throws(() => parseDeliveries([]), invalid(/takes one webhook id/));
  assert.throws(() => parseDeliveries(['a', 'b']), invalid(/unexpected argument b/));
  assert.throws(() => parseDeliveries(['a', '--limit', '0']), invalid(/positive integer/));
  assert.throws(() => parseDeliveries(['a', '--limit']), invalid(/needs a value/));
  assert.throws(() => parseDeliveries(['a', '--cursor', 'x']), invalid(/unknown argument/));
  assert.deepEqual(LOCAL_OWNER, { id: 'cli', binding: null });
  assert.ok(WEBHOOK_USAGE.includes('workbox webhook rotate <webhookId>'));
  assert.match(HELP, /workbox webhook add <url> \[--type T\]\.\.\./);
  assert.match(HELP, /workbox webhook ls\|rm\|test\|rotate\|deliveries <webhookId>/);
});

test('webhook add, ls, test, rotate, deliveries and rm, locally and through --server', async () => {
  const { engine, close } = await localEngine('webhooks');
  const dispatcher = new WebhookDispatcher({
    store: engine.store,
    config: engine.config.webhooks,
    pollMs: 50,
  });
  const app = createServer({
    manager: engine.manager,
    keys: [{ id: 'ops', token: 'cli-webhooks-admin', scopes: ['admin'] }],
    audit: engine.audit,
    logger: createLogger({ component: 'server', level: 'silent', stream: { write() {} } }),
    webhooks: dispatcher,
  });
  const { port } = await app.listen(0, '127.0.0.1');
  dispatcher.start();
  const r = await receiver([{ status: 204 }]);
  const rb = `http://127.0.0.1:${r.port}`;
  const server = ['--server', `http://127.0.0.1:${port}`, '--token', 'cli-webhooks-admin'];
  const local = { engine };
  try {
    const added = await run(
      [
        'webhook',
        'add',
        `${rb}/local`,
        '--type',
        'build.done',
        '--label',
        'team=a',
        '--description',
        'local hook',
      ],
      local,
    );
    assert.equal(added.code, 0, added.err);
    assert.match(added.err, /the secret is shown only this once/);
    const mine = JSON.parse(added.out);
    assert.match(mine.secret, /^whsec_/);
    assert.deepEqual(
      [mine.ownerKey, mine.types, mine.labels, mine.description],
      ['cli', ['build.done'], { team: 'a' }, 'local hook'],
    );
    const remoteAdd = await run(['webhook', 'add', `${rb}/remote`, '--json', ...server]);
    assert.equal(remoteAdd.code, 0, remoteAdd.err);
    assert.equal(remoteAdd.out.trim().includes('\n'), false, '--json prints one line');
    const theirs = JSON.parse(remoteAdd.out);
    assert.equal(theirs.ownerKey, 'ops');

    const lsLocal = await run(['webhook', 'ls'], local);
    const lsRemote = await run(['webhook', 'list', ...server]);
    assert.equal(lsLocal.code, 0, lsLocal.err);
    assert.deepEqual(JSON.parse(lsLocal.out), JSON.parse(lsRemote.out));
    assert.deepEqual(
      JSON.parse(lsLocal.out)
        .webhooks.map((w) => w.id)
        .sort(),
      [mine.id, theirs.id].sort(),
    );
    for (const text of [lsLocal.out, lsRemote.out])
      for (const secret of [mine.secret, theirs.secret]) assert.equal(text.includes(secret), false);

    const queued = await run(['webhook', 'test', mine.id], local);
    assert.equal(queued.code, 0, queued.err);
    const localTest = JSON.parse(queued.out);
    assert.deepEqual([localTest.status, localTest.event.type], ['pending', 'webhook.test']);
    const sent = await run(['webhook', 'test', theirs.id, ...server]);
    assert.equal(sent.code, 0, sent.err);
    const remoteTest = JSON.parse(sent.out);
    await until(() => r.at('/local').length === 1 && r.at('/remote').length === 1);
    const [l] = r.at('/local');
    assert.equal(l.headers['webhook-id'], localTest.id);
    assert.equal(verifyWebhook(mine.secret, l.headers, l.body).type, 'webhook.test');
    const [rr] = r.at('/remote');
    assert.equal(rr.headers['webhook-id'], remoteTest.id);
    verifyWebhook(theirs.secret, rr.headers, rr.body);

    const rotated = await run(['webhook', 'rotate', mine.id], local);
    assert.equal(rotated.code, 0, rotated.err);
    assert.match(rotated.err, /new secret is shown only this once/);
    const fresh = JSON.parse(rotated.out).secret;
    assert.notEqual(fresh, mine.secret);
    assert.equal(engine.store.getWebhookSecret(mine.id), fresh);
    const rotatedRemote = await run(['webhook', 'rotate', theirs.id, ...server]);
    assert.equal(rotatedRemote.code, 0, rotatedRemote.err);
    assert.notEqual(JSON.parse(rotatedRemote.out).secret, theirs.secret);

    await until(
      () => engine.store.listWebhookDeliveries(mine.id, { status: 'delivered' }).items.length === 1,
    );
    const listed = await run(['webhook', 'deliveries', mine.id, '--status', 'delivered'], local);
    assert.equal(listed.code, 0, listed.err);
    assert.deepEqual(
      JSON.parse(listed.out).items.map((d) => [d.id, d.status, d.lastStatus]),
      [[localTest.id, 'delivered', 204]],
    );
    const listedRemote = await run(['webhook', 'deliveries', mine.id, '--limit', '1', ...server]);
    assert.equal(listedRemote.code, 0, listedRemote.err);
    assert.deepEqual(
      JSON.parse(listedRemote.out).items.map((d) => d.id),
      [localTest.id],
    );

    const rmLocal = await run(['webhook', 'rm', theirs.id], local);
    assert.equal(rmLocal.code, 0, rmLocal.err);
    assert.equal(JSON.parse(rmLocal.out).id, theirs.id);
    const rmRemote = await run(['webhook', 'delete', mine.id, ...server]);
    assert.equal(rmRemote.code, 0, rmRemote.err);
    assert.deepEqual(JSON.parse((await run(['webhook', 'ls'], local)).out), { webhooks: [] });

    const missing = await run(['webhook', 'rm', mine.id], local);
    assert.equal(missing.code, 3);
    assert.match(missing.err, /not found \(E_NOT_FOUND\)/);
    const missingRemote = await run(['webhook', 'test', mine.id, ...server]);
    assert.equal(missingRemote.code, 3);
    for (const args of [
      ['webhook'],
      ['webhook', 'bogus'],
      ['webhook', 'add'],
      ['webhook', 'rm'],
      ['webhook', 'rotate', 'a', 'b'],
      ['webhook', 'ls', 'extra'],
    ]) {
      const bad = await run(args, local);
      assert.equal(bad.code, 2, args.join(' '));
      assert.match(bad.err, /workbox webhook add <url>/, args.join(' '));
    }
    await assert.rejects(
      webhookCommand({ engine: null, client: null }, ['ls']),
      invalid(/needs a local engine or --server/),
    );
  } finally {
    await app.close({ timeoutMs: 1000 });
    await dispatcher.stop({ timeoutMs: 1000 });
    await r.close();
    close();
  }
});

test('workbox serve delivers logged events to webhooks and stops delivering when it stops', async () => {
  const { engine, close } = await localEngine('serve-webhooks');
  const r = await receiver([{ status: 200 }]);
  const out = capture();
  const err = capture();
  const stopped = new AbortController();
  let serving;
  try {
    const added = await run(
      ['webhook', 'add', `http://127.0.0.1:${r.port}/served`, '--type', 'build.*'],
      { engine },
    );
    assert.equal(added.code, 0, added.err);
    const hook = JSON.parse(added.out);
    serving = serveCommand({ engine, out: out.stream, err: err.stream }, ['--port', '0'], {
      env: {},
      signal: stopped.signal,
    });
    await until(() => out.text().includes('listening'));
    const row = engine.manager.logEvent('sb-served', 'build.done', { ok: true });
    engine.manager.logEvent('sb-served', 'other.event', {});
    await until(() => r.at('/served').length === 1, 10_000, 'the served delivery');
    const [hit] = r.at('/served');
    const payload = verifyWebhook(hook.secret, hit.headers, hit.body);
    assert.deepEqual(payload.data, row);
    stopped.abort();
    await serving;
    serving = null;
    engine.manager.logEvent('sb-served', 'build.done', { after: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(r.at('/served').length, 1, 'nothing is sent after serve stopped');
    assert.equal(engine.manager.listenerCount('logged'), 0, 'serve removed its listener');
  } finally {
    if (serving) {
      stopped.abort();
      await serving.catch(() => undefined);
    }
    await r.close();
    close();
  }
});
