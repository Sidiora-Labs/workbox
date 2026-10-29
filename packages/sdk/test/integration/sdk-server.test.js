import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { SCOPE_MATRIX } from '@workbox/server';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { WorkboxApiError, WorkboxClient } from '../../src/index.js';

const text = (b64) => Buffer.from(b64, 'base64').toString();
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

/** Route templates with at least one 2xx in the server's `workbox_http_requests_total`. */
function okRoutes(metrics) {
  const re =
    /^workbox_http_requests_total\{method="[A-Z]+",route="([^"]+)",status="2\d\d"\} \d+$/gm;
  return new Set([...metrics.matchAll(re)].map((m) => m[1]));
}

/**
 * A real HTTP proxy in front of the server that lets the first `POST /v1/sandboxes` reach the
 * server, waits for the server's answer, then drops the client connection without relaying it:
 * the create happened, the caller never heard.
 */
async function droppingProxy(port) {
  const seen = [];
  let dropped = false;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers, host: `127.0.0.1:${port}`, connection: 'close' };
      const up = http.request(
        { host: '127.0.0.1', port, method: req.method, path: req.url, headers, agent: false },
        (upRes) => {
          const out = [];
          upRes.on('data', (c) => out.push(c));
          upRes.on('end', () => {
            const answer = Buffer.concat(out);
            seen.push({
              method: req.method,
              url: req.url,
              body: body.length ? JSON.parse(body) : null,
              status: upRes.statusCode,
              response: JSON.parse(answer),
            });
            if (req.method === 'POST' && req.url === '/v1/sandboxes' && !dropped) {
              dropped = true;
              req.socket.destroy();
              return;
            }
            res.writeHead(upRes.statusCode, { 'content-type': upRes.headers['content-type'] });
            res.end(answer);
          });
        },
      );
      up.on('error', () => res.destroy());
      up.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    base: `http://127.0.0.1:${server.address().port}`,
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * A real TCP relay in front of the server. `cut()` destroys every connection it carries, as a
 * network drop would; `accepted()` counts the connections it took.
 */
async function tcpRelay(port) {
  const live = new Set();
  let accepted = 0;
  const server = net.createServer((down) => {
    accepted++;
    const up = net.connect(port, '127.0.0.1');
    const pair = [down, up];
    live.add(pair);
    const end = () => {
      down.destroy();
      up.destroy();
      live.delete(pair);
    };
    for (const sock of pair) {
      sock.on('error', end);
      sock.on('close', end);
    }
    down.pipe(up);
    up.pipe(down);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const cut = () => {
    for (const [down, up] of live) {
      down.destroy();
      up.destroy();
    }
  };
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    accepted: () => accepted,
    cut,
    close() {
      cut();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

test('the sdk drives every route of a real server over a real engine', async (t) => {
  const srv = await bootServer();
  const as = (scope) =>
    new WorkboxClient({ baseUrl: srv.base, token: TOKENS[scope], retryDelayMs: 20 });
  const admin = as('admin');
  const reader = as('read');
  const harness = as('exec');
  const human = as('answer');
  try {
    await t.test('health, readiness and metrics', async () => {
      assert.deepEqual(await reader.health(), { ok: true });
      assert.deepEqual(await reader.ready(), { ready: true });
      assert.match(await reader.metrics(), /# TYPE workbox_http_requests_total counter/);
      await assert.rejects(
        new WorkboxClient({ baseUrl: srv.base }).listSandboxes(),
        (e) => e instanceof WorkboxApiError && e.status === 401,
      );
    });

    const [a, b] = await Promise.all(
      ['sdk-a', 'sdk-b'].map((name) => admin.createSandbox({ name })),
    );
    assert.equal(a.row.state, 'READY');

    await t.test(
      'inventory pages with a cursor; inspect separates desired and observed',
      async () => {
        const first = await reader.listSandboxes({ limit: 1 });
        assert.equal(first.complete, false);
        const rest = await reader.listSandboxes({ limit: 1, cursor: first.cursor });
        assert.equal(rest.complete, true);
        assert.deepEqual([first.items[0].id, rest.items[0].id].sort(), [a.id, b.id].sort());
        const ins = await reader.sandbox(a.id).inspect();
        assert.equal(ins.desired, 'READY');
        assert.equal(ins.health, 'HEALTHY');
        assert.equal(typeof ins.lastObservedAt, 'number');
      },
    );

    await t.test(
      'a create retried after a lost response makes one sandbox with one key',
      async () => {
        const proxy = await droppingProxy(srv.port);
        try {
          const viaProxy = new WorkboxClient({
            baseUrl: proxy.base,
            token: TOKENS.admin,
            retryDelayMs: 20,
          });
          const sb = await viaProxy.createSandbox({ name: 'sdk-once' });
          const creates = proxy.seen.filter((s) => s.method === 'POST');
          assert.equal(creates.length, 2);
          assert.equal(creates[0].status, 201);
          assert.ok(creates[0].body.idempotencyKey);
          assert.equal(creates[1].body.idempotencyKey, creates[0].body.idempotencyKey);
          assert.equal(sb.id, creates[0].response.id);
          assert.equal(creates[1].response.id, sb.id);
          const all = await reader.listSandboxes({ limit: 100 });
          assert.deepEqual(
            all.items.filter((s) => s.name === 'sdk-once').map((s) => s.id),
            [sb.id],
          );
          assert.equal((await admin.sandbox(sb.id).destroy()).state, 'DELETED');
        } finally {
          await proxy.close();
        }
      },
    );

    await t.test(
      'a create whose launch fails is a failure on its retries and replays',
      async () => {
        const input = {
          name: 'sdk-broken',
          idempotencyKey: `sdk-broken-${process.pid}`,
          profile: { limits: { pids: 3 } },
        };
        const failed = (e) =>
          e instanceof WorkboxApiError &&
          e.code === 'E_QUARANTINED' &&
          e.status === 423 &&
          /failed to launch: launch failed/.test(e.message);
        await assert.rejects(admin.createSandbox(input), failed);
        await assert.rejects(admin.createSandbox(input), failed);
        const all = await reader.listSandboxes({ limit: 100 });
        const broken = all.items.filter((s) => s.name === 'sdk-broken');
        assert.equal(broken.length, 1, 'the retries made no second sandbox');
        assert.equal(broken[0].state, 'QUARANTINED');
        assert.equal((await admin.sandbox(broken[0].id).destroy()).state, 'DELETED');
      },
    );

    await t.test('exec runs in the box; a read key gets a 403 WorkboxApiError', async () => {
      await assert.rejects(
        reader.sandbox(a.id).exec({ argv: ['true'] }),
        (e) => e instanceof WorkboxApiError && e.status === 403 && e.code === 'E_DENIED',
      );
      await assert.rejects(reader.sandbox(a.id).destroy(), (e) => e.status === 403);
      const out = await harness.sandbox(a.id).exec({
        argv: ['sh', '-c', 'echo out; echo err >&2; exit 3'],
      });
      assert.equal(out.stdout, 'out\n');
      assert.equal(out.stderr, 'err\n');
      assert.equal(out.exitCode, 3);
    });

    await t.test('files write, append, read a range and list', async () => {
      const box = harness.sandbox(a.id);
      const put = await box.writeFile('/tmp/sdk/hello.txt', 'hello from the sdk\n', {
        mkdirs: true,
      });
      assert.equal(put.bytes, 19);
      await box.writeFile('/tmp/sdk/hello.txt', Buffer.from('more\n'), { append: true });
      const view = reader.sandbox(a.id);
      const read = await view.readFile('/tmp/sdk/hello.txt');
      assert.equal(text(read.data), 'hello from the sdk\nmore\n');
      const part = await view.readFile('/tmp/sdk/hello.txt', { offset: 6, length: 4 });
      assert.equal(text(part.data), 'from');
      assert.deepEqual((await view.listFiles('/tmp/sdk')).entries, [
        { name: 'hello.txt', type: 'file' },
      ]);
      await assert.rejects(view.readFile('/nope'), (e) => e.status === 404);
    });

    await t.test(
      'a session streams as an async iterator and takes input',
      { timeout: 60_000 },
      async () => {
        const box = harness.sandbox(a.id);
        const { sessionId } = await box.startSession({
          argv: ['sh', '-c', 'read line; echo "got:$line"'],
          name: 'sdk-echo',
        });
        const stream = box.attach(sessionId);
        stream.input('ping\n');
        const seen = [];
        for await (const evt of stream) seen.push(evt);
        const out = seen
          .filter((e) => e.type === 'session.output')
          .map((e) => text(e.params.data))
          .join('');
        assert.equal(out, 'got:ping\n');
        assert.equal(seen.at(-1).type, 'session.exit');
        assert.equal(seen.at(-1).params.code, 0);
        const { sessions } = await reader.sandbox(a.id).listSessions();
        assert.ok(sessions.some((s) => s.sessionId === sessionId));
      },
    );

    await t.test(
      'an abort ends a session stream; a signal sent on another ends the session',
      { timeout: 60_000 },
      async () => {
        const box = harness.sandbox(a.id);
        const { sessionId } = await box.startSession({
          argv: ['sh', '-c', 'echo started; exec sleep 600'],
        });
        const ac = new AbortController();
        const watched = box.attach(sessionId, { signal: ac.signal });
        await assert.rejects(
          async () => {
            for await (const evt of watched) if (evt.type === 'session.output') ac.abort();
          },
          (e) => e.name === 'AbortError',
        );
        const killer = box.attach(sessionId);
        killer.sendSignal('SIGKILL');
        const seen = [];
        for await (const evt of killer) seen.push(evt);
        assert.equal(seen.at(-1).type, 'session.exit');
      },
    );

    await t.test('an ask raised in the box is listed and answered through the sdk', async () => {
      const raised = await harness.sandbox(a.id).exec({
        argv: ['wb', 'ask', 'raise', '--json', '--kind', 'question', 'Which branch?'],
      });
      assert.equal(raised.exitCode, 0, raised.stderr);
      const { askId } = lastJson(raised.stdout);
      const open = await reader.listAsks({ status: 'open', sandboxId: a.id, limit: 10 });
      assert.deepEqual(
        open.asks.map((x) => x.askId),
        [askId],
      );
      await assert.rejects(reader.answerAsk(askId, 'x'), (e) => e.status === 403);
      assert.equal((await human.answerAsk(askId, 'main')).status, 'answered');
      await assert.rejects(
        human.answerAsk(askId, 'again'),
        (e) => e.status === 409 && !e.retryable,
      );
    });

    await t.test(
      'events page and follow through async iterators; evidence and artifacts list',
      { timeout: 60_000 },
      async () => {
        for (const step of [1, 2, 3]) {
          const emit = await harness.sandbox(a.id).exec({
            argv: ['wb', 'event', 'emit', 'sdk.step', JSON.stringify({ step }), '--json'],
          });
          assert.equal(emit.exitCode, 0, emit.stderr);
        }
        const view = reader.sandbox(a.id);
        assert.equal((await view.listEvents({ afterSeq: 0, limit: 1 })).events.length, 1);
        const seen = [];
        for await (const evt of view.events({ limit: 1 })) seen.push(evt);
        assert.equal(seen.filter((e) => e.type === 'sdk.step').length, 3);
        const seqs = seen.map((e) => e.seq);
        assert.deepEqual(
          seqs,
          [...new Set(seqs)].sort((x, y) => x - y),
        );

        const ac = new AbortController();
        const later = harness.sandbox(a.id).exec({
          argv: ['wb', 'event', 'emit', 'sdk.later', '{}', '--json'],
        });
        const followed = [];
        await assert.rejects(
          async () => {
            const opts = { afterSeq: seqs.at(-1), follow: true, intervalMs: 50, signal: ac.signal };
            for await (const evt of view.events(opts)) {
              followed.push(evt.type);
              if (evt.type === 'sdk.later') ac.abort();
            }
          },
          (e) => e.name === 'AbortError',
        );
        assert.equal((await later).exitCode, 0);
        assert.ok(followed.includes('sdk.later'), followed.join(', '));

        const put = await harness.sandbox(a.id).exec({
          argv: [
            'sh',
            '-c',
            'echo artifact-body > /tmp/out.txt && wb artifact put /tmp/out.txt --json',
          ],
        });
        assert.equal(put.exitCode, 0, put.stderr);
        const artifacts = await view.listArtifacts({ limit: 10 });
        assert.equal(artifacts.items.length, 1);
        assert.equal(artifacts.complete, true);
        const evidence = await view.listEvidence({ limit: 10 });
        assert.ok(Array.isArray(evidence.items));
        assert.equal(typeof evidence.complete, 'boolean');
        assert.deepEqual((await reader.sandbox(b.id).listArtifacts()).items, []);
      },
    );

    await t.test(
      'fleet events: a long-poll, and a stream that reconnects after a drop and resumes',
      { timeout: 60_000 },
      async () => {
        const emit = async (type) => {
          const out = await harness.sandbox(a.id).exec({
            argv: ['wb', 'event', 'emit', type, '{}', '--json'],
          });
          assert.equal(out.exitCode, 0, out.stderr);
          return lastJson(out.stdout).seq;
        };
        const from = srv.eng.store.lastEventSeq();
        const waiting = reader.listEvents({ afterSeq: from, types: ['fleet.*'], waitMs: 30_000 });
        const first = await emit('fleet.one');
        const polled = await waiting;
        assert.deepEqual(
          polled.events.map((e) => [e.seq, e.sandboxId, e.type]),
          [[first, a.id, 'fleet.one']],
        );
        assert.equal(polled.nextSeq, first);
        assert.deepEqual(await reader.listEvents({ afterSeq: first, types: ['fleet.*'] }), {
          events: [],
          nextSeq: first,
        });

        const relay = await tcpRelay(srv.port);
        try {
          const viaRelay = new WorkboxClient({
            baseUrl: relay.base,
            token: TOKENS.read,
            retryDelayMs: 20,
          });
          const ac = new AbortController();
          const stream = viaRelay.events({ afterSeq: from, types: ['fleet.*'], signal: ac.signal });
          const it = stream[Symbol.asyncIterator]();
          assert.equal((await it.next()).value.seq, first);
          relay.cut();
          const second = await emit('fleet.two');
          assert.equal((await it.next()).value.seq, second, 'replayed after the reconnect');
          const third = await emit('fleet.three');
          assert.equal((await it.next()).value.seq, third, 'and live again');
          assert.ok(relay.accepted() >= 2, 'the stream reconnected');
          assert.equal(stream.lastSeq, third);
          ac.abort();
          await assert.rejects(it.next(), (e) => e.name === 'AbortError');

          const own = reader
            .sandbox(a.id)
            .events({ afterSeq: from, types: ['fleet.*'], follow: true });
          const seqs = [];
          for await (const evt of own) {
            seqs.push(evt.seq);
            if (seqs.length === 3) break;
          }
          assert.deepEqual(seqs, [first, second, third]);
        } finally {
          await relay.close();
        }
      },
    );

    await t.test('checkpoints create and list', async () => {
      const cp = await admin.sandbox(a.id).createCheckpoint({ name: 'sdk-cp' });
      assert.ok(cp.id);
      const { checkpoints } = await reader.sandbox(a.id).listCheckpoints();
      assert.deepEqual(
        checkpoints.map((c) => c.name),
        ['sdk-cp'],
      );
    });

    await t.test('a stored key is minted, sees only its sandbox and stops at revoke', async () => {
      assert.deepEqual(await reader.whoami(), {
        id: 'observer',
        scopes: ['read'],
        binding: null,
        source: 'config',
        expiresAt: null,
      });
      const minted = await admin.createKey({
        name: 'sdk-agent',
        scopes: ['read'],
        sandboxIds: [a.id],
        ttlSeconds: 3600,
      });
      assert.match(minted.token, /^wbk_[A-Za-z0-9_-]{43}$/);
      assert.equal(minted.expiresAt - minted.createdAt, 3_600_000);
      const agent = new WorkboxClient({ baseUrl: srv.base, token: minted.token, retryDelayMs: 20 });
      assert.deepEqual(await agent.whoami(), {
        id: minted.id,
        scopes: ['read'],
        binding: { sandboxIds: [a.id] },
        source: 'store',
        expiresAt: minted.expiresAt,
      });
      assert.deepEqual(
        (await agent.listSandboxes()).items.map((s) => s.id),
        [a.id],
      );
      assert.equal((await agent.sandbox(a.id).inspect()).id, a.id);
      await assert.rejects(
        agent.sandbox(b.id).inspect(),
        (e) => e instanceof WorkboxApiError && e.status === 404 && e.code === 'E_NOT_FOUND',
      );
      await assert.rejects(agent.listKeys(), (e) => e.status === 403 && e.code === 'E_DENIED');
      const { keys } = await admin.listKeys();
      const row = keys.find((k) => k.id === minted.id);
      assert.equal(row.name, 'sdk-agent');
      assert.equal(typeof row.lastUsedAt, 'number');
      assert.equal('token' in row, false);
      const revoked = await admin.revokeKey(minted.id);
      assert.equal(typeof revoked.revokedAt, 'number');
      assert.equal((await admin.revokeKey(minted.id)).revokedAt, revoked.revokedAt);
      await assert.rejects(agent.whoami(), (e) => e.status === 401 && !e.retryable);
    });

    await t.test('drain, reconcile and destroy', async () => {
      assert.equal((await admin.sandbox(b.id).drain('sdk test')).state, 'DRAINING');
      const rec = await admin.reconcile();
      const observed = [...rec.attached, ...rec.suspect, ...rec.absent];
      assert.ok(observed.includes(a.id) && observed.includes(b.id), JSON.stringify(rec));
      assert.equal((await a.destroy()).state, 'DELETED');
      assert.equal((await b.destroy()).state, 'DELETED');
      assert.deepEqual((await reader.listSandboxes()).items, []);
      const everything = await reader.listSandboxes({ includeDeleted: true, limit: 100 });
      assert.ok(everything.items.length >= 3);
      assert.ok(everything.items.every((s) => s.state === 'DELETED'));
    });

    await t.test('every route in the server table answered 2xx to an sdk call', async () => {
      const metrics = await reader.metrics();
      const ok = okRoutes(metrics);
      const httpRoutes = Object.keys(SCOPE_MATRIX).filter((k) => !k.endsWith('/ws'));
      assert.equal(httpRoutes.length, 24);
      assert.deepEqual(
        httpRoutes.filter((k) => !ok.has(k)),
        [],
      );
      const ws = Number(/^workbox_ws_connections_total (\d+)$/m.exec(metrics)?.[1]);
      const attaches = srv.auditEntries().filter((e) => e.action === 'api.session.attach');
      assert.equal(attaches.length, 3);
      const streams = srv.auditEntries().filter((e) => e.action === 'api.events.stream');
      assert.ok(streams.length >= 4, String(streams.length));
      assert.equal(ws, attaches.length + streams.length);
    });
  } finally {
    await srv.stop();
  }
});
