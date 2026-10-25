import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const GENESIS = '0'.repeat(64);

/**
 * JSON with keys sorted recursively, so the same entry always hashes the same.
 * @param {unknown} value
 */
export function canonicalJSON(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
}

/**
 * @param {string} prev previous hash
 * @param {object} entry the entry without its hash field
 */
export function hashEntry(prev, entry) {
  return createHash('sha256')
    .update(`${prev}\n${canonicalJSON(entry)}`)
    .digest('hex');
}

/** @param {number} ts */
export function dailyFile(ts) {
  return `audit-${new Date(ts).toISOString().slice(0, 10).replace(/-/g, '')}.ndjson`;
}

/**
 * Append-only NDJSON audit log. Each line carries `prev` (hash of the previous line, across files)
 * and `hash`, so tampering with any line breaks verification of every later line.
 */
export class Audit {
  /**
   * @param {{dir: string, redactor?: {applyDeep: (v: any) => any}, clock?: () => number, fileFor?: (ts: number) => string}} opts
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.redactor = opts.redactor;
    this.clock = opts.clock ?? Date.now;
    this.fileFor = opts.fileFor ?? dailyFile;
    this.prev = GENESIS;
    this.seq = 0;
    this.opened = false;
  }

  /** Create the directory and resume the chain from the newest file. */
  open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const last = lastEntry(this.dir);
    if (last) {
      this.prev = last.hash;
      this.seq = last.seq;
    }
    this.opened = true;
    return this;
  }

  /**
   * @param {{actor: string, action: string, sandboxId?: string, data?: object}} input
   * @returns {{seq: number, ts: number, hash: string, file: string}}
   */
  append(input) {
    if (!this.opened) this.open();
    const ts = this.clock();
    const entry = {
      seq: this.seq + 1,
      ts,
      actor: input.actor,
      action: input.action,
      sandboxId: input.sandboxId ?? null,
      data: this.redactor ? this.redactor.applyDeep(input.data ?? {}) : (input.data ?? {}),
      prev: this.prev,
    };
    const hash = hashEntry(this.prev, entry);
    const file = path.join(this.dir, this.fileFor(ts));
    fs.appendFileSync(file, `${JSON.stringify({ ...entry, hash })}\n`, { mode: 0o600 });
    this.prev = hash;
    this.seq = entry.seq;
    return { seq: entry.seq, ts, hash, file };
  }

  /**
   * Walk every file in order and recompute the chain.
   * @param {string} dir
   * @returns {{ok: boolean, entries: number, brokenAt: null | {file: string, line: number, reason: string}}}
   */
  static verify(dir) {
    let prev = GENESIS;
    let seq = 0;
    let entries = 0;
    for (const file of auditFiles(dir)) {
      const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          return { ok: false, entries, brokenAt: { file, line: i + 1, reason: 'unparsable line' } };
        }
        const { hash, ...rest } = obj;
        if (rest.prev !== prev)
          return {
            ok: false,
            entries,
            brokenAt: { file, line: i + 1, reason: 'prev hash mismatch' },
          };
        if (rest.seq !== seq + 1)
          return {
            ok: false,
            entries,
            brokenAt: {
              file,
              line: i + 1,
              reason: `sequence gap: expected ${seq + 1}, found ${rest.seq}`,
            },
          };
        if (hashEntry(prev, rest) !== hash)
          return { ok: false, entries, brokenAt: { file, line: i + 1, reason: 'hash mismatch' } };
        prev = hash;
        seq = rest.seq;
        entries++;
      }
    }
    return { ok: true, entries, brokenAt: null };
  }
}

/** @param {string} dir */
export function auditFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-\d{8}\.ndjson$/.test(f))
    .sort();
}

function lastEntry(dir) {
  const files = auditFiles(dir);
  for (let i = files.length - 1; i >= 0; i--) {
    const lines = fs.readFileSync(path.join(dir, files[i]), 'utf8').split('\n').filter(Boolean);
    if (lines.length) return JSON.parse(lines[lines.length - 1]);
  }
  return null;
}
