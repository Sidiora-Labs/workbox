import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A fresh temporary directory removed when `cleanup` runs.
 * @param {string} [prefix]
 */
export function tmpDir(prefix = 'workbox-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A controllable clock for deterministic timestamps. @param {number} [start] */
export function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => {
    now += ms;
    return now;
  };
  clock.set = (ts) => {
    now = ts;
    return now;
  };
  return clock;
}
