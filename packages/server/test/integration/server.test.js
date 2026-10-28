import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootServer, call, TOKENS } from '../helpers/real-server.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

/** Open a session WebSocket and collect its messages until `done` holds. */
function wsSession(base, sandboxId, sessionId, { send = [], done }) {
  const ws = new WebSocket(
    `${base.replace('http', 'ws')}/v1/sandboxes/${sandboxId}/sessions/${sessionId}/ws?token=${TOKENS.exec}`,
  );
  const messages = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket timed out; got ${JSON.stringify(messages)}`));
    }, 30_000);
    ws.addEventListener('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`websocket error ${e.message ?? ''}`));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      messages.push(msg);
      if (msg.type === 'ready') for (const m of send) ws.send(JSON.stringify(m));
      if (done(messages)) {
        clearTimeout(timer);
        ws.close();
        resolve(messages);
      }
    });
  });
}

test('server over a real engine: lifecycle, exec, files, sessions, asks, checkpoints, audit', async (t) => {
  const srv = await bootServer();
  const api = (token, method, path, body) => call(srv.port, { token, method, path, body });
  try {
    const created = await Promise.all(
      ['srv-a', 'srv-b'].map((name) => api(TOKENS.admin, 'POST', '/v1/sandboxes', { name })),
    );
    for (const c of created) assert.equal(c.status, 201, c.text);
    const [a, b] = created.map((c) => c.json);
    assert.equal(a.state, 'READY');

    await t.test('inventory pages with a cursor and a complete flag', async () => {
      const first = await api(TOKENS.read, 'GET', '/v1/sandboxes?limit=1');
      assert.equal(first.json.items.length, 1);
      assert.equal(first.json.complete, false);
      assert.ok(first.json.cursor);
      const rest = await api(
        TOKENS.read,
        'GET',
        `/v1/sandboxes?limit=1&cursor=${first.json.cursor}`,
      );
      assert.equal(rest.json.items.length, 1);
      assert.notEqual(rest.json.items[0].id, first.json.items[0].id);
      const all = await api(TOKENS.read, 'GET', '/v1/sandboxes');
      assert.equal(all.json.complete, true);
      assert.equal(all.json.cursor, null);
      assert.deepEqual(all.json.items.map((s) => s.id).sort(), [a.id, b.id].sort());
    });

    await t.test(
      'inspect reports desired state, observed health and last observation apart',
      async () => {
        const ins = (await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}`)).json;
        assert.equal(ins.desired, 'READY');
        assert.equal(ins.health, 'HEALTHY');
        assert.equal(typeof ins.lastObservedAt, 'number');
      },
    );

    await t.test('exec runs in the sandbox; a read key can neither exec nor destroy', async () => {
      const denied = await api(TOKENS.read, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: ['true'],
      });
      assert.equal(denied.status, 403);
      assert.equal((await api(TOKENS.read, 'DELETE', `/v1/sandboxes/${a.id}`)).status, 403);
      const out = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: ['sh', '-c', 'echo "uid=$(id -u) host=$(hostname)"; echo err >&2; exit 3'],
      });
      assert.equal(out.status, 200, out.text);
      assert.match(out.json.stdout, /^uid=\d+ host=/);
      assert.equal(out.json.stderr, 'err\n');
      assert.equal(out.json.exitCode, 3);
    });

    await t.test('files write, read and list through the runner', async () => {
      const put = await api(TOKENS.exec, 'PUT', `/v1/sandboxes/${a.id}/files`, {
        path: '/tmp/api/hello.txt',
        data: b64('hello from the api\n'),
        mkdirs: true,
      });
      assert.equal(put.status, 200, put.text);
      assert.equal(put.json.bytes, 19);
      const read = await api(
        TOKENS.read,
        'GET',
        `/v1/sandboxes/${a.id}/files?path=/tmp/api/hello.txt`,
      );
      assert.equal(Buffer.from(read.json.data, 'base64').toString(), 'hello from the api\n');
      assert.equal(read.json.eof, true);
      const list = await api(
        TOKENS.read,
        'GET',
        `/v1/sandboxes/${a.id}/files?path=/tmp/api&list=1`,
      );
      assert.deepEqual(list.json.entries, [{ name: 'hello.txt', type: 'file' }]);
      const cat = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: ['cat', '/tmp/api/hello.txt'],
      });
      assert.equal(cat.json.stdout, 'hello from the api\n');
      const missing = await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}/files?path=/nope`);
      assert.equal(missing.status, 404);
    });

    await t.test('a session streams over a WebSocket and takes input', async () => {
      const started = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/sessions`, {
        argv: ['sh', '-c', 'read line; echo "got:$line"'],
        name: 'echo-back',
      });
      assert.equal(started.status, 201, started.text);
      const { sessionId } = started.json;
      const messages = await wsSession(srv.base, a.id, sessionId, {
        send: [{ type: 'input', data: b64('ping\n') }],
        done: (ms) => ms.some((m) => m.type === 'session.exit'),
      });
      assert.equal(messages[0].type, 'ready');
      const out = messages
        .filter((m) => m.type === 'session.output')
        .map((m) => Buffer.from(m.params.data, 'base64').toString())
        .join('');
      assert.equal(out, 'got:ping\n');
      assert.equal(messages.find((m) => m.type === 'session.exit').params.code, 0);
      const sessions = await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}/sessions`);
      assert.ok(sessions.json.sessions.some((s) => s.sessionId === sessionId));
    });

    await t.test('an ask raised in the box is listed and answered through the API', async () => {
      const raised = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: ['wb', 'ask', 'raise', '--json', '--kind', 'question', 'Which branch?'],
      });
      assert.equal(raised.json.exitCode, 0, raised.json.stderr);
      const { askId } = lastJson(raised.json.stdout);
      const open = await api(TOKENS.read, 'GET', `/v1/asks?status=open&sandboxId=${a.id}`);
      assert.deepEqual(
        open.json.asks.map((x) => x.askId),
        [askId],
      );
      const byRead = await api(TOKENS.read, 'POST', `/v1/asks/${askId}/answer`, { answer: 'x' });
      assert.equal(byRead.status, 403);
      const answered = await api(TOKENS.answer, 'POST', `/v1/asks/${askId}/answer`, {
        answer: 'main',
      });
      assert.equal(answered.status, 200, answered.text);
      assert.equal(answered.json.status, 'answered');
      const seen = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: ['wb', 'ask', 'status', askId, '--json'],
      });
      const status = lastJson(seen.json.stdout);
      assert.equal(status.status, 'answered');
      assert.equal(status.answer, 'main');
      const again = await api(TOKENS.answer, 'POST', `/v1/asks/${askId}/answer`, { answer: 'x' });
      assert.equal(again.status, 409);
    });

    await t.test('events, evidence and artifacts list per sandbox', async () => {
      const emit = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: ['wb', 'event', 'emit', 'build.started', '{"step":1}', '--json'],
      });
      assert.equal(emit.json.exitCode, 0, emit.json.stderr);
      const put = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${a.id}/exec`, {
        argv: [
          'sh',
          '-c',
          'echo artifact-body > /tmp/out.txt && wb artifact put /tmp/out.txt --json',
        ],
      });
      assert.equal(put.json.exitCode, 0, put.json.stderr);
      const events = await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}/events?afterSeq=0`);
      assert.ok(events.json.events.some((e) => e.type === 'build.started'));
      const artifacts = await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}/artifacts?limit=10`);
      assert.equal(artifacts.json.complete, true);
      assert.equal(artifacts.json.items.length, 1);
      const evidence = await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}/evidence`);
      assert.ok(Array.isArray(evidence.json.items));
      assert.equal(typeof evidence.json.complete, 'boolean');
      const foreign = await api(TOKENS.read, 'GET', `/v1/sandboxes/${b.id}/artifacts`);
      assert.deepEqual(foreign.json.items, []);
    });

    await t.test('checkpoints create and list', async () => {
      const cp = await api(TOKENS.admin, 'POST', `/v1/sandboxes/${a.id}/checkpoints`, {
        name: 'api-cp',
      });
      assert.equal(cp.status, 201, cp.text);
      const list = await api(TOKENS.read, 'GET', `/v1/sandboxes/${a.id}/checkpoints`);
      assert.equal(list.json.checkpoints.length, 1);
      assert.equal(list.json.checkpoints[0].name, 'api-cp');
    });

    await t.test('drain, reconcile and delete', async () => {
      const drained = await api(TOKENS.admin, 'POST', `/v1/sandboxes/${b.id}/drain`, {
        reason: 'api test',
      });
      assert.equal(drained.status, 200, drained.text);
      assert.equal(drained.json.state, 'DRAINING');
      const rec = await api(TOKENS.admin, 'POST', '/v1/reconcile');
      assert.equal(rec.status, 200, rec.text);
      const seen = [...rec.json.attached, ...rec.json.suspect, ...rec.json.absent];
      assert.ok(seen.includes(a.id) && seen.includes(b.id), JSON.stringify(rec.json));
      for (const s of [a, b]) {
        const del = await api(TOKENS.admin, 'DELETE', `/v1/sandboxes/${s.id}`);
        assert.equal(del.status, 200, del.text);
        assert.equal(del.json.state, 'DELETED');
      }
      const left = await api(TOKENS.read, 'GET', '/v1/sandboxes');
      assert.deepEqual(left.json.items, []);
      const metrics = await api(TOKENS.read, 'GET', '/metrics');
      assert.match(metrics.text, /workbox_sandboxes\{state="DELETED"\} 2/);
      assert.match(metrics.text, /workbox_ws_connections_total 1/);
    });

    await t.test('every mutating request is audited and logged', () => {
      const actions = new Set(srv.auditEntries().map((e) => e.action));
      for (const action of [
        'api.sandbox.create',
        'api.sandbox.exec',
        'api.file.write',
        'api.session.start',
        'api.session.attach',
        'api.ask.answer',
        'api.checkpoint.create',
        'api.sandbox.drain',
        'api.reconcile',
        'api.sandbox.destroy',
      ])
        assert.ok(actions.has(action), action);
      const denied = srv
        .auditEntries()
        .find((e) => e.action === 'api.sandbox.exec' && e.data.outcome === 'E_DENIED');
      assert.equal(denied.actor, 'api:observer');
      assert.equal(denied.sandboxId, a.id);
      assert.ok(srv.logs.every((l) => l.msg === 'request' && l.requestId && l.status));
    });
  } finally {
    await srv.stop();
  }
});
