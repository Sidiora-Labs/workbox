import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  spawnPty,
  resizePty,
  ptyArgv,
  shellQuote,
  ptsPath,
  ptyLeader,
  signalPtyGroup,
} from '../../src/pty.js';

const until = async (fn, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('quoting, argv building and tty_nr decoding', async () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
  assert.throws(() => shellQuote('a\0b'));
  const argv = ptyArgv(['echo', 'hi there'], { rows: 10, cols: 40 });
  assert.equal(argv[0], 'script');
  assert.match(argv[4], /rows 10 cols 40/);
  await assert.rejects(resizePty({ pid: 999999 }, 0, 80), { code: 'E_INVALID_PARAMS' });
  assert.equal(ptsPath((136 << 8) | 3), '/dev/pts/3');
  assert.equal(ptsPath((137 << 8) | 1), '/dev/pts/257');
  assert.equal(ptsPath((4 << 8) | 1), null, 'a virtual console is not a pty slave');
  assert.equal(ptsPath(0), null);
  assert.equal(ptyLeader(999999), null);
});

test('spawnPty presents a tty to the child and resize sets the window size', async () => {
  const child = spawnPty(
    ['sh', '-c', 'test -t 0 && echo ISATTY; echo A=$(stty size); read x; echo B=$(stty size)'],
    { rows: 30, cols: 90 },
  );
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await until(() => /A=30 90/.test(out));
  assert.match(out, /ISATTY/);
  const leader = ptyLeader(child.pid);
  assert.match(leader.tty, /^\/dev\/pts\/\d+$/);
  assert.deepEqual(await resizePty(child, 20, 100), { rows: 20, cols: 100 });
  child.stdin.write('\n');
  const [code] = await once(child, 'close');
  assert.equal(code, 0);
  assert.match(out, /B=20 100/);
  await assert.rejects(resizePty(child, 20, 100), { code: 'E_STATE' });
});

test('signalPtyGroup reaches the process group on the slave', async () => {
  const child = spawnPty(['sh', '-c', 'trap "" TERM; echo UP; while :; do sleep 1; done'], {});
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await until(() => /UP/.test(out));
  assert.equal(signalPtyGroup(child, 'SIGKILL'), true);
  await once(child, 'close');
  assert.equal(signalPtyGroup(child, 'SIGKILL'), false);
});
