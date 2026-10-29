import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bootServer, call, TOKENS } from '../helpers/real-server.js';
import { PUBLIC_ROUTES, SERVER_VERSION, buildOpenApi } from '../../src/openapi.js';
import { SCOPE_MATRIX } from '../../src/auth.js';

const CHECKED_IN = new URL('../../../../docs/reference/openapi.json', import.meta.url);

test('the server serves its OpenAPI document without a token, behind the browser guard', async (t) => {
  const srv = await bootServer({ server: { authFailures: { max: 1000 } } });
  try {
    await t.test('200 without a token: the generated document, as JSON', async () => {
      const res = await call(srv.port, { path: '/v1/openapi.json' });
      assert.equal(res.status, 200, res.text);
      assert.match(res.headers['content-type'], /^application\/json/);
      assert.ok(res.headers['x-request-id']);
      assert.equal(res.json.openapi, '3.1.0');
      assert.equal(res.json.info.version, SERVER_VERSION);
      assert.deepEqual(res.json, buildOpenApi({ version: SERVER_VERSION }));
      assert.deepEqual(res.json, JSON.parse(fs.readFileSync(CHECKED_IN, 'utf8')));
      const withToken = await call(srv.port, { path: '/v1/openapi.json', token: TOKENS.read });
      assert.equal(withToken.status, 200);
      assert.deepEqual(withToken.json, res.json);
    });

    await t.test(
      '403 with an Origin header, a Sec-Fetch-Site header or a foreign Host',
      async () => {
        for (const headers of [
          { origin: 'https://evil.example' },
          { 'sec-fetch-site': 'cross-site' },
          { host: 'evil.example' },
        ]) {
          const res = await call(srv.port, { path: '/v1/openapi.json', headers });
          assert.equal(res.status, 403, JSON.stringify(headers));
          assert.equal(res.json.error.code, 'E_DENIED');
          assert.ok(res.json.error.requestId);
          assert.equal(res.json.openapi, undefined);
        }
      },
    );

    await t.test('every documented operation is a route the server answers', async () => {
      const doc = (await call(srv.port, { path: '/v1/openapi.json' })).json;
      const seen = [];
      for (const [p, item] of Object.entries(doc.paths))
        for (const [method, op] of Object.entries(item)) {
          const target = p.replace(/\{[^}]+\}/g, 'x');
          const res = await call(srv.port, { method: method.toUpperCase(), path: target });
          const key = `${method.toUpperCase()} ${p}`;
          seen.push(key);
          if (op['x-workbox-scope'] === 'none') assert.equal(res.status, 200, key);
          else {
            assert.equal(res.status, 401, `${key}: ${res.text}`);
            assert.ok(op.responses['401'], key);
          }
        }
      assert.equal(seen.length, Object.keys(SCOPE_MATRIX).length + PUBLIC_ROUTES.length);
      const unknown = await call(srv.port, { path: '/v1/openapi.yaml' });
      assert.equal(unknown.status, 404);
    });
  } finally {
    await srv.stop();
  }
});
