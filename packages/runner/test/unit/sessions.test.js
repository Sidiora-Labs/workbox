import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PassThrough, Duplex } from 'node:stream';
import { Peer } from '@workbox/protocol';
import { SessionManager, DEFAULT_STOP_GRACE_MS } from '../../src/sessions.js';
import { bootFixture } from '../helpers/boot.js';

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
