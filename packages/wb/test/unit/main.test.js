import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, exitCodeFor } from '../../src/main.js';

function capture() {
  const chunks = [];
  return { stream: { write: (d) => chunks.push(String(d)) }, text: () => chunks.join('') };
}

test('tools/--help/--version work without a runner; unknown command exits 2', async () => {
  const o = capture();
  const e = capture();
  assert.equal(await main(['tools', '--json'], { out: o.stream, err: e.stream }), 0);
  const parsed = JSON.parse(o.text());
  assert.ok(parsed.tools.some((t) => t.name === 'run'));
  const o2 = capture();
  assert.equal(await main(['--version'], { out: o2.stream, err: e.stream }), 0);
  assert.match(o2.text(), /wb 0\.1\.0/);
  const o3 = capture();
  assert.equal(await main(['run', '--help'], { out: o3.stream, err: e.stream }), 0);
  assert.match(o3.text(), /evidence envelope/);
  assert.equal(await main(['bogus'], { out: o.stream, err: e.stream }), 2);
  assert.equal(exitCodeFor('E_TIMEOUT'), 5);
  assert.equal(exitCodeFor('E_NOT_FOUND'), 3);
});
