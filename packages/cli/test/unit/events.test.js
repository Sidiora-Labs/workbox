import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '@workbox/core';
import { createServer } from '@workbox/server';
import { WorkboxClient } from '@workbox/sdk';
import { eventsCommand, parseEventsArgs, EVENTS_USAGE } from '../../src/events.js';
import { main, HELP } from '../../src/main.js';
import { openLocalEngine } from '../../src/local.js';

const base = { rootfs: 'minimal', runtime: 'current', profile: { limits: { pids: 10 } } };

function capture() {
  const chunks = [];
  return {
    stream: { write: (d) => chunks.push(String(d)) },
    text: () => chunks.join(''),
    rows: () =>
      chunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
  };
}

async function until(fn, what) {
  const deadline = Date.now() + 10_000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const invalid = (re) => (e) => e.code === 'E_INVALID_PARAMS' && re.test(e.message);

test('events flags: --type repeats, --after is a sequence number, --follow or -f', () => {
  assert.match(
    HELP,
    /workbox events \[--sandbox id\] \[--type t\]\.\.\. \[--after seq\] \[--follow\]/,
  );
  assert.deepEqual(parseEventsArgs([]), { follow: false });
  assert.deepEqual(
    parseEventsArgs([
      '--sandbox',
      'sb-1',
      '--type',
      'build.*',
      '--type',
      'session.exited',
      '--after',
      '42',
      '--follow',
      '--json',
    ]),
    { follow: true, sandboxId: 'sb-1', types: ['build.*', 'session.exited'], afterSeq: 42 },
  );
  assert.equal(parseEventsArgs(['-f']).follow, true);
  assert.throws(() => parseEventsArgs(['--after', '-1']), invalid(/--after -1 must be a sequence/));
  assert.throws(() => parseEventsArgs(['--type']), invalid(/--type needs a value/));
  assert.throws(() => parseEventsArgs(['--tail']), invalid(/unknown argument --tail/));
  assert.ok(EVENTS_USAGE.startsWith('workbox events'));
});

test('events on the local engine and through --server: list, page, follow', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-cli-events-'));
  const engine = await openLocalEngine({ env: {}, overrides: { root: dir } });
  const app = createServer({
    manager: engine.manager,
    keys: [{ id: 'ops', token: 'cli-events-read', scopes: ['read'] }],
    audit: engine.audit,
    logger: createLogger({ component: 'server', stream: { write() {} } }),
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  const server = ['--server', origin, '--token', 'cli-events-read'];
  const client = new WorkboxClient({ baseUrl: origin, token: 'cli-events-read', retryDelayMs: 5 });
  const run = async (args, deps = {}) => {
    const out = capture();
    const err = capture();
    const code = await main(args, { out: out.stream, err: err.stream, ...deps });
    return { code, rows: out.rows(), err: err.text() };
  };
  const a = engine.store.createSandbox(base);
  const b = engine.store.createSandbox(base);
  const log = (sb, type, payload = {}) => engine.manager.logEvent(sb.id, type, payload);
  const listeners = engine.manager.listenerCount('logged');
  try {
    const one = log(a, 'unit.one', { n: 1 });
    const two = log(b, 'unit.two', { n: 2 });
    log(a, 'other.kind');

    await t.test('stored events print one JSON object per line, locally and remotely', async () => {
      for (const deps of [{ engine }, {}]) {
        const args = ['events', '--type', 'unit.*', ...(deps.engine ? [] : server)];
        const res = await run(args, deps);
        assert.equal(res.code, 0, res.err);
        assert.deepEqual(res.rows, [one, two]);
        const only = await run(
          ['events', '--sandbox', b.id, '--after', '0', ...(deps.engine ? [] : server)],
          deps,
        );
        assert.deepEqual(only.rows, [two]);
      }
      engine.store.tx(() => {
        for (let i = 0; i < 520; i++) log(a, 'page.row', { i });
      });
      for (const deps of [{ engine }, {}]) {
        const res = await run(
          ['events', '--type', 'page.row', ...(deps.engine ? [] : server)],
          deps,
        );
        assert.equal(res.rows.length, 520, 'every page is printed');
        assert.deepEqual(
          res.rows.map((r) => r.payload.i),
          Array.from({ length: 520 }, (_, i) => i),
        );
      }
    });

    await t.test('--follow prints stored events after --after, then logged ones', async () => {
      for (const ctx of [{ engine }, { client }]) {
        const stored = log(b, 'unit.stored');
        const out = capture();
        const ac = new AbortController();
        const done = eventsCommand({ ...ctx, out: out.stream, signal: ac.signal }, [
          '--follow',
          '--type',
          'unit.*',
          '--after',
          String(stored.seq - 1),
        ]);
        await until(() => out.rows().length === 1, 'the stored event');
        assert.deepEqual(out.rows(), [stored]);
        log(b, 'other.kind');
        const three = log(a, 'unit.three');
        await until(() => out.rows().length === 2, 'the logged event');
        assert.deepEqual(out.rows()[1], three);
        ac.abort();
        assert.deepEqual(await done, { text: true });
      }
      await until(() => engine.manager.listenerCount('logged') === listeners, 'listeners gone');
    });

    await t.test('--follow without --after is live only; SIGTERM ends it cleanly', async () => {
      const out = capture();
      const handlers = process.listenerCount('SIGTERM');
      const interrupts = process.listenerCount('SIGINT');
      const done = eventsCommand({ engine, out: out.stream }, ['--follow', '--sandbox', a.id]);
      await until(() => process.listenerCount('SIGTERM') > handlers, 'the signal handler');
      await until(() => engine.manager.listenerCount('logged') > listeners, 'the subscription');
      log(b, 'unit.elsewhere');
      const live = log(a, 'unit.live');
      await until(() => out.rows().length === 1, 'the live event');
      assert.deepEqual(out.rows(), [live]);
      process.listeners('SIGTERM').at(-1)('SIGTERM');
      assert.deepEqual(await done, { text: true });
      assert.equal(process.listenerCount('SIGTERM'), handlers);
      assert.equal(process.listenerCount('SIGINT'), interrupts);
      assert.equal(engine.manager.listenerCount('logged'), listeners);
    });

    await t.test('errors: no engine or server, and a refused key through --server', async () => {
      await assert.rejects(eventsCommand({}, []), invalid(/needs a local engine or --server/));
      const bad = await run(['events', '--server', origin, '--token', 'nope']);
      assert.equal(bad.code, 4);
      assert.match(bad.err, /missing or invalid bearer token \(E_DENIED\)/);
      const out = capture();
      const wrong = new WorkboxClient({ baseUrl: origin, token: 'nope', retryDelayMs: 5 });
      await assert.rejects(
        eventsCommand({ client: wrong, out: out.stream, signal: new AbortController().signal }, [
          '--follow',
        ]),
        (e) => e.status === 401,
      );
      const usage = await run(['events', '--after', 'x'], { engine });
      assert.equal(usage.code, 2);
    });
  } finally {
    await app.close({ timeoutMs: 1000 });
    engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
