import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { Manager, Store, loadConfig } from '@workbox/core';
import {
  EventFeed,
  EventHub,
  MAX_TYPE_PATTERNS,
  MAX_EVENT_WAIT_MS,
  REPLAY_PAGE,
  ReplayMerge,
  drained,
  eventFilter,
  eventsQuery,
  parseTypes,
  pollEvents,
  streamEvents,
  typeMatcher,
} from '../../src/streams.js';
import { WsSocket } from '../../src/ws.js';
import { tmpDir } from '../../../core/test/helpers/tmp.js';

const base = { rootfs: 'minimal', runtime: 'current', profile: { limits: { pids: 10 } } };
const search = (q) => new URLSearchParams(q);
const invalid = (path) => (e) =>
  e.code === 'E_INVALID_PARAMS' && e.data?.errors?.[0]?.path === path;

/**
 * A real Manager over a real in-memory store. Nothing here launches a sandbox: events are logged
 * through `manager.logEvent`, the path the broker takes for `wb event emit`.
 */
function engine() {
  const t = tmpDir('workbox-streams-');
  const store = Store.open(':memory:');
  const manager = new Manager({ config: loadConfig({ env: { WORKBOX_ROOT: t.dir } }), store });
  const hub = new EventHub(manager);
  const a = store.createSandbox({ ...base, labels: { team: 'a' } });
  const b = store.createSandbox({ ...base, labels: { team: 'b' } });
  return {
    store,
    manager,
    hub,
    a,
    b,
    log: (sb, type, payload = {}) => manager.logEvent(sb.id, type, payload),
    removeDir: t.cleanup,
    close() {
      manager.close();
      store.close();
      t.cleanup();
    },
  };
}

const teamA = { id: 'key_a', scopes: ['read'], binding: { labels: { team: 'a' } } };

test('types: comma-separated patterns, repeatable, trimmed, bounded', () => {
  assert.equal(parseTypes(search('')), undefined);
  assert.equal(parseTypes(search('types=')), undefined, 'an empty value means every type');
  assert.deepEqual(parseTypes(search('types=build.*, session.exited')), [
    'build.*',
    'session.exited',
  ]);
  assert.deepEqual(parseTypes(search('types=a.*&types=b,a.*')), ['a.*', 'b']);
  assert.throws(() => parseTypes(search('types=a,,b')), invalid('query.types'));
  assert.throws(() => parseTypes(search(`types=${'x'.repeat(129)}`)), invalid('query.types'));
  const many = Array.from({ length: MAX_TYPE_PATTERNS + 1 }, (_, i) => `t${i}`).join(',');
  assert.throws(() => parseTypes(search(`types=${many}`)), /at most 32 patterns/);
});

test('typeMatcher agrees with the store SQL on every pattern vector', () => {
  const store = Store.open(':memory:');
  try {
    const sb = store.createSandbox(base);
    const types = [
      'sandbox.created',
      'session.started',
      'build.done',
      'session.exited',
      'sessions.count',
      'session',
      'exec.finished',
      'a.b.c',
    ];
    for (const type of types) store.appendEvent(sb.id, type, {});
    const rows = store.listFleetEvents();
    for (const patterns of [
      undefined,
      [],
      ['session.*'],
      ['build.done', 'sandbox.*'],
      ['session.started', 'session.*'],
      ['session'],
      ['sessio.*'],
      ['*.created'],
      ['session*'],
      ['a.*'],
      ['a.b.*'],
      ['.*'],
    ]) {
      const match = typeMatcher(patterns);
      assert.deepEqual(
        rows.filter((r) => match(r.type)).map((r) => r.seq),
        store.listFleetEvents({ types: patterns }).map((r) => r.seq),
        JSON.stringify(patterns),
      );
    }
  } finally {
    store.close();
  }
});

test('eventsQuery: defaults, integers, the wait bound and the fleet-only sandboxId', () => {
  const url = (q) => new URL(`http://workbox/v1/events?${q}`);
  assert.deepEqual(eventsQuery(url('')), {
    afterSeq: undefined,
    limit: undefined,
    types: undefined,
    waitMs: 0,
  });
  assert.deepEqual(
    eventsQuery(url('afterSeq=7&limit=3&types=x.*&waitMs=60000&sandboxId=sb-1'), { fleet: true }),
    { afterSeq: 7, limit: 3, types: ['x.*'], waitMs: MAX_EVENT_WAIT_MS, sandboxId: 'sb-1' },
  );
  assert.equal(eventsQuery(url('sandboxId=sb-1')).sandboxId, undefined);
  assert.throws(() => eventsQuery(url('waitMs=60001')), invalid('query.waitMs'));
  assert.throws(() => eventsQuery(url('afterSeq=-1')), invalid('query.afterSeq'));
  assert.throws(() => eventsQuery(url('limit=1.5')), invalid('query.limit'));
});

test('eventFilter: types, sandbox, and a bound principal sees only visible sandboxes', () => {
  const e = engine();
  try {
    const row = (sb, type) => ({ seq: 1, sandboxId: sb.id, type });
    const all = eventFilter(e.store, {});
    assert.equal(all(row(e.b, 'x')), true);
    const typed = eventFilter(e.store, { types: ['build.*'], sandboxId: e.a.id });
    assert.equal(typed(row(e.a, 'build.done')), true);
    assert.equal(typed(row(e.a, 'session.exited')), false);
    assert.equal(typed(row(e.b, 'build.done')), false);
    const bound = eventFilter(e.store, { principal: teamA });
    assert.equal(bound(row(e.a, 'x')), true);
    assert.equal(bound(row(e.b, 'x')), false);
    assert.equal(bound({ seq: 2, sandboxId: 'sb-later', type: 'x' }), false);
    const later = e.store.createSandbox({ ...base, labels: { team: 'a' } });
    assert.equal(bound(row(later, 'x')), true, 'a sandbox not found is looked up again');
    for (let i = 0; i < 300; i++) e.store.createSandbox({ ...base, labels: { team: 'a' } });
    const crowd = e.store.listSandboxes({ limit: 1000 }).items;
    for (const sb of crowd) assert.equal(bound(row(sb, 'x')), sb.labels.team === 'a');
    assert.equal(bound(row(e.a, 'x')), true, 'an evicted row is read again');
  } finally {
    e.close();
  }
});

test('ReplayMerge: buffers live rows during the replay, then no gap and no duplicate', () => {
  const m = new ReplayMerge(10);
  assert.equal(m.replayed({ seq: 9 }), false, 'at or below the start');
  assert.equal(m.replayed({ seq: 11 }), true);
  assert.equal(m.live({ seq: 12 }), false, 'buffered while replaying');
  assert.equal(m.live({ seq: 14 }), false);
  assert.equal(m.live({ seq: 11 }), false, 'already replayed: not even buffered');
  assert.deepEqual(m.pending, [{ seq: 12 }, { seq: 14 }]);
  assert.equal(m.replayed({ seq: 12 }), true, 'the next page reaches a buffered row');
  m.trim();
  assert.deepEqual(m.pending, [{ seq: 14 }]);
  assert.equal(m.live({ seq: 13 }), false);
  assert.deepEqual(m.goLive(), [{ seq: 13 }, { seq: 14 }], 'in seq order');
  assert.equal(m.lastSeq, 14);
  assert.equal(m.live({ seq: 14 }), false, 'a duplicate after the switch');
  assert.equal(m.live({ seq: 15 }), true);
  assert.deepEqual(new ReplayMerge(0).goLive(), []);
});

test('EventHub: one manager listener while subscribed; a failing subscriber does not starve others', () => {
  const e = engine();
  try {
    const before = e.manager.listenerCount('logged');
    const seen = [];
    const off1 = e.hub.subscribe((row) => seen.push(['one', row.seq]));
    const off2 = e.hub.subscribe(() => {
      throw new Error('subscriber broke');
    });
    const off3 = e.hub.subscribe((row) => seen.push(['three', row.seq]));
    assert.equal(e.manager.listenerCount('logged'), before + 1);
    assert.equal(e.hub.size, 3);
    assert.throws(() => e.hub.onRow({ seq: 99 }), /subscriber broke/);
    assert.deepEqual(seen, [
      ['one', 99],
      ['three', 99],
    ]);
    const { seq } = e.log(e.a, 'hub.test');
    assert.deepEqual(seen.at(-1), ['three', seq], 'the manager logs the failure and goes on');
    off1();
    off2();
    off2();
    assert.equal(e.manager.listenerCount('logged'), before + 1);
    off3();
    assert.equal(e.manager.listenerCount('logged'), before);
    assert.equal(e.hub.size, 0);
  } finally {
    e.close();
  }
});

test('pollEvents: stored rows at once; a wait ends on a match, at the timeout or on abort', async () => {
  const e = engine();
  try {
    const first = e.log(e.a, 'poll.one');
    e.log(e.b, 'poll.two');
    const now = await pollEvents(e.hub, { types: ['poll.*'], waitMs: 5000 });
    assert.deepEqual(
      now.events.map((r) => r.type),
      ['poll.one', 'poll.two'],
    );
    assert.equal(now.nextSeq, now.events[1].seq);
    const bound = await pollEvents(e.hub, { principal: teamA, limit: 1 });
    assert.deepEqual(
      bound.events.map((r) => r.seq),
      [first.seq],
    );

    const head = e.store.lastEventSeq();
    const waiting = pollEvents(e.hub, {
      afterSeq: head,
      types: ['poll.*'],
      waitMs: 10_000,
      principal: teamA,
    });
    assert.equal(e.hub.size, 1);
    e.log(e.a, 'other.type');
    e.log(e.b, 'poll.hidden');
    assert.equal(e.hub.size, 1, 'rows that do not match keep it waiting');
    const started = Date.now();
    const woke = e.log(e.a, 'poll.three');
    const answer = await waiting;
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(answer, { events: [woke], nextSeq: woke.seq });
    assert.equal(e.hub.size, 0, 'the subscription is gone');

    const t0 = Date.now();
    const empty = await pollEvents(e.hub, { afterSeq: woke.seq, types: ['none.*'], waitMs: 150 });
    assert.ok(Date.now() - t0 >= 140, 'waited for the timeout');
    assert.deepEqual(empty, { events: [], nextSeq: woke.seq });
    assert.equal(e.hub.size, 0);

    const ac = new AbortController();
    const cut = pollEvents(e.hub, { afterSeq: woke.seq, waitMs: 60_000 }, { signal: ac.signal });
    ac.abort();
    assert.deepEqual(await cut, { events: [], nextSeq: woke.seq });
    assert.equal(e.hub.size, 0);
    assert.deepEqual(
      await pollEvents(e.hub, { afterSeq: woke.seq, waitMs: 60_000 }, { signal: ac.signal }),
      { events: [], nextSeq: woke.seq },
      'an aborted signal does not wait at all',
    );
    const ahead = pollEvents(e.hub, { afterSeq: woke.seq + 5, waitMs: 200 });
    e.log(e.a, 'below.cursor');
    assert.deepEqual(await ahead, { events: [], nextSeq: woke.seq + 5 });
  } finally {
    e.close();
  }
});

test('EventFeed: a multi-page replay with live rows during it switches with no gap or duplicate', async () => {
  const e = engine();
  try {
    const start = e.store.lastEventSeq();
    e.store.tx(() => {
      for (let i = 0; i < REPLAY_PAGE * 2 + 17; i++) e.log(i % 3 ? e.a : e.b, 'bulk.row', { i });
    });
    const sent = [];
    const lives = [];
    let ticks = 0;
    const feed = new EventFeed(
      e.hub,
      { afterSeq: start, types: ['bulk.*'] },
      {
        send: (row) => sent.push(row.seq),
        ready: () => {
          ticks += 1;
          if (ticks % 200 !== 0 && ticks !== REPLAY_PAGE * 2 + 5) return null;
          e.log(e.a, 'bulk.live', { during: ticks });
          e.log(e.b, 'skip.me');
          return new Promise((resolve) => setImmediate(resolve));
        },
        live: (seq) => lives.push(seq),
      },
    );
    await feed.start();
    const after = e.log(e.b, 'bulk.after');
    const expected = [];
    for (let cursor = start; ; ) {
      const page = e.store.listFleetEvents({ afterSeq: cursor, types: ['bulk.*'], limit: 1000 });
      expected.push(...page.map((r) => r.seq));
      if (page.length < 1000) break;
      cursor = page.at(-1).seq;
    }
    assert.ok(ticks >= REPLAY_PAGE * 2 + 17, String(ticks));
    assert.equal(expected.length, REPLAY_PAGE * 2 + 17 + 6 + 1, 'bulk, live during it, after');
    assert.deepEqual(sent, expected);
    assert.equal(sent.at(-1), after.seq);
    assert.equal(lives.length, 1);
    assert.ok(lives[0] >= sent.at(-2) && lives[0] < after.seq, String(lives[0]));
    feed.close();
    e.log(e.a, 'bulk.closed');
    assert.equal(sent.at(-1), after.seq, 'nothing after close');
    assert.equal(e.hub.size, 0);
  } finally {
    e.close();
  }
});

test('EventFeed: live only without afterSeq, filtered for a bound principal; close mid-replay', async () => {
  const e = engine();
  try {
    e.log(e.a, 'old.row');
    const sent = [];
    const lives = [];
    const feed = new EventFeed(
      e.hub,
      { principal: teamA },
      { send: (row) => sent.push(row), live: (seq) => lives.push(seq) },
    );
    await feed.start();
    assert.deepEqual(lives, [e.store.lastEventSeq()]);
    e.log(e.b, 'hidden.row');
    const shown = e.log(e.a, 'new.row');
    assert.deepEqual(sent, [shown]);
    feed.close();

    for (let i = 0; i < REPLAY_PAGE + 5; i++) e.log(e.a, 'more.row');
    const partial = [];
    let early = null;
    early = new EventFeed(
      e.hub,
      { afterSeq: 0 },
      {
        send: (row) => {
          partial.push(row.seq);
          if (partial.length === 3) early.close();
        },
        ready: () => (partial.length === 3 ? Promise.resolve() : null),
      },
    );
    await early.start();
    assert.equal(partial.length, 3);
    assert.equal(e.hub.size, 0);
    const never = new EventFeed(e.hub, {}, { send: () => assert.fail('closed first') });
    never.close();
    await never.start();
    assert.equal(e.hub.size, 0);
  } finally {
    e.close();
  }
});

test('drained: null while a stream takes writes, settles on drain or close', async () => {
  assert.equal(drained(new PassThrough()), null);
  let release = null;
  const slow = new Writable({
    highWaterMark: 4,
    write(_chunk, _enc, cb) {
      release = cb;
    },
  });
  slow.write('12345678');
  const wait = drained(slow);
  assert.ok(wait instanceof Promise);
  release();
  await wait;
  const stuck = new Writable({ highWaterMark: 4, write() {} });
  stuck.write('12345678');
  const closing = drained(stuck);
  stuck.destroy();
  await closing;
  assert.equal(drained(stuck), null, 'a destroyed stream never blocks');
});

/** A real TCP pair: the server end wrapped in WsSocket; the client end collects text frames. */
async function wsPair() {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const client = net.connect(srv.address().port, '127.0.0.1');
  const [sock] = await once(srv, 'connection');
  const ws = new WsSocket(sock, Buffer.alloc(0));
  const frames = [];
  let buf = Buffer.alloc(0);
  client.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      if (buf.length < off + len) return;
      const opcode = buf[0] & 0x0f;
      const payload = buf.subarray(off, off + len);
      frames.push(opcode === 0x1 ? JSON.parse(payload.toString()) : { opcode, payload });
      buf = buf.subarray(off + len);
    }
  });
  return { srv, client, ws, frames };
}

async function until(fn, what) {
  const deadline = Date.now() + 5000;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('streamEvents: event frames, one live frame, and the feed ends with the socket', async () => {
  const e = engine();
  const p = await wsPair();
  try {
    const before = e.log(e.a, 'ws.before');
    const done = streamEvents(e.hub, p.ws, { afterSeq: before.seq - 1, types: ['ws.*'] });
    await done;
    const during = e.log(e.a, 'ws.live');
    await until(() => p.frames.length === 3, 'three frames');
    assert.deepEqual(p.frames, [
      { type: 'event', event: before },
      { type: 'live', seq: before.seq },
      { type: 'event', event: during },
    ]);
    assert.equal(e.hub.size, 1);
    p.client.destroy();
    await until(() => p.ws.closed, 'the server end to close');
    assert.equal(e.hub.size, 0, 'the subscription went with the socket');
  } finally {
    p.client.destroy();
    p.srv.close();
    e.close();
  }
});

test('streamEvents: a feed that fails sends an error frame and closes 1011', async () => {
  const e = engine();
  const p = await wsPair();
  try {
    e.store.close();
    await streamEvents(e.hub, p.ws, { afterSeq: 0 });
    await until(() => p.frames.length === 2, 'error and close frames');
    assert.equal(p.frames[0].type, 'error');
    assert.equal(p.frames[1].opcode, 0x8);
    assert.equal(p.frames[1].payload.readUInt16BE(0), 1011);
    assert.equal(e.hub.size, 0);
  } finally {
    p.client.destroy();
    p.srv.close();
    e.manager.close();
    e.removeDir();
  }
});
