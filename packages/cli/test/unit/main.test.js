import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, exitCodeForError, HELP } from '../../src/main.js';

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

test('--help/--version, unknown command exit 2, remote sandbox ls', async () => {
  const o = capture();
  const e = capture();
  assert.equal(await main(['--help'], { out: o.stream, err: e.stream }), 0);
  assert.match(o.text(), /workbox sandbox/);
  assert.ok(HELP.includes('serve'));
  assert.equal(await main(['--version'], { out: o.stream, err: e.stream }), 0);
  assert.equal(await main(['bogus'], { out: o.stream, err: e.stream }), 2);
  const o2 = capture();
  const client = { listSandboxes: async () => ({ items: [], complete: true }) };
  assert.equal(await main(['sandbox', 'ls'], { out: o2.stream, err: e.stream, client }), 0);
  assert.match(o2.text(), /items/);
  assert.equal(exitCodeForError({ code: 'E_NOT_FOUND' }), 3);
});
