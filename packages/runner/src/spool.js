/**
 * A bounded ring of output chunks with monotonically increasing sequence numbers. When the byte
 * capacity is exceeded the oldest chunks are dropped, and replays that reach into dropped history
 * report the gap instead of silently skipping it.
 */
export const DEFAULT_SPOOL_BYTES = 8 * 1024 * 1024;

export class RingSpool {
  /** @param {{capacityBytes?: number}} [opts] */
  constructor(opts = {}) {
    this.capacity = opts.capacityBytes ?? DEFAULT_SPOOL_BYTES;
    if (!Number.isInteger(this.capacity) || this.capacity < 1)
      throw new RangeError('capacityBytes must be a positive integer');
    /** @type {{seq: number, stream: string, data: Buffer, at: number}[]} */
    this.chunks = [];
    this.bytes = 0;
    this.nextSeq = 0;
    this.droppedChunks = 0;
    this.droppedBytes = 0;
    this.totalBytes = 0;
  }

  /** Oldest retained sequence number, or nextSeq when nothing is retained. */
  get firstSeq() {
    return this.chunks.length ? this.chunks[0].seq : this.nextSeq;
  }

  /**
   * @param {string} stream
   * @param {Buffer} data
   * @param {number} [at]
   * @returns {number} the chunk's sequence number
   */
  append(stream, data, at = Date.now()) {
    const seq = this.nextSeq++;
    this.chunks.push({ seq, stream, data, at });
    this.bytes += data.length;
    this.totalBytes += data.length;
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const old = this.chunks.shift();
      this.bytes -= old.data.length;
      this.droppedChunks++;
      this.droppedBytes += old.data.length;
    }
    if (this.bytes > this.capacity && this.chunks.length === 1) {
      const only = this.chunks[0];
      only.data = only.data.subarray(only.data.length - this.capacity);
      this.droppedBytes += this.bytes - this.capacity;
      this.bytes = this.capacity;
      only.truncated = true;
    }
    return seq;
  }

  /**
   * @param {number} [fromSeq]
   * @returns {{chunks: {seq: number, stream: string, data: Buffer, at: number}[], gap: null | {requested: number, available: number}}}
   */
  replayFrom(fromSeq = 0) {
    const first = this.firstSeq;
    const gap = fromSeq < first ? { requested: fromSeq, available: first } : null;
    const start = gap ? first : fromSeq;
    return { chunks: this.chunks.filter((c) => c.seq >= start), gap };
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }

  stats() {
    return {
      capacity: this.capacity,
      bytes: this.bytes,
      chunks: this.chunks.length,
      firstSeq: this.firstSeq,
      nextSeq: this.nextSeq,
      droppedChunks: this.droppedChunks,
      droppedBytes: this.droppedBytes,
      totalBytes: this.totalBytes,
    };
  }
}
