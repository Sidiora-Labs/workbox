import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RingSpool, DEFAULT_SPOOL_BYTES } from '../../src/spool.js';

test('append assigns sequence numbers, evicts oldest chunks and reports gaps', () => {
  const s = new RingSpool({ capacityBytes: 10 });
  assert.equal(DEFAULT_SPOOL_BYTES, 8 * 1024 * 1024);
  assert.equal(s.firstSeq, 0);
  assert.equal(s.append('stdout', Buffer.from('aaaa'), 1), 0);
  assert.equal(s.append('stderr', Buffer.from('bbbb'), 2), 1);
  assert.deepEqual(
    s.replayFrom(0).chunks.map((c) => [c.seq, c.stream, c.data.toString(), c.at]),
    [
      [0, 'stdout', 'aaaa', 1],
      [1, 'stderr', 'bbbb', 2],
    ],
  );
  assert.equal(s.replayFrom(0).gap, null);
  assert.equal(s.append('stdout', Buffer.from('cccc')), 2);
  assert.equal(s.bytes, 8);
  assert.equal(s.firstSeq, 1, 'oldest chunk evicted to stay within 10 bytes');
  const r = s.replayFrom(0);
  assert.deepEqual(r.gap, { requested: 0, available: 1 });
  assert.deepEqual(
    r.chunks.map((c) => c.seq),
    [1, 2],
  );
  assert.deepEqual(
    s.replayFrom(2).chunks.map((c) => c.seq),
    [2],
  );
  assert.deepEqual(s.replayFrom(5).chunks, []);
  assert.equal(s.replayFrom(5).gap, null);
  const st = s.stats();
  assert.equal(st.droppedChunks, 1);
  assert.equal(st.droppedBytes, 4);
  assert.equal(st.totalBytes, 12);
  assert.equal(st.nextSeq, 3);
  assert.equal(s.append('stdout', Buffer.from('0123456789abcdef')), 3);
  assert.equal(s.chunks.length, 1, 'a chunk larger than capacity keeps only its tail');
  assert.equal(s.bytes, 10);
  assert.equal(s.chunks[0].data.toString(), '6789abcdef');
  assert.equal(s.chunks[0].truncated, true);
  s.clear();
  assert.equal(s.bytes, 0);
  assert.equal(s.firstSeq, 4);
  assert.throws(() => new RingSpool({ capacityBytes: 0 }), RangeError);
});
