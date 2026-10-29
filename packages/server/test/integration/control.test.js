import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { bootServer, call, KEYS, TOKENS } from '../helpers/real-server.js';
import { createServer, FILE_CHUNK_BYTES } from '../../src/server.js';

const MiB = 1024 * 1024;
const b64 = (s) => Buffer.from(s).toString('base64');
const text = (chunks, stream) =>
  chunks
    .filter((c) => !stream || c.stream === stream)
    .map((c) => Buffer.from(c.data, 'base64').toString())
    .join('');
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

/**
 * One request whose body is written as the given pieces (chunked when no length is given);
 * resolves with the status, headers and the body as a Buffer. Once the answer has come, writing
 * stops and a connection the server then closes is not an error.
 * @param {number} port
 * @param {{method?: string, path: string, token?: string, pieces?: Buffer[], length?: number}} req
 */
function rawCall(port, req) {
  const headers = { host: `127.0.0.1:${port}` };
  if (req.token) headers.authorization = `Bearer ${req.token}`;
  if (req.length !== undefined) headers['content-length'] = String(req.length);
  let answered = false;
  return new Promise((resolve, reject) => {
    const r = http.request(
      {
        host: '127.0.0.1',
        port,
        method: req.method ?? 'GET',
        path: req.path,
        headers,
        agent: false,
      },
      (res) => {
        answered = true;
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(body.toString());
          } catch {
            // a byte body
          }
          resolve({ status: res.statusCode, headers: res.headers, body, json });
        });
        res.on('error', reject);
      },
    );
    r.on('error', (e) => {
      if (!answered) reject(e);
    });
    (async () => {
      for (const piece of req.pieces ?? []) {
        if (answered) return;
        if (!r.write(piece)) await new Promise((done) => r.once('drain', done));
      }
      r.end();
    })().catch(reject);
  });
}

test(
  'sessions, files and artifacts are controlled over plain HTTP',
  { timeout: 300_000 },
  async (t) => {
    const srv = await bootServer();
    const api = (token, method, path, body) => call(srv.port, { token, method, path, body });
    try {
      const { version: runtime } = await srv.eng.runtime.ensureFresh();
      const created = await Promise.all(
        ['ctl-a', 'ctl-b'].map((name) =>
          api(TOKENS.admin, 'POST', '/v1/sandboxes', { name, runtime }),
        ),
      );
      for (const c of created) assert.equal(c.status, 201, c.text);
      const [a, b] = created.map((c) => c.json);
      const box = `/v1/sandboxes/${a.id}`;
      const start = async (body) => {
        const r = await api(TOKENS.exec, 'POST', `${box}/sessions`, body);
        assert.equal(r.status, 201, r.text);
        return r.json.sessionId;
      };
      const wait = (sessionId, timeoutMs) =>
        api(TOKENS.read, 'POST', `${box}/sessions/${sessionId}/wait`, { timeoutMs });

      await t.test(
        'a background build is waited for, read in both encodings and paged',
        async () => {
          const sessionId = await start({
            argv: ['sh', '-c', 'printf "out\\n"; sleep 0.1; printf "\\303\\251rr\\n" >&2; exit 3'],
            name: 'build',
          });
          const waited = await wait(sessionId, 30_000);
          assert.equal(waited.status, 200, waited.text);
          assert.equal(waited.json.sessionId, sessionId);
          assert.equal(waited.json.exited.code, 3);
          assert.equal(waited.json.exited.signal, null);
          const info = await api(TOKENS.read, 'GET', `${box}/sessions/${sessionId}`);
          assert.equal(info.status, 200, info.text);
          assert.equal(info.json.name, 'build');
          assert.equal(info.json.source, 'runner');
          assert.equal(info.json.exited.code, 3);
          const out = await api(TOKENS.read, 'GET', `${box}/sessions/${sessionId}/output`);
          assert.equal(out.status, 200, out.text);
          assert.equal(out.json.sessionId, sessionId);
          assert.equal(text(out.json.chunks, 'stdout'), 'out\n');
          assert.equal(text(out.json.chunks, 'stderr'), 'érr\n');
          assert.equal(out.json.nextSeq, out.json.chunks.length);
          assert.equal(out.json.gap, null);
          assert.equal(out.json.truncated, false);
          assert.equal(out.json.exited.code, 3);
          const asText = await api(
            TOKENS.read,
            'GET',
            `${box}/sessions/${sessionId}/output?encoding=text`,
          );
          assert.deepEqual(
            asText.json.chunks.map((c) => [c.stream, c.data]),
            [
              ['stdout', 'out\n'],
              ['stderr', 'érr\n'],
            ],
          );
          const first = await api(
            TOKENS.read,
            'GET',
            `${box}/sessions/${sessionId}/output?maxBytes=1`,
          );
          assert.equal(first.json.chunks.length, 1);
          assert.equal(first.json.truncated, true);
          const rest = await api(
            TOKENS.read,
            'GET',
            `${box}/sessions/${sessionId}/output?fromSeq=${first.json.nextSeq}`,
          );
          assert.equal(text(rest.json.chunks), 'érr\n');
          assert.equal(rest.json.truncated, false);
          const t0 = Date.now();
          assert.equal((await wait(sessionId, 300_000)).json.exited.code, 3);
          assert.ok(Date.now() - t0 < 5000, 'an exited session is answered at once');
          for (const q of ['encoding=hex', 'maxBytes=0', `maxBytes=${4 * MiB + 1}`, 'fromSeq=-1'])
            assert.equal(
              (await api(TOKENS.read, 'GET', `${box}/sessions/${sessionId}/output?${q}`)).status,
              400,
              q,
            );
          assert.equal((await wait(sessionId, 300_001)).status, 400);
          const missing = await api(TOKENS.read, 'GET', `${box}/sessions/se-missing`);
          assert.equal(missing.status, 404);
          assert.equal((await wait('se-missing', 10)).status, 404);
          assert.equal(
            (await api(TOKENS.read, 'GET', `${box}/sessions/se-missing/output`)).status,
            404,
          );
        },
      );

      await t.test('input as text or base64, then eof, reaches the session', async () => {
        const sessionId = await start({ argv: ['cat'] });
        const input = (body) =>
          api(TOKENS.exec, 'POST', `${box}/sessions/${sessionId}/input`, body);
        assert.equal((await input({ text: 'one ' })).json.bytes, 4);
        assert.equal((await input({ data: b64('two\n') })).json.bytes, 4);
        const both = await input({ text: 'x', data: b64('y') });
        assert.equal(both.status, 400);
        assert.equal(
          (await api(TOKENS.read, 'POST', `${box}/sessions/${sessionId}/input`, {})).status,
          403,
        );
        assert.equal((await input({ eof: true })).json.eof, true);
        assert.equal((await wait(sessionId, 30_000)).json.exited.code, 0);
        const out = await api(
          TOKENS.read,
          'GET',
          `${box}/sessions/${sessionId}/output?encoding=text`,
        );
        assert.equal(out.json.chunks.map((c) => c.data).join(''), 'one two\n');
      });

      await t.test(
        'a long session times a wait out, takes a signal, and is removed once exited',
        async () => {
          const sessionId = await start({ argv: ['sleep', '600'] });
          const t0 = Date.now();
          const timedOut = await wait(sessionId, 300);
          assert.equal(timedOut.status, 200, timedOut.text);
          assert.equal(timedOut.json.exited, null);
          assert.ok(Date.now() - t0 >= 300);
          const running = await api(TOKENS.exec, 'DELETE', `${box}/sessions/${sessionId}`);
          assert.equal(running.status, 409);
          assert.equal(running.json.error.code, 'E_STATE');
          const listeners = srv.manager.listenerCount('event');
          const gone = http.request({
            host: '127.0.0.1',
            port: srv.port,
            method: 'POST',
            path: `${box}/sessions/${sessionId}/wait`,
            headers: {
              host: `127.0.0.1:${srv.port}`,
              authorization: `Bearer ${TOKENS.read}`,
              'content-type': 'application/json',
            },
            agent: false,
          });
          gone.on('error', () => undefined);
          gone.end(JSON.stringify({ timeoutMs: 300_000 }));
          const until = async (fn) => {
            const deadline = Date.now() + 10_000;
            while (!fn()) {
              if (Date.now() > deadline) throw new Error('condition not met');
              await new Promise((r) => setTimeout(r, 20));
            }
          };
          await until(() => srv.manager.listenerCount('event') > listeners);
          gone.destroy();
          await until(() => srv.manager.listenerCount('event') === listeners);
          const pending = wait(sessionId, 30_000);
          const sent = await api(TOKENS.exec, 'POST', `${box}/sessions/${sessionId}/signal`, {
            signal: 'SIGTERM',
          });
          assert.equal(sent.status, 200, sent.text);
          assert.deepEqual(sent.json, { sessionId, signal: 'SIGTERM' });
          const exited = await pending;
          assert.equal(exited.json.exited.signal, 'SIGTERM');
          assert.equal(srv.manager.listenerCount('event'), listeners, 'the waits left no listener');
          const bad = await api(TOKENS.exec, 'POST', `${box}/sessions/${sessionId}/signal`, {
            signal: 'TERM',
          });
          assert.equal(bad.status, 400);
          const removed = await api(TOKENS.exec, 'DELETE', `${box}/sessions/${sessionId}`);
          assert.equal(removed.status, 200, removed.text);
          assert.deepEqual(removed.json, { sessionId, removed: true });
          assert.equal((await api(TOKENS.read, 'GET', `${box}/sessions/${sessionId}`)).status, 404);
          const listed = await api(TOKENS.read, 'GET', `${box}/sessions`);
          assert.ok(!listed.json.sessions.some((s) => s.sessionId === sessionId));
          assert.ok(!srv.eng.store.listSessions(a.id).some((s) => s.sessionId === sessionId));
          assert.equal(
            (await api(TOKENS.exec, 'DELETE', `${box}/sessions/${sessionId}`)).status,
            404,
          );
        },
      );

      await t.test(
        'stop ends a session; a pty session resizes and a pipe one does not',
        async () => {
          const tty = await start({ argv: ['sleep', '600'], pty: true, rows: 24, cols: 80 });
          const resized = await api(TOKENS.exec, 'POST', `${box}/sessions/${tty}/resize`, {
            rows: 30,
            cols: 100,
          });
          assert.equal(resized.status, 200, resized.text);
          assert.deepEqual(resized.json, { sessionId: tty, rows: 30, cols: 100 });
          const stopped = await api(TOKENS.exec, 'POST', `${box}/sessions/${tty}/stop`, {
            graceMs: 2000,
          });
          assert.equal(stopped.status, 200, stopped.text);
          assert.ok(stopped.json.exited, stopped.text);
          const again = await api(TOKENS.exec, 'POST', `${box}/sessions/${tty}/stop`, {});
          assert.equal(again.json.escalated, false);
          const pipe = await start({ argv: ['true'] });
          await wait(pipe, 30_000);
          const notPty = await api(TOKENS.exec, 'POST', `${box}/sessions/${pipe}/resize`, {
            rows: 1,
            cols: 1,
          });
          assert.equal(notPty.status, 501);
          assert.equal(notPty.json.error.code, 'E_UNSUPPORTED');
          const noRows = await api(TOKENS.exec, 'POST', `${box}/sessions/${pipe}/resize`, {
            cols: 1,
          });
          assert.equal(noRows.status, 400);
        },
      );

      await t.test(
        'a multi-chunk binary file goes in and out raw, by length and chunked',
        async () => {
          const bytes = randomBytes(2 * FILE_CHUNK_BYTES + 12_345);
          const put = await rawCall(srv.port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/raw/big.bin&mkdirs=1&mode=600`,
            token: TOKENS.exec,
            pieces: [bytes],
            length: bytes.length,
          });
          assert.equal(put.status, 200, put.body.toString());
          assert.deepEqual(put.json, { path: '/tmp/raw/big.bin', bytes: bytes.length });
          const st = await api(TOKENS.read, 'GET', `${box}/files?path=/tmp/raw/big.bin&stat=1`);
          assert.equal(st.json.size, bytes.length);
          assert.equal(st.json.mode, 0o600);
          assert.equal(st.json.isFile, true);
          const got = await rawCall(srv.port, {
            path: `${box}/files/raw?path=/tmp/raw/big.bin`,
            token: TOKENS.read,
          });
          assert.equal(got.status, 200);
          assert.equal(got.headers['content-type'], 'application/octet-stream');
          assert.equal(Number(got.headers['content-length']), bytes.length);
          assert.ok(got.body.equals(bytes), 'the bytes came back unchanged');
          const sum = await api(TOKENS.exec, 'POST', `${box}/exec`, {
            argv: ['sha256sum', '/tmp/raw/big.bin'],
          });
          assert.equal(
            sum.json.stdout.split(' ')[0],
            createHash('sha256').update(bytes).digest('hex'),
          );
          const pieces = [];
          for (let i = 0; i < bytes.length; i += 700_000)
            pieces.push(bytes.subarray(i, i + 700_000));
          const chunked = await rawCall(srv.port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/raw/big.bin`,
            token: TOKENS.exec,
            pieces: pieces.reverse(),
          });
          assert.equal(chunked.status, 200, chunked.body.toString());
          const back = await rawCall(srv.port, {
            path: `${box}/files/raw?path=/tmp/raw/big.bin`,
            token: TOKENS.read,
          });
          assert.ok(back.body.equals(Buffer.concat(pieces)), 'a chunked upload replaced the file');
          const empty = await rawCall(srv.port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/raw/empty`,
            token: TOKENS.exec,
            length: 0,
          });
          assert.equal(empty.json.bytes, 0);
          const none = await rawCall(srv.port, {
            path: `${box}/files/raw?path=/tmp/raw/empty`,
            token: TOKENS.read,
          });
          assert.equal(none.status, 200);
          assert.equal(none.body.length, 0);
          const dir = await rawCall(srv.port, {
            path: `${box}/files/raw?path=/tmp/raw`,
            token: TOKENS.read,
          });
          assert.equal(dir.status, 400);
          const nope = await rawCall(srv.port, {
            path: `${box}/files/raw?path=/nope`,
            token: TOKENS.read,
          });
          assert.equal(nope.status, 404);
          const badMode = await rawCall(srv.port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/raw/x&mode=999`,
            token: TOKENS.exec,
            pieces: [Buffer.from('x')],
          });
          assert.equal(badMode.status, 400);
          const byRead = await rawCall(srv.port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/raw/x`,
            token: TOKENS.read,
            pieces: [Buffer.from('x')],
          });
          assert.equal(byRead.status, 403);
          const uploads = srv.auditEntries().filter((e) => e.action === 'api.file.upload');
          assert.ok(uploads.some((e) => e.data.outcome === 'ok' && e.data.bytes === bytes.length));
          assert.ok(
            srv.logs.some((l) => l.route === 'GET /v1/sandboxes/:id/files/raw' && l.status === 200),
          );
        },
      );

      await t.test('the upload cap holds by declared length and while streaming', async () => {
        const capped = createServer({
          manager: srv.manager,
          keys: KEYS,
          maxUploadBytes: FILE_CHUNK_BYTES + MiB,
          logger: { info() {}, error() {} },
        });
        const { port } = await capped.listen(0);
        try {
          const declared = await rawCall(port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/cap/declared&mkdirs=1`,
            token: TOKENS.exec,
            length: FILE_CHUNK_BYTES + 2 * MiB,
          });
          assert.equal(declared.status, 413);
          assert.equal(declared.json.error.code, 'E_LIMIT');
          const pieces = [
            ...Array.from({ length: 5 }, () => Buffer.alloc(MiB, 1)),
            Buffer.alloc(1),
          ];
          const streamed = await rawCall(port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/cap/streamed&mkdirs=1`,
            token: TOKENS.exec,
            pieces,
          });
          assert.equal(streamed.status, 413);
          assert.equal(streamed.json.error.code, 'E_LIMIT');
          for (const name of ['declared', 'streamed'])
            assert.equal(
              (await api(TOKENS.read, 'GET', `${box}/files?path=/tmp/cap/${name}&stat=1`)).status,
              404,
              `${name}: no partial file is left behind`,
            );
          const fits = await rawCall(port, {
            method: 'PUT',
            path: `${box}/files/raw?path=/tmp/cap/fits`,
            token: TOKENS.exec,
            pieces: [Buffer.alloc(MiB, 2)],
          });
          assert.equal(fits.status, 200, fits.body.toString());
        } finally {
          await capped.close();
        }
      });

      await t.test('stat, mkdir and remove', async () => {
        const mk = await api(TOKENS.exec, 'POST', `${box}/files/mkdir`, { path: '/tmp/tree/a/b' });
        assert.equal(mk.status, 200, mk.text);
        assert.equal(mk.json.created, true);
        const st = await api(TOKENS.read, 'GET', `${box}/files?path=/tmp/tree/a/b&stat=1`);
        assert.equal(st.json.isDir, true);
        const lone = await api(TOKENS.exec, 'POST', `${box}/files/mkdir`, {
          path: '/tmp/tree/a/c',
          parents: false,
          mode: 0o700,
        });
        assert.equal(lone.status, 200, lone.text);
        const orphan = await api(TOKENS.exec, 'POST', `${box}/files/mkdir`, {
          path: '/tmp/none/x',
          parents: false,
        });
        assert.equal(orphan.status, 404);
        await api(TOKENS.exec, 'PUT', `${box}/files`, { path: '/tmp/tree/f', data: b64('f') });
        const underFile = await api(TOKENS.exec, 'POST', `${box}/files/mkdir`, {
          path: '/tmp/tree/f/x',
          parents: false,
        });
        assert.equal(underFile.status, 400);
        assert.equal((await api(TOKENS.exec, 'POST', `${box}/files/mkdir`, {})).status, 400);
        const file = await api(TOKENS.exec, 'DELETE', `${box}/files?path=/tmp/tree/f`);
        assert.deepEqual(file.json, { path: '/tmp/tree/f', removed: true });
        const tree = await api(TOKENS.exec, 'DELETE', `${box}/files?path=/tmp/tree&recursive=1`);
        assert.equal(tree.status, 200, tree.text);
        assert.equal(
          (await api(TOKENS.read, 'GET', `${box}/files?path=/tmp/tree&stat=1`)).status,
          404,
        );
        assert.equal((await api(TOKENS.read, 'DELETE', `${box}/files?path=/tmp`)).status, 403);
        assert.equal((await api(TOKENS.exec, 'DELETE', `${box}/files`)).status, 400);
      });

      await t.test('an artifact downloads only from a sandbox that holds it', async () => {
        const put = await api(TOKENS.exec, 'POST', `${box}/exec`, {
          argv: [
            'sh',
            '-c',
            'echo artifact-body > /tmp/art.txt && wb artifact put /tmp/art.txt --json',
          ],
        });
        assert.equal(put.json.exitCode, 0, put.json.stderr);
        const { sha256 } = lastJson(put.json.stdout);
        const got = await rawCall(srv.port, {
          path: `${box}/artifacts/${sha256}`,
          token: TOKENS.read,
        });
        assert.equal(got.status, 200, got.body.toString());
        assert.equal(got.body.toString(), 'artifact-body\n');
        assert.equal(Number(got.headers['content-length']), 14);
        const foreign = await rawCall(srv.port, {
          path: `/v1/sandboxes/${b.id}/artifacts/${sha256}`,
          token: TOKENS.read,
        });
        assert.equal(foreign.status, 404);
        const unknown = await api(TOKENS.read, 'GET', `${box}/artifacts/${'0'.repeat(64)}`);
        assert.equal(unknown.status, 404);
        assert.equal((await api(TOKENS.read, 'GET', `${box}/artifacts/not-hex`)).status, 400);
        assert.equal(
          (await api(TOKENS.read, 'GET', `/v1/sandboxes/sb-none/artifacts/${sha256}`)).status,
          404,
        );
      });
    } finally {
      await srv.stop();
    }
  },
);
