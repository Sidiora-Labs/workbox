import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { bootServer, TOKENS } from '../../../server/test/helpers/real-server.js';
import { DEFAULT_SERVER, main } from '../../src/main.js';

/** Run main over in-memory stdio with one request per line; resolve to the parsed replies. */
async function run(opts, lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => (text += d));
  const done = main({ ...opts, input, output });
  for (const line of lines) input.write(`${JSON.stringify({ jsonrpc: '2.0', ...line })}\n`);
  input.end();
  await done;
  return text;
}

const listCall = {
  id: 1,
  method: 'tools/call',
  params: { name: 'sandbox_list', arguments: {} },
};

test('--version prints the version without serving', async () => {
  const text = await run({ argv: ['--version'], env: {} }, [listCall]);
  assert.equal(text, 'workbox-mcp 0.1.0-dev\n');
  assert.equal(DEFAULT_SERVER, 'http://127.0.0.1:8790');
});

test('WORKBOX_SERVER and WORKBOX_TOKEN reach the sdk client of a real server', async () => {
  const srv = await bootServer();
  try {
    const ok = JSON.parse(
      await run({ argv: [], env: { WORKBOX_SERVER: srv.base, WORKBOX_TOKEN: TOKENS.read } }, [
        listCall,
      ]),
    );
    assert.equal(ok.result.isError, undefined);
    assert.deepEqual(JSON.parse(ok.result.content[0].text).sandboxes, []);
    const anonymous = JSON.parse(
      await run({ argv: [], env: { WORKBOX_SERVER: srv.base } }, [listCall]),
    );
    assert.equal(anonymous.result.isError, true);
    assert.match(anonymous.result.content[0].text, /^E_DENIED: missing or invalid bearer token/);
    const requests = srv.logs.filter((l) => l.msg === 'request' && l.route === 'GET /v1/sandboxes');
    assert.deepEqual(
      requests.map((l) => [l.status, l.principal]),
      [
        [200, 'observer'],
        [401, null],
      ],
    );
  } finally {
    await srv.stop();
  }
});
