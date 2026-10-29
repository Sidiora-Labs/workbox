import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashToken, SCOPE_MATRIX } from '../../src/auth.js';
import { bootServer, call, rawUpgrade, TOKENS } from '../helpers/real-server.js';

const b64 = (s) => Buffer.from(s).toString('base64');
const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1));

/** The error body without its request id. */
function errorOf(res) {
  const { requestId, ...rest } = res.json.error;
  assert.ok(requestId);
  return rest;
}

test('a bound key sees and controls only the sandboxes it is bound to', async (t) => {
  const srv = await bootServer();
  const api = (token, method, path, body) => call(srv.port, { token, method, path, body });
  const mint = async (body) => {
    const res = await api(TOKENS.admin, 'POST', '/v1/keys', body);
    assert.equal(res.status, 201, res.text);
    return res.json;
  };
  try {
    const created = await Promise.all([
      api(TOKENS.admin, 'POST', '/v1/sandboxes', { name: 'keys-a', labels: { team: 'a' } }),
      api(TOKENS.admin, 'POST', '/v1/sandboxes', {
        name: 'keys-b',
        labels: { team: 'b' },
        idempotencyKey: `keys-b-${process.pid}`,
      }),
    ]);
    for (const c of created) assert.equal(c.status, 201, c.text);
    const [a, b] = created.map((c) => c.json);
    const teamA = await mint({ name: 'team-a', scopes: ['admin'], labels: { team: 'a' } });
    const onlyB = await mint({ name: 'only-b', scopes: ['read', 'exec'], sandboxIds: [b.id] });

    await t.test('the token is returned once and only its digest is stored', async () => {
      assert.match(teamA.token, /^wbk_[A-Za-z0-9_-]{43}$/);
      assert.notEqual(teamA.token, onlyB.token);
      const row = srv.eng.store.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(teamA.id);
      assert.equal(row.token_sha256, hashToken(teamA.token));
      assert.equal(JSON.stringify(row).includes(teamA.token), false);
      const listed = await api(TOKENS.admin, 'GET', '/v1/keys');
      assert.equal(listed.status, 200);
      assert.deepEqual(
        listed.json.keys.map((k) => k.id),
        [teamA.id, onlyB.id],
      );
      assert.equal(listed.text.includes(teamA.token), false);
      assert.equal(listed.text.includes(row.token_sha256), false);
      assert.deepEqual(Object.keys(listed.json.keys[0]).sort(), [
        'binding',
        'createdAt',
        'createdBy',
        'expiresAt',
        'id',
        'lastUsedAt',
        'name',
        'revokedAt',
        'scopes',
      ]);
      assert.equal(listed.json.keys[0].createdBy, 'root');
    });

    await t.test('list and inspect show only the sandboxes the key can see', async () => {
      const list = await api(teamA.token, 'GET', '/v1/sandboxes');
      assert.deepEqual(
        list.json.items.map((s) => s.id),
        [a.id],
      );
      const page = await api(onlyB.token, 'GET', '/v1/sandboxes?limit=1');
      assert.deepEqual(
        page.json.items.map((s) => s.id),
        [b.id],
      );
      assert.equal(page.json.complete, true, 'the page is filtered in SQL, not after the limit');
      assert.equal((await api(teamA.token, 'GET', `/v1/sandboxes/${a.id}`)).status, 200);
      const hidden = await api(teamA.token, 'GET', `/v1/sandboxes/${b.id}`);
      assert.equal(hidden.status, 404);
      assert.deepEqual(errorOf(hidden), {
        code: 'E_NOT_FOUND',
        message: `sandbox ${b.id} not found`,
        details: { id: b.id },
      });
      const gone = await api(TOKENS.admin, 'GET', '/v1/sandboxes/01ZZZZZZZZZZZZZZZZZZZZZZZZ');
      assert.deepEqual(errorOf(gone), {
        code: 'E_NOT_FOUND',
        message: 'sandbox 01ZZZZZZZZZZZZZZZZZZZZZZZZ not found',
        details: { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
      });
    });

    await t.test('every route with :id answers a hidden sandbox as a missing one', async () => {
      const routes = Object.keys(SCOPE_MATRIX).filter((k) => k.split('/').includes(':id'));
      assert.ok(routes.length >= 14, String(routes.length));
      for (const key of routes) {
        const [method, template] = key.split(' ');
        const target = template.replace(':id', b.id).replace(/:[A-Za-z]+/g, 'x');
        const body = method === 'GET' || method === 'DELETE' ? undefined : {};
        const res = await api(teamA.token, method, target, body);
        assert.equal(res.status, 404, key);
        assert.deepEqual(errorOf(res).details, { id: b.id }, key);
      }
      const still = await api(TOKENS.admin, 'GET', `/v1/sandboxes/${b.id}`);
      assert.equal(still.json.desired, 'READY', 'the hidden sandbox was not touched');
    });

    await t.test(
      'the key runs code, moves files and attaches sessions in its own sandbox',
      async () => {
        const out = await api(teamA.token, 'POST', `/v1/sandboxes/${a.id}/exec`, {
          argv: ['sh', '-c', 'echo in-a'],
        });
        assert.equal(out.status, 200, out.text);
        assert.equal(out.json.stdout, 'in-a\n');
        const put = await api(teamA.token, 'PUT', `/v1/sandboxes/${a.id}/files`, {
          path: '/tmp/keys.txt',
          data: b64('bound\n'),
        });
        assert.equal(put.status, 200, put.text);
        const read = await api(
          teamA.token,
          'GET',
          `/v1/sandboxes/${a.id}/files?path=/tmp/keys.txt`,
        );
        assert.equal(Buffer.from(read.json.data, 'base64').toString(), 'bound\n');
        const started = await api(teamA.token, 'POST', `/v1/sandboxes/${a.id}/sessions`, {
          argv: ['sh', '-c', 'sleep 30'],
        });
        assert.equal(started.status, 201, started.text);
        const { sessionId } = started.json;
        const ws = (id, query) => `/v1/sandboxes/${id}/sessions/${sessionId}/ws${query}`;
        assert.match(
          await rawUpgrade(srv.port, ws(a.id, `?token=${teamA.token}`)),
          /^HTTP\/1\.1 101/,
        );
        assert.match(
          await rawUpgrade(srv.port, ws(b.id, `?token=${teamA.token}`)),
          /^HTTP\/1\.1 404/,
        );
        assert.match(
          await rawUpgrade(srv.port, ws(b.id, ''), { Authorization: `Bearer ${teamA.token}` }),
          /^HTTP\/1\.1 404/,
        );
        const inB = await api(onlyB.token, 'POST', `/v1/sandboxes/${b.id}/exec`, {
          argv: ['sh', '-c', 'echo in-b'],
        });
        assert.equal(inB.json.stdout, 'in-b\n');
        const fromB = await api(onlyB.token, 'POST', `/v1/sandboxes/${a.id}/exec`, {
          argv: ['true'],
        });
        assert.equal(fromB.status, 404);
      },
    );

    await t.test('a label-bound key creates sandboxes with its labels forced on', async () => {
      const conflict = await api(teamA.token, 'POST', '/v1/sandboxes', {
        name: 'keys-x',
        labels: { team: 'b' },
      });
      assert.equal(conflict.status, 403);
      assert.equal(conflict.json.error.code, 'E_DENIED');
      const idsOnly = await mint({ name: 'ids-admin', scopes: ['admin'], sandboxIds: [b.id] });
      const refused = await api(idsOnly.token, 'POST', '/v1/sandboxes', { name: 'keys-y' });
      assert.equal(refused.status, 403);
      assert.match(refused.json.error.message, /sandbox ids cannot create/);
      const replay = await api(teamA.token, 'POST', '/v1/sandboxes', {
        idempotencyKey: `keys-b-${process.pid}`,
      });
      assert.equal(replay.status, 409);
      assert.equal(replay.text.includes(b.id), false, 'the other sandbox is not revealed');
      const made = await api(teamA.token, 'POST', '/v1/sandboxes', {
        name: 'keys-c',
        labels: { role: 'worker' },
      });
      assert.equal(made.status, 201, made.text);
      assert.deepEqual(made.json.labels, { role: 'worker', team: 'a' });
      const list = await api(teamA.token, 'GET', '/v1/sandboxes');
      assert.deepEqual(list.json.items.map((s) => s.id).sort(), [a.id, made.json.id].sort());
      const names = (await api(TOKENS.admin, 'GET', '/v1/sandboxes')).json.items.map((s) => s.name);
      assert.deepEqual(names.sort(), ['keys-a', 'keys-b', 'keys-c']);
    });

    await t.test('fleet routes refuse a bound key with 403; whoami answers it', async () => {
      for (const [method, path, body] of [
        ['GET', '/metrics'],
        ['POST', '/v1/reconcile'],
        ['GET', '/v1/keys'],
        ['POST', '/v1/keys', { name: 'x', scopes: ['read'] }],
        ['DELETE', `/v1/keys/${onlyB.id}`],
      ]) {
        const res = await api(teamA.token, method, path, body);
        assert.equal(res.status, 403, `${method} ${path}`);
        assert.match(res.json.error.message, /not bound to sandboxes/);
      }
      assert.equal((await api(TOKENS.read, 'GET', '/metrics')).status, 200);
      assert.deepEqual((await api(teamA.token, 'GET', '/v1/whoami')).json, {
        id: teamA.id,
        scopes: ['admin'],
        binding: { labels: { team: 'a' } },
        source: 'store',
        expiresAt: null,
      });
    });

    await t.test(
      'asks of sandboxes the key cannot see are neither listed nor answerable',
      async () => {
        const raised = await api(TOKENS.exec, 'POST', `/v1/sandboxes/${b.id}/exec`, {
          argv: ['wb', 'ask', 'raise', '--json', '--kind', 'question', 'Ship it?'],
        });
        assert.equal(raised.json.exitCode, 0, raised.json.stderr);
        const { askId } = lastJson(raised.json.stdout);
        assert.deepEqual((await api(teamA.token, 'GET', '/v1/asks?status=open')).json, {
          asks: [],
        });
        const forB = await api(onlyB.token, 'GET', '/v1/asks?status=open');
        assert.deepEqual(
          forB.json.asks.map((x) => x.askId),
          [askId],
        );
        const hidden = await api(teamA.token, 'POST', `/v1/asks/${askId}/answer`, {
          answer: 'yes',
        });
        assert.equal(hidden.status, 404);
        assert.deepEqual(errorOf(hidden), {
          code: 'E_NOT_FOUND',
          message: `ask ${askId} not found`,
          details: { askId },
        });
        const missing = await api(TOKENS.admin, 'POST', '/v1/asks/ask-none/answer', { answer: 1 });
        assert.deepEqual(errorOf(missing), {
          code: 'E_NOT_FOUND',
          message: 'ask ask-none not found',
          details: { askId: 'ask-none' },
        });
        const stillOpen = await api(TOKENS.read, 'GET', `/v1/asks?status=open&sandboxId=${b.id}`);
        assert.equal(stillOpen.json.asks.length, 1);
      },
    );

    await t.test('revocation takes effect on the next request', async () => {
      assert.equal((await api(onlyB.token, 'GET', '/v1/whoami')).status, 200);
      const revoked = await api(TOKENS.admin, 'DELETE', `/v1/keys/${onlyB.id}`);
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal(typeof revoked.json.revokedAt, 'number');
      assert.equal((await api(onlyB.token, 'GET', `/v1/sandboxes/${b.id}`)).status, 401);
      assert.match(
        await rawUpgrade(srv.port, `/v1/sandboxes/${b.id}/sessions/x/ws?token=${onlyB.token}`),
        /^HTTP\/1\.1 401/,
      );
      const { keys } = (await api(TOKENS.admin, 'GET', '/v1/keys')).json;
      const row = keys.find((k) => k.id === onlyB.id);
      assert.equal(row.revokedAt, revoked.json.revokedAt);
      assert.equal(typeof row.lastUsedAt, 'number');
      assert.equal((await api(TOKENS.admin, 'DELETE', '/v1/keys/key_none')).status, 404);
    });

    await t.test('key changes are audited and no token reaches the audit log or the logs', () => {
      const entries = srv.auditEntries();
      const minted = entries.filter(
        (e) => e.action === 'api.key.create' && e.data.outcome === 'ok',
      );
      assert.equal(minted.length, 3);
      assert.ok(minted.every((e) => e.actor === 'api:root'));
      assert.ok(entries.some((e) => e.action === 'api.key.revoke' && e.data.keyId === onlyB.id));
      assert.ok(
        entries.some((e) => e.action === 'api.sandbox.exec' && e.actor === `api:${teamA.id}`),
      );
      const recorded = JSON.stringify(entries) + JSON.stringify(srv.logs);
      for (const k of [teamA, onlyB]) assert.equal(recorded.includes(k.token), false);
    });
  } finally {
    await srv.stop();
  }
});
