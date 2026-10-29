import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PassThrough, Duplex } from 'node:stream';
import { Peer } from '@workbox/protocol';
import { SessionManager, DEFAULT_STOP_GRACE_MS, secretRedactor } from '../../src/sessions.js';
import { bootFixture } from '../helpers/boot.js';

test('secretRedactor labels each injected value by its variable name', () => {
  assert.equal(secretRedactor(undefined), null);
  assert.equal(secretRedactor({}), null);
  const r = secretRedactor({ DEPLOY_TOKEN: 'tok-12345678', LONGER_TOKEN: 'tok-123456789' });
  assert.equal(r.size, 2);
  assert.equal(
    r.apply('a tok-12345678 b tok-123456789 c'),
    'a [REDACTED:DEPLOY_TOKEN] b [REDACTED:LONGER_TOKEN] c',
  );
});

/** A Peer whose far side records every event it receives. */
function recordingPeer() {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const far = new Duplex({
    read() {},
    write(c, _e, cb) {
      ba.write(c, cb);
    },
  });
  ab.on('data', (c) => far.push(c));
  const near = new Duplex({
    read() {},
    write(c, _e, cb) {
      ab.write(c, cb);
    },
  });
  ba.on('data', (c) => near.push(c));
  const peer = new Peer(near, { name: 'near' });
  const farPeer = new Peer(far, { name: 'far' });
  const events = [];
  farPeer.on('event', (m, p) => events.push([m, p]));
  return { peer, events, close: () => (peer.close(), farPeer.close()) };
}

const until = async (fn, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('a secret a child writes in two separate writes never reaches the spool', async () => {
  const secret = 'wbx-split-0123456789abcdef';
  const b64 = Buffer.from(secret).toString('base64');
  const script = [
    'v=$DEPLOY_TOKEN',
    `printf 'before %s' "$(printf %s "$v" | head -c 9)"`,
    'sleep 0.2',
    `printf '%s after\\n' "$(printf %s "$v" | tail -c +10)"`,
    'sleep 0.1',
    `b=$(printf %s "$v" | base64 | tr -d '\\n')`,
    `printf 'b64 %s' "$(printf %s "$b" | head -c 10)" >&2`,
    'sleep 0.2',
    `printf '%s done\\n' "$(printf %s "$b" | tail -c +11)" >&2`,
    'sleep 0.1',
    `printf 'bye now w'`,
  ].join('\n');
  const sm = new SessionManager();
  const exits = [];
  sm.on('exit', (i) => exits.push(i));
  const info = await sm.start({ argv: ['sh', '-c', script], secretEnv: { DEPLOY_TOKEN: secret } });
  const live = recordingPeer();
  await sm.attach(info.sessionId, live.peer, 0);
  await until(() => exits.length === 1);
  await until(() => live.events.some(([m]) => m === 'session.exit'));
  assert.equal(exits[0].code, 0);

  const replay = sm.get(info.sessionId).spool.replayFrom(0).chunks;
  assert.deepEqual(
    replay.map((c) => [c.stream, c.data.toString()]),
    [
      ['stdout', 'before '],
      ['stdout', '[REDACTED:DEPLOY_TOKEN] after\n'],
      ['stderr', 'b64 '],
      ['stderr', '[REDACTED:DEPLOY_TOKEN] done\n'],
      ['stdout', 'bye now '],
      ['stdout', 'w'],
    ],
    'each write arrived on its own; only a possible start was held, and the tail flushed at exit',
  );
  assert.equal(exits[0].seq, replay.length, 'the flushed tail is spooled before the exit');
  const text = Buffer.concat(replay.map((c) => c.data)).toString();
  for (const trace of [secret, secret.slice(0, 9), secret.slice(9), b64, b64.slice(0, 10)])
    assert.equal(text.includes(trace), false, `no ${trace} in the spool`);
  assert.equal(text.includes(b64.slice(10)), false);

  const names = live.events.map(([m]) => m);
  assert.equal(names.at(-1), 'session.exit', 'nothing is delivered after the exit');
  const delivered = live.events
    .filter(([m]) => m === 'session.output')
    .map(([, p]) => Buffer.from(p.data, 'base64').toString())
    .join('');
  assert.equal(delivered, text, 'subscribers get the same redacted output, in order');
  live.close();
});

test('start, output ordering across streams, exit, list, remove', async () => {
  const sm = new SessionManager({ clock: () => 42 });
  const started = [];
  const exits = [];
  sm.on('started', (i) => started.push(i));
  sm.on('exit', (i) => exits.push(i));
  const info = await sm.start({
    argv: ['sh', '-c', 'printf out1; printf err1 >&2; sleep 0.05; printf out2; exit 3'],
    name: 'demo',
  });
  assert.equal(info.name, 'demo');
  assert.ok(info.pid > 0);
  assert.equal(info.startedAt, 42);
  assert.deepEqual(started, [info]);
  await until(() => exits.length === 1);
  assert.deepEqual(exits[0], { sessionId: info.sessionId, code: 3, signal: null, seq: 3, at: 42 });
  const s = sm.get(info.sessionId);
  const replay = s.spool.replayFrom(0);
  assert.deepEqual(
    replay.chunks.map((c) => [c.stream, c.data.toString()]),
    [
      ['stdout', 'out1'],
      ['stderr', 'err1'],
      ['stdout', 'out2'],
    ],
  );
  const listed = sm.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].exited.code, 3);
  assert.equal(listed[0].seq, 3);
  assert.equal(listed[0].attached, 0);
  assert.equal(sm.liveCount, 0);
  assert.deepEqual(sm.remove(info.sessionId), { sessionId: info.sessionId, removed: true });
  assert.throws(
    () => sm.get(info.sessionId),
    (e) => e.code === 'E_NOT_FOUND',
  );
  assert.equal(DEFAULT_STOP_GRACE_MS, 5000);
});

test('read returns retained output in pages without subscribing, then the exit', async () => {
  const sm = new SessionManager();
  const info = await sm.start({
    argv: ['sh', '-c', 'printf aaaa; sleep 0.05; printf bb >&2; sleep 0.05; printf cccccc; exit 4'],
  });
  await until(() => sm.get(info.sessionId).exited !== null);
  const text = (r) =>
    r.chunks.map((c) => [c.seq, c.stream, Buffer.from(c.data, 'base64').toString()]);
  const all = sm.read(info.sessionId);
  assert.deepEqual(text(all), [
    [0, 'stdout', 'aaaa'],
    [1, 'stderr', 'bb'],
    [2, 'stdout', 'cccccc'],
  ]);
  assert.equal(all.sessionId, info.sessionId);
  assert.equal(all.nextSeq, 3);
  assert.equal(all.gap, null);
  assert.equal(all.truncated, false);
  assert.equal(all.exited.code, 4);
  assert.equal(sm.get(info.sessionId).subscribers.size, 0, 'a read subscribes nobody');
  const first = sm.read(info.sessionId, { maxBytes: 6 });
  assert.deepEqual(text(first), [
    [0, 'stdout', 'aaaa'],
    [1, 'stderr', 'bb'],
  ]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextSeq, 2);
  const one = sm.read(info.sessionId, { fromSeq: 2, maxBytes: 1 });
  assert.deepEqual(text(one), [[2, 'stdout', 'cccccc']], 'a chunk over the budget still comes');
  assert.equal(one.truncated, false);
  const end = sm.read(info.sessionId, { fromSeq: 3 });
  assert.deepEqual(end.chunks, []);
  assert.equal(end.nextSeq, 3);
  assert.equal(sm.read(info.sessionId, { fromSeq: 99 }).nextSeq, 3);
  assert.throws(
    () => sm.read('missing'),
    (e) => e.code === 'E_NOT_FOUND',
  );
});

test('read reports the gap left by spool overflow and a chunk cut to the spool limit', async () => {
  const sm = new SessionManager({ defaultSpoolBytes: 16 });
  const info = await sm.start({
    argv: ['sh', '-c', 'printf 0123456789; sleep 0.1; printf abcdefghij'],
  });
  await until(() => sm.get(info.sessionId).exited !== null);
  const r = sm.read(info.sessionId);
  assert.deepEqual(r.gap, { requested: 0, available: 1 });
  assert.deepEqual(
    r.chunks.map((c) => [c.seq, Buffer.from(c.data, 'base64').toString()]),
    [[1, 'abcdefghij']],
  );
  assert.equal(r.nextSeq, 2);
  assert.equal(r.truncated, false);
  const small = new SessionManager({ defaultSpoolBytes: 8 });
  const big = await small.start({ argv: ['sh', '-c', 'printf 0123456789abcdef'] });
  await until(() => small.get(big.sessionId).exited !== null);
  const cut = small.read(big.sessionId);
  assert.equal(Buffer.from(cut.chunks[0].data, 'base64').toString(), '89abcdef');
  assert.equal(cut.truncated, true, 'a chunk that lost its start to the spool limit');
});

test('attach replays, streams live, reports gaps after overflow and exit to late attachers', async () => {
  const sm = new SessionManager({ defaultSpoolBytes: 64 });
  const info = await sm.start({
    argv: [
      'sh',
      '-c',
      'for i in 1 2 3 4 5 6 7 8 9 10; do printf "chunk-%02d-xxxxxxxxxx\\n" $i; sleep 0.05; done; sleep 0.3; echo tail',
    ],
  });
  await until(
    () =>
      sm
        .get(info.sessionId)
        .spool.replayFrom(0)
        .chunks.reduce((n, c) => n + c.data.length, 0) >= 200 ||
      sm.get(info.sessionId).spool.stats().totalBytes >= 200,
  );
  const r = recordingPeer();
  const att = await sm.attach(info.sessionId, r.peer, 0);
  assert.ok(att.gap, 'early output was evicted from a 64 byte spool');
  assert.equal(att.gap.requested, 0);
  assert.equal(att.replayedFrom, att.gap.available);
  assert.ok(att.replayed >= 1);
  await until(() => r.events.some(([m]) => m === 'session.exit'));
  const outputs = r.events
    .filter(([m]) => m === 'session.output')
    .map(([, p]) => Buffer.from(p.data, 'base64').toString());
  assert.ok(outputs.join('').endsWith('tail\n'), 'live output after replay');
  const seqs = r.events.filter(([m]) => m === 'session.output').map(([, p]) => p.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  const late = recordingPeer();
  const lateAtt = await sm.attach(info.sessionId, late.peer, 0);
  assert.ok(lateAtt.exited);
  await until(() => late.events.some(([m]) => m === 'session.exit'));
  assert.equal(sm.get(info.sessionId).subscribers.size, 0, 'exited sessions keep no subscribers');
  assert.deepEqual(sm.detach(info.sessionId, late.peer), {
    sessionId: info.sessionId,
    detached: false,
  });
  r.close();
  late.close();
});

test('input, eof, signal, detach and stop escalation with a TERM-ignoring child', async () => {
  const sm = new SessionManager({ stopGraceMs: 200 });
  const cat = await sm.start({ argv: ['cat'] });
  const r = recordingPeer();
  await sm.attach(cat.sessionId, r.peer);
  assert.deepEqual(
    await sm.input(cat.sessionId, { data: Buffer.from('hello').toString('base64') }),
    { sessionId: cat.sessionId, bytes: 5, eof: false },
  );
  await until(() => r.events.length >= 1);
  assert.equal(Buffer.from(r.events[0][1].data, 'base64').toString(), 'hello');
  assert.deepEqual(sm.detach(cat.sessionId, r.peer), { sessionId: cat.sessionId, detached: true });
  await sm.input(cat.sessionId, { eof: true });
  await until(() => sm.get(cat.sessionId).exited);
  assert.equal(sm.get(cat.sessionId).exited.code, 0);
  await assert.rejects(sm.input(cat.sessionId, { data: 'eA==' }), (e) => e.code === 'E_STATE');
  assert.throws(
    () => sm.signal(cat.sessionId, 'SIGTERM'),
    (e) => e.code === 'E_STATE',
  );
  assert.deepEqual(await sm.stop(cat.sessionId), {
    sessionId: cat.sessionId,
    exited: sm.get(cat.sessionId).exited,
    escalated: false,
  });

  const stubborn = await sm.start({ argv: ['sh', '-c', 'trap "" TERM; echo ready; sleep 30'] });
  await until(() => sm.get(stubborn.sessionId).spool.nextSeq >= 1);
  const t0 = Date.now();
  const stopped = await sm.stop(stubborn.sessionId);
  assert.equal(stopped.escalated, true);
  assert.equal(stopped.exited.signal, 'SIGKILL');
  assert.ok(Date.now() - t0 >= 200);

  const grp = await sm.start({ argv: ['sh', '-c', 'sleep 30 & sleep 30 & wait'] });
  await new Promise((res) => setTimeout(res, 100));
  const childPids = fs
    .readdirSync('/proc')
    .filter((d) => /^\d+$/.test(d))
    .filter((pid) => {
      try {
        return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[3] === String(grp.pid);
      } catch {
        return false;
      }
    });
  assert.equal(childPids.length, 2, 'two sleeps in the session process group');
  assert.deepEqual(sm.signal(grp.sessionId, 'SIGKILL'), {
    sessionId: grp.sessionId,
    signal: 'SIGKILL',
  });
  await until(() => sm.get(grp.sessionId).exited);
  await until(() => childPids.every((pid) => !fs.existsSync(`/proc/${pid}`)), 2000);
  assert.deepEqual(sm.remove(stubborn.sessionId), {
    sessionId: stubborn.sessionId,
    removed: true,
  });
  assert.deepEqual(sm.remove(cat.sessionId), { sessionId: cat.sessionId, removed: true });
  assert.deepEqual(sm.remove(grp.sessionId), { sessionId: grp.sessionId, removed: true });
  r.close();
});

test('errors: bad argv, bad cwd, pty, secrets, stopAll', async () => {
  const sm = new SessionManager();
  await assert.rejects(
    sm.start({ argv: ['definitely-not-a-binary-xyz'] }),
    (e) => e.code === 'E_NOT_FOUND' && e.data.errno === 'ENOENT',
  );
  await assert.rejects(
    sm.start({ argv: ['sh'], cwd: '/nonexistent-dir' }),
    (e) => e.code === 'E_NOT_FOUND',
  );
  const pty = await sm.start({
    argv: ['sh', '-c', 'test -t 0 && echo tty || echo notty'],
    pty: true,
    rows: 10,
    cols: 40,
  });
  await until(() => sm.get(pty.sessionId).exited);
  const ptyText = sm
    .get(pty.sessionId)
    .spool.replayFrom(0)
    .chunks.map((c) => c.data.toString())
    .join('');
  assert.match(ptyText, /tty/);
  assert.doesNotMatch(ptyText, /notty/, 'stdin of a pty session is a terminal');
  await assert.rejects(
    sm.start({ argv: ['sh'], secretRefs: ['x'] }),
    (e) => e.code === 'E_UNSUPPORTED',
  );
  await assert.rejects(sm.start({ argv: ['/etc/passwd'] }), (e) => e.code === 'E_DENIED');
  const fx = bootFixture();
  const a = await sm.start({ argv: ['sleep', '30'] });
  const b = await sm.start({ argv: ['sleep', '30'] });
  assert.equal(sm.liveCount, 2);
  assert.throws(
    () => sm.remove(a.sessionId),
    (e) => e.code === 'E_STATE',
  );
  assert.equal(await sm.stopAll({ graceMs: 100 }), 2);
  assert.equal(sm.liveCount, 0);
  assert.equal(sm.get(b.sessionId).exited.signal, 'SIGTERM');
  fx.cleanup();
});

/** True when this process may start children under another uid (root on a bare host). */
function canSwitchUid() {
  const r = spawnSync('true', [], { uid: 65534, gid: 65534 });
  return !r.error && r.status === 0;
}

test(
  'uid and gid switching with a clean environment',
  { skip: canSwitchUid() ? false : 'this host cannot setuid to 65534; not run' },
  async () => {
    const sm = new SessionManager();
    const who = await sm.start({
      argv: [
        'sh',
        '-c',
        'id -u; id -g; echo $CUSTOM; test -n "$HOME" && echo "$HOME" || echo unset',
      ],
      uid: 65534,
      gid: 65534,
      env: { CUSTOM: 'yes' },
      inheritEnv: false,
      cwd: '/',
    });
    await until(() => sm.get(who.sessionId).exited);
    const text = sm
      .get(who.sessionId)
      .spool.replayFrom(0)
      .chunks.map((c) => c.data.toString())
      .join('');
    assert.equal(
      text,
      '65534\n65534\nyes\nunset\n',
      'runs as nobody and inherits nothing it was not given',
    );
    assert.equal(sm.get(who.sessionId).exited.code, 0);
  },
);
