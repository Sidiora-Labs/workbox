import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnPty, resizePty, ptyArgv, shellQuote } from '../../src/pty.js';

test('quoting and argv building', () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.throws(() => shellQuote('a\0b'));
  const argv = ptyArgv(['echo', 'hi there'], { rows: 10, cols: 40 });
  assert.equal(argv[0], 'script');
  assert.match(argv[4], /rows 10 cols 40/);
  assert.throws(() => resizePty({ pid: 999999 }, 0, 80));
});

test('spawnPty presents a tty to the child', async () => {
  const child = spawnPty(['sh', '-c', 'test -t 0 && echo ISATTY || echo NO'], {});
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.match(out, /ISATTY/);
  assert.deepEqual(resizePty(child, 20, 100), { rows: 20, cols: 100 });
});
