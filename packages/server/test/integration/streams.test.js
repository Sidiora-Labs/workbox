import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootServer, call, rawUpgrade, TOKENS } from '../helpers/real-server.js';

const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));
const EVENT_KEYS = ['at', 'causation', 'payload', 'sandboxId', 'seq', 'source', 'type'];

async function until(fn, what, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Open an events WebSocket and collect its frames. */
function openStream(base, target) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}${target}`);
  const frames = [];
  let closeCode = null;
  ws.addEventListener('message', (ev) => frames.push(JSON.parse(String(ev.data))));
  ws.addEventListener('close', (ev) => {
    closeCode = ev.code;
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`websocket ${target} failed`)), {
      once: true,
    });
  });
  return {
    ws,
    frames,
    opened,
    events: () => frames.filter((f) => f.type === 'event').map((f) => f.event),
    lives: () => frames.filter((f) => f.type === 'live'),
    closeCode: () => closeCode,
    async close() {
      if (closeCode !== null) return;
      ws.close();
      await until(() => closeCode !== null, `${target} to close`);
    },
  };
}

/** Every stored row after `afterSeq` matching `types`, read page by page. */
function storedSeqs(store, afterSeq, types) {
  const out = [];
  for (let cursor = afterSeq; ; ) {
    const page = store.listFleetEvents({ afterSeq: cursor, types, limit: 1000 });
    out.push(...page.map((r) => r.seq));
    if (page.length < 1000) return out;
    cursor = page.at(-1).seq;
  }
}

function assertIncreasing(seqs, what) {
  for (let i = 1; i < seqs.length; i++)
    assert.ok(seqs[i] > seqs[i - 1], `${what}: ${seqs[i - 1]} then ${seqs[i]}`);
}

test('sandbox events reach API clients by long-poll and WebSocket', async (t) => {
  const srv = await bootServer();
  const api = (token, method, path, body) => call(srv.port, { token, method, path, body });
  const store = srv.eng.store;
  const head = () => store.lastEventSeq();
  const idle = srv.manager.listenerCount('logged');
  try {
    const created = await Promise.all([
      api(TOKENS.admin, 'POST', '/v1/sandboxes', { name: 'streams-a', labels: { team: 'a' } }),
      api(TOKENS.admin, 'POST', '/v1/sandboxes', { name: 'streams-b', labels: { team: 'b' } }),
    ]);
    for (const c of created) assert.equal(c.status, 201, c.text);
    const [a, b] = created.map((c) => c.json);
    const minted = await api(TOKENS.admin, 'POST', '/v1/keys', {
      name: 'streams-team-a',
      scopes: ['read'],
      labels: { team: 'a' },
    });
    assert.equal(minted.status, 201, minted.text);
    const teamA = minted.json.token;
    const emit = async (sb, type, payload = {}) => {
      const res = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${sb.id}/exec`, {
        argv: ['wb', 'event', 'emit', type, JSON.stringify(payload), '--json'],
      });
      assert.equal(res.json.exitCode, 0, res.json.stderr);
      const { seq } = lastJson(res.json.stdout);
      assert.equal(typeof seq, 'number');
      return seq;
    };

    await t.test('fleet REST pages by types, sandbox and limit, with nextSeq', async () => {
      const from = head();
      const started = await emit(a, 'build.started', { step: 1 });
      const done = await emit(b, 'build.done', { ok: true });
      const passed = await emit(a, 'test.passed');
      const list = await api(TOKENS.read, 'GET', `/v1/events?afterSeq=${from}&types=build.*`);
      assert.equal(list.status, 200, list.text);
      assert.deepEqual(
        list.json.events.map((e) => [e.seq, e.sandboxId, e.type, e.source]),
        [
          [started, a.id, 'build.started', 'wb'],
          [done, b.id, 'build.done', 'wb'],
        ],
      );
      assert.deepEqual(Object.keys(list.json.events[0]).sort(), EVENT_KEYS);
      assert.deepEqual(list.json.events[0].payload, { step: 1 });
      assert.equal(list.json.nextSeq, done);
      const both = await api(
        TOKENS.read,
        'GET',
        `/v1/events?afterSeq=${from}&types=build.done,test.passed`,
      );
      assert.deepEqual(
        both.json.events.map((e) => e.seq),
        [done, passed],
      );
      const inB = await api(
        TOKENS.read,
        'GET',
        `/v1/events?afterSeq=${from}&sandboxId=${b.id}&types=build.*`,
      );
      assert.deepEqual(
        inB.json.events.map((e) => e.seq),
        [done],
      );
      const one = await api(TOKENS.read, 'GET', `/v1/events?afterSeq=${from}&limit=1`);
      assert.equal(one.json.events.length, 1);
      assert.equal(one.json.nextSeq, one.json.events[0].seq);
      const now = head();
      const empty = await api(TOKENS.read, 'GET', `/v1/events?afterSeq=${now}`);
      assert.deepEqual(empty.json, { events: [], nextSeq: now });
      const own = await api(
        TOKENS.read,
        'GET',
        `/v1/sandboxes/${a.id}/events?afterSeq=${from}&types=test.*`,
      );
      assert.deepEqual(own.json, {
        events: [store.getEvent(passed)],
        nextSeq: passed,
      });
      for (const bad of ['waitMs=60001', 'types=a,,b', 'afterSeq=x', 'limit=-1']) {
        const res = await api(TOKENS.read, 'GET', `/v1/events?${bad}`);
        assert.equal(res.status, 400, bad);
        assert.equal(res.json.error.code, 'E_INVALID_PARAMS', bad);
      }
      const missing = await api(TOKENS.read, 'GET', '/v1/sandboxes/sb-nope/events');
      assert.equal(missing.status, 404);
    });

    await t.test('a long-poll answers as soon as a matching event is logged', async () => {
      const listeners = srv.manager.listenerCount('logged');
      const after = head();
      const t0 = Date.now();
      const waiting = api(
        TOKENS.read,
        'GET',
        `/v1/events?afterSeq=${after}&types=lp.*&waitMs=30000`,
      );
      await until(() => srv.manager.listenerCount('logged') > listeners, 'the long-poll to wait');
      await emit(a, 'other.thing');
      const woke = await emit(b, 'lp.done', { code: 0 });
      const res = await waiting;
      assert.equal(res.status, 200, res.text);
      assert.ok(Date.now() - t0 < 20_000, 'well before the wait ran out');
      assert.deepEqual(
        res.json.events.map((e) => [e.seq, e.type]),
        [[woke, 'lp.done']],
      );
      assert.equal(res.json.nextSeq, woke);

      const since = head();
      const perSandbox = api(
        TOKENS.read,
        'GET',
        `/v1/sandboxes/${a.id}/events?afterSeq=${since}&types=lp.*&waitMs=30000`,
      );
      await until(() => srv.manager.listenerCount('logged') > listeners, 'the second long-poll');
      await emit(b, 'lp.elsewhere');
      const mine = await emit(a, 'lp.mine');
      const own = await perSandbox;
      assert.deepEqual(
        own.json.events.map((e) => e.seq),
        [mine],
      );
      await until(() => srv.manager.listenerCount('logged') === listeners, 'listeners released');
    });

    await t.test(
      'a long-poll answers empty at the timeout and lets go when the client leaves',
      async () => {
        const listeners = srv.manager.listenerCount('logged');
        const now = head();
        const t0 = Date.now();
        const res = await api(
          TOKENS.read,
          'GET',
          `/v1/events?afterSeq=${now}&types=never.*&waitMs=400`,
        );
        assert.ok(Date.now() - t0 >= 380, `answered after ${Date.now() - t0} ms`);
        assert.deepEqual(res.json, { events: [], nextSeq: now });
        assert.equal(srv.manager.listenerCount('logged'), listeners);

        const req = http.request({
          host: '127.0.0.1',
          port: srv.port,
          path: `/v1/events?afterSeq=${now}&types=never.*&waitMs=60000`,
          headers: { authorization: `Bearer ${TOKENS.read}` },
          agent: false,
        });
        req.on('error', () => undefined);
        req.end();
        await until(() => srv.manager.listenerCount('logged') > listeners, 'the request to wait');
        req.destroy();
        await until(
          () => srv.manager.listenerCount('logged') === listeners,
          'the wait to end with the client',
          5000,
        );
      },
    );

    await t.test(
      'a WebSocket replays many pages, then goes live with no gap and no duplicate',
      { timeout: 120_000 },
      async () => {
        const from = head();
        store.tx(() => {
          for (let i = 0; i < 1234; i++)
            srv.manager.logEvent(i % 2 ? a.id : b.id, 'bulk.row', { i });
        });
        const s = openStream(
          srv.base,
          `/v1/events/ws?afterSeq=${from}&types=bulk.*,ws.*&token=${TOKENS.read}`,
        );
        let during = 0;
        const ticker = setInterval(() => {
          srv.manager.logEvent(a.id, 'ws.during', { n: ++during });
          srv.manager.logEvent(b.id, 'noise.row');
        }, 2);
        try {
          await s.opened;
          await until(() => s.lives().length === 1, 'the live frame');
          await until(() => during >= 20, 'rows logged across the switch');
        } finally {
          clearInterval(ticker);
        }
        const inBox = await emit(a, 'ws.live');
        await until(() => s.events().some((e) => e.seq === inBox), 'the in-box event');
        const seqs = s.events().map((e) => e.seq);
        assertIncreasing(seqs, 'event order');
        assert.deepEqual(
          seqs,
          storedSeqs(store, from, ['bulk.*', 'ws.*']),
          'every row exactly once',
        );
        assert.ok(seqs.length >= 1234 + 20 + 1, String(seqs.length));
        const liveAt = s.frames.findIndex((f) => f.type === 'live');
        const live = s.frames[liveAt].seq;
        assert.ok(s.frames.slice(0, liveAt).every((f) => f.event.seq <= live));
        assert.ok(
          s.frames.slice(liveAt + 1).every((f) => f.type === 'event' && f.event.seq > live),
        );
        assert.ok(s.events().every((e) => e.type !== 'noise.row'));
        assert.deepEqual(Object.keys(s.events()[0]).sort(), EVENT_KEYS);
        await s.close();
      },
    );

    await t.test(
      'after a drop the client resumes with afterSeq: nothing missed or repeated',
      async () => {
        const from = head();
        const first = await emit(a, 'res.one');
        const s1 = openStream(
          srv.base,
          `/v1/events/ws?afterSeq=${from}&types=res.*&token=${TOKENS.read}`,
        );
        await until(() => s1.lives().length === 1, 'the first stream to go live');
        assert.deepEqual(
          s1.events().map((e) => e.seq),
          [first],
        );
        const last = s1.events().at(-1).seq;
        await s1.close();
        const missedA = await emit(a, 'res.two');
        const missedB = await emit(b, 'res.three');
        const s2 = openStream(
          srv.base,
          `/v1/events/ws?afterSeq=${last}&types=res.*&token=${TOKENS.read}`,
        );
        await until(() => s2.lives().length === 1, 'the resumed stream to go live');
        const later = await emit(a, 'res.four');
        await until(() => s2.events().length === 3, 'the live event after the resume');
        assert.deepEqual(
          s2.events().map((e) => e.seq),
          [missedA, missedB, later],
        );
        await s2.close();

        const own = openStream(
          srv.base,
          `/v1/sandboxes/${a.id}/events/ws?afterSeq=${from}&types=res.*&token=${TOKENS.read}`,
        );
        await until(() => own.lives().length === 1, 'the sandbox stream to go live');
        assert.deepEqual(
          own.events().map((e) => e.seq),
          [first, missedA, later],
        );
        await own.close();

        const liveOnly = openStream(srv.base, `/v1/events/ws?types=res.*&token=${TOKENS.read}`);
        await until(() => liveOnly.lives().length === 1, 'a live-only stream');
        assert.equal(liveOnly.frames[0].type, 'live', 'no replay without afterSeq');
        assert.ok(liveOnly.frames[0].seq >= later);
        const fresh = await emit(b, 'res.fresh');
        await until(() => liveOnly.events().length === 1, 'the fresh event');
        assert.equal(liveOnly.events()[0].seq, fresh);
        await liveOnly.close();
      },
    );

    await t.test(
      'a bound key gets only its sandboxes on REST, long-poll and both WebSockets',
      async () => {
        const from = head();
        await emit(b, 'bound.b1');
        const a1 = await emit(a, 'bound.a1');
        await emit(b, 'bound.b2');
        const list = await api(teamA, 'GET', `/v1/events?afterSeq=${from}&types=bound.*`);
        assert.equal(list.status, 200, list.text);
        assert.deepEqual(
          list.json.events.map((e) => e.seq),
          [a1],
        );
        const page = await api(teamA, 'GET', `/v1/events?afterSeq=${from}&limit=1`);
        assert.equal(
          page.json.events.length,
          1,
          'filtered in SQL: the page is not cut short by hidden rows',
        );
        assert.equal(page.json.events[0].sandboxId, a.id);
        assert.ok(page.json.events[0].seq <= a1);
        const other = await api(teamA, 'GET', `/v1/events?afterSeq=${from}&sandboxId=${b.id}`);
        assert.deepEqual(other.json, { events: [], nextSeq: from });
        assert.equal((await api(teamA, 'GET', `/v1/sandboxes/${b.id}/events`)).status, 404);

        const listeners = srv.manager.listenerCount('logged');
        const since = head();
        let answered = false;
        const waiting = api(
          teamA,
          'GET',
          `/v1/events?afterSeq=${since}&types=bound.*&waitMs=30000`,
        ).then((r) => {
          answered = true;
          return r;
        });
        await until(() => srv.manager.listenerCount('logged') > listeners, 'the bound long-poll');
        await emit(b, 'bound.b3');
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(answered, false, 'an event of a hidden sandbox does not wake it');
        const a2 = await emit(a, 'bound.a2');
        const woke = await waiting;
        assert.equal(woke.json.events[0].seq, a2);
        assert.ok(woke.json.events.every((e) => e.sandboxId === a.id));

        const fleet = openStream(
          srv.base,
          `/v1/events/ws?afterSeq=${from}&types=bound.*&token=${teamA}`,
        );
        const own = openStream(
          srv.base,
          `/v1/sandboxes/${a.id}/events/ws?afterSeq=${from}&types=bound.*&token=${teamA}`,
        );
        await until(() => fleet.lives().length === 1 && own.lives().length === 1, 'both live');
        await emit(b, 'bound.b4');
        const a3 = await emit(a, 'bound.a3');
        await until(
          () => [fleet, own].every((s) => s.events().some((e) => e.seq === a3)),
          'the live event on both',
        );
        for (const s of [fleet, own]) {
          assert.deepEqual(
            s.events().map((e) => e.seq),
            [a1, a2, a3],
          );
          assert.ok(s.events().every((e) => e.sandboxId === a.id));
          await s.close();
        }
        const hidden = `/v1/sandboxes/${b.id}/events/ws`;
        assert.match(await rawUpgrade(srv.port, `${hidden}?token=${teamA}`), /^HTTP\/1\.1 404/);
        assert.match(
          await rawUpgrade(srv.port, hidden, { Authorization: `Bearer ${teamA}` }),
          /^HTTP\/1\.1 404/,
        );
        assert.match(
          await rawUpgrade(srv.port, `/v1/sandboxes/${a.id}/events/ws?token=${teamA}`),
          /^HTTP\/1\.1 101/,
        );
      },
    );

    await t.test(
      'the event routes are guarded, audited and closed with 1001 at shutdown',
      async () => {
        assert.match(await rawUpgrade(srv.port, '/v1/events/ws'), /^HTTP\/1\.1 401/);
        assert.match(
          await rawUpgrade(srv.port, `/v1/events/ws?token=${TOKENS.read}`, {
            Origin: 'http://evil.example',
          }),
          /^HTTP\/1\.1 403/,
        );
        assert.match(
          await rawUpgrade(srv.port, `/v1/events/ws?types=a,,b&token=${TOKENS.read}`),
          /^HTTP\/1\.1 400/,
        );
        assert.match(
          await rawUpgrade(srv.port, `/v1/sandboxes/sb-nope/events/ws?token=${TOKENS.read}`),
          /^HTTP\/1\.1 404/,
        );
        assert.match(
          await rawUpgrade(srv.port, `/v1/nope/ws?token=${TOKENS.read}`),
          /^HTTP\/1\.1 404/,
        );
        for (const path of ['/v1/events/ws', `/v1/sandboxes/${a.id}/events/ws`]) {
          const plain = await api(TOKENS.read, 'GET', path);
          assert.equal(plain.status, 426, path);
        }
        const streams = srv.auditEntries().filter((e) => e.action === 'api.events.stream');
        assert.ok(streams.length >= 8, String(streams.length));
        assert.ok(streams.some((e) => e.actor === 'api:observer' && e.sandboxId === null));
        assert.ok(streams.some((e) => e.actor === `api:${minted.json.id}`));
        assert.ok(streams.some((e) => e.sandboxId === a.id && e.data.types[0] === 'bound.*'));
        const metrics = await api(TOKENS.read, 'GET', '/metrics');
        const ws = Number(/^workbox_ws_connections_total (\d+)$/m.exec(metrics.text)?.[1]);
        assert.ok(ws >= streams.length, `${ws} connections, ${streams.length} streams`);

        await until(
          () => srv.manager.listenerCount('logged') === idle,
          'every earlier stream to unsubscribe',
        );
        const listeners = idle;
        const pending = api(
          TOKENS.read,
          'GET',
          `/v1/events?afterSeq=${head()}&types=never.*&waitMs=60000`,
        );
        await until(() => srv.manager.listenerCount('logged') > listeners, 'the long-poll');
        const open = openStream(srv.base, `/v1/events/ws?token=${TOKENS.read}`);
        await until(() => open.lives().length === 1, 'a stream before shutdown');
        const t0 = Date.now();
        await srv.app.close({ timeoutMs: 5000 });
        await until(() => open.closeCode() !== null, 'the stream to close');
        assert.equal(open.closeCode(), 1001);
        const cut = await pending;
        assert.equal(cut.status, 200);
        assert.deepEqual(cut.json.events, []);
        assert.ok(
          Date.now() - t0 < 5000,
          'the long-poll ended with the server, not at its timeout',
        );
      },
    );
  } finally {
    await srv.stop();
  }
});
