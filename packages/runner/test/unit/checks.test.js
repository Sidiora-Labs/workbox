import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readIdMap,
  readStatus,
  readMounts,
  probeMount,
  selfChecks,
  EXPECTED_CAPS,
} from '../../src/checks.js';

test('readIdMap, readStatus and readMounts parse this process', () => {
  const uid = readIdMap();
  assert.ok(uid.length >= 1);
  assert.deepEqual(Object.keys(uid[0]), ['inner', 'outer', 'count']);
  const st = readStatus();
  assert.match(st.capEff, /^[0-9a-f]{16}$/);
  assert.match(st.capBnd, /^[0-9a-f]{16}$/);
  assert.equal(typeof st.noNewPrivs, 'boolean');
  assert.equal(st.uid, process.getuid());
  assert.equal(st.gid, process.getgid());
  assert.equal(typeof st.seccomp, 'number');
  const mounts = readMounts();
  const root = mounts.find((m) => m.mountPoint === '/');
  assert.ok(root, 'root mount present');
  assert.ok(root.fsType.length > 0);
  assert.ok(Array.isArray(root.options));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb checks '));
  try {
    const fake = `36 35 98:0 /mnt1 ${dir.replace(/ /g, '\\040')} rw,noatime master:1 - ext3 /dev/root rw,errors=continue\n`;
    const file = path.join(dir, 'mountinfo');
    fs.writeFileSync(file, fake);
    assert.deepEqual(readMounts(file), [
      { mountPoint: dir, options: ['rw', 'noatime'], fsType: 'ext3', source: '/dev/root' },
    ]);
    fs.writeFileSync(path.join(dir, 'uid_map'), '         0     200000      65536\n');
    assert.deepEqual(readIdMap(path.join(dir, 'uid_map')), [
      { inner: 0, outer: 200000, count: 65536 },
    ]);
    fs.writeFileSync(
      path.join(dir, 'status'),
      'Name:\tx\nUid:\t5\t5\t5\t5\nGid:\t6\t6\t6\t6\nCapEff:\t00000000a80425fb\nNoNewPrivs:\t1\nSeccomp:\t2\nOther:\tz\n',
    );
    const parsed = readStatus(path.join(dir, 'status'));
    assert.equal(parsed.uid, 5);
    assert.equal(parsed.gid, 6);
    assert.equal(parsed.capEff, EXPECTED_CAPS);
    assert.equal(parsed.capBnd, null);
    assert.equal(parsed.noNewPrivs, true);
    assert.equal(parsed.seccomp, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('probeMount and selfChecks on the host report that the host is not a sandbox', async () => {
  const probe = await probeMount();
  assert.equal(typeof probe.denied, 'boolean');
  assert.equal(probe.denied, false, 'root on the host can mount, so the probe is not denied here');
  const checks = await selfChecks();
  assert.equal(checks.ok, false);
  assert.ok(checks.problems.some((p) => /mount\(2\) was not denied/.test(p)));
  assert.ok(checks.problems.some((p) => /expected overlay/.test(p)));
  assert.equal(checks.pid, process.pid);
  assert.equal(checks.uid, 0);
  assert.equal(typeof checks.mounts.count, 'number');
  assert.equal(checks.mountDenied, false);
  const custom = await selfChecks({ expectedCaps: checks.caps.eff });
  assert.ok(!custom.problems.some((p) => /CapEff/.test(p)));
});
