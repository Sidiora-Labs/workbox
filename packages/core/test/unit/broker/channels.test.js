import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Audit } from '../../../src/audit.js';
import { stdoutChannel, webhookChannel, notifyAsk } from '../../../src/broker/channels.js';
import { tmpDir } from '../../helpers/tmp.js';

const ask = { askId: 'ask-1', sandboxId: 'sb-1', kind: 'question', title: 'Which?' };

test('stdout and webhook channels deliver the ask and every outcome is audited', async () => {
  const t = tmpDir();
  const received = [];
  let status = 200;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      received.push({ method: req.method, type: req.headers['content-type'], body });
      res.statusCode = status;
      res.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const sink = new PassThrough();
    let printed = '';
    sink.on('data', (d) => {
      printed += d;
    });
    const audit = new Audit({ dir: path.join(t.dir, 'audit') }).open();
    const url = `http://127.0.0.1:${server.address().port}/hook`;
    const channels = [stdoutChannel(sink), webhookChannel({ url })];
    assert.deepEqual(await notifyAsk({ audit }, channels, ask), [
      { channel: 'stdout', ok: true },
      { channel: 'webhook', ok: true },
    ]);
    assert.deepEqual(JSON.parse(printed.trim()), { type: 'ask', ask });
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].type, 'application/json');
    assert.deepEqual(JSON.parse(received[0].body), { type: 'ask', ask });

    status = 500;
    const failed = await notifyAsk({ audit }, [webhookChannel({ url })], ask);
    assert.equal(failed[0].ok, false);
    assert.match(failed[0].error, /500/);

    const lines = fs
      .readdirSync(audit.dir)
      .flatMap((f) => fs.readFileSync(path.join(audit.dir, f), 'utf8').split('\n'))
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.deepEqual(
      lines.map((l) => [l.action, l.sandboxId, l.data.channel, l.data.ok]),
      [
        ['ask.notify', 'sb-1', 'stdout', true],
        ['ask.notify', 'sb-1', 'webhook', true],
        ['ask.notify', 'sb-1', 'webhook', false],
      ],
    );
  } finally {
    server.close();
    t.cleanup();
  }
});

test('webhook urls must be http or https', () => {
  assert.throws(() => webhookChannel({ url: 'file:///etc/passwd' }), { code: 'E_INVALID_PARAMS' });
  assert.throws(() => webhookChannel({ url: 'not a url' }), { code: 'E_INVALID_PARAMS' });
});
