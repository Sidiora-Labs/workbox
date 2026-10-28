import { ProtocolError, Codes } from './errors.js';

export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {Buffer} the JSON encoding followed by a newline
 */
export function encodeFrame(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}

/**
 * Incremental newline-delimited JSON decoder with a hard line-length bound.
 * feed() returns the complete objects found so far; an oversized or unparsable line throws.
 * Lines must be well-formed UTF-8 unless `fatal: false` restores lossy U+FFFD replacement;
 * binary payloads travel base64-encoded inside the JSON and never reach this check raw.
 */
export class LineDecoder {
  /** @param {{maxLineBytes?: number, fatal?: boolean}} [opts] */
  constructor(opts = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.fatal = opts.fatal ?? true;
    this.text = new TextDecoder('utf-8', { fatal: this.fatal, ignoreBOM: true });
    /** @type {Buffer[]} */
    this.chunks = [];
    this.pending = 0;
    this.lines = 0;
  }

  /**
   * @param {Buffer} chunk
   * @returns {unknown[]} decoded objects, possibly empty
   */
  feed(chunk) {
    const out = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      if (nl === -1) break;
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      let line;
      if (this.pending) {
        this.chunks.push(piece);
        line = Buffer.concat(this.chunks);
        this.chunks = [];
        this.pending = 0;
      } else {
        line = piece;
      }
      if (line.length > this.maxLineBytes) {
        throw new ProtocolError(
          Codes.LINE_TOO_LONG,
          `line of ${line.length} bytes exceeds ${this.maxLineBytes}`,
          {
            length: line.length,
            max: this.maxLineBytes,
          },
        );
      }
      if (line.length && line[line.length - 1] === 13) line = line.subarray(0, line.length - 1);
      if (!line.length) continue;
      let text;
      try {
        text = this.text.decode(line);
      } catch {
        throw new ProtocolError(Codes.PARSE, 'line is not valid UTF-8', {
          line: this.lines,
          encoding: 'utf-8',
        });
      }
      try {
        out.push(JSON.parse(text));
      } catch (e) {
        throw new ProtocolError(Codes.PARSE, `invalid JSON line: ${e.message}`, {
          line: this.lines,
        });
      }
      this.lines++;
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start);
      this.pending += rest.length;
      if (this.pending > this.maxLineBytes) {
        this.chunks = [];
        this.pending = 0;
        throw new ProtocolError(
          Codes.LINE_TOO_LONG,
          `partial line exceeds ${this.maxLineBytes} bytes`,
          {
            max: this.maxLineBytes,
          },
        );
      }
      this.chunks.push(rest);
    }
    return out;
  }

  /** Bytes buffered for an incomplete line. */
  get buffered() {
    return this.pending;
  }
}
