import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { E } from './errors.js';

export const GENESIS = '0'.repeat(64);

const LOCK = '.audit.lock';
const NL = 0x0a;
const READ_CHUNK = 64 * 1024;
const TAIL_CHUNK = 8 * 1024;
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));

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
 *
 * Durability: every entry is a single write(2) on an O_APPEND descriptor followed by fdatasync
 * (and a directory fsync when the write created the file), unless `fsync: false`. Writers in
 * different processes serialise on a lockfile in the audit directory and re-read the chain tail
 * under it, so two writers cannot fork the chain. A final line torn by a crash is truncated back
 * to the last complete line on the next open or append, and the repair is itself audited.
 */
export class Audit {
  /**
   * @param {{dir: string, redactor?: {applyDeep: (v: any) => any}, clock?: () => number, fileFor?: (ts: number) => string, fsync?: boolean, lockTimeoutMs?: number, lockStaleMs?: number}} opts
   */
  constructor(opts) {
    this.dir = opts.dir;
    this.redactor = opts.redactor;
    this.clock = opts.clock ?? Date.now;
    this.fileFor = opts.fileFor ?? dailyFile;
    this.fsync = opts.fsync ?? true;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 5000;
    this.lockStaleMs = opts.lockStaleMs ?? 30_000;
    this.prev = GENESIS;
    this.seq = 0;
    this.opened = false;
  }

  /** Create the directory, repair a torn final line and resume the chain from the newest file. */
  open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.opened = true;
    this._locked(() => this._resume());
    return this;
  }

  /**
   * @param {{actor: string, action: string, sandboxId?: string, data?: object}} input
   * @returns {{seq: number, ts: number, hash: string, file: string}}
   */
  append(input) {
    if (!this.opened) this.open();
    return this._locked(() => {
      this._resume();
      return this._write(input);
    });
  }

  /**
   * Walk every file in order and recompute the chain, streaming each file in fixed-size chunks.
   * @param {string} dir
   * @returns {{ok: boolean, entries: number, brokenAt: null | {file: string, line: number, reason: string}}}
   */
  static verify(dir) {
    const state = { prev: GENESIS, seq: 0, entries: 0 };
    for (const file of auditFiles(dir)) {
      let line = 0;
      let reason = null;
      forEachLine(path.join(dir, file), (text) => {
        line++;
        if (text) reason = checkLine(state, text);
        return reason === null;
      });
      if (reason) return { ok: false, entries: state.entries, brokenAt: { file, line, reason } };
    }
    return { ok: true, entries: state.entries, brokenAt: null };
  }

  _locked(fn) {
    const lockPath = path.join(this.dir, LOCK);
    const token = acquireLock(lockPath, this.lockTimeoutMs, this.lockStaleMs);
    try {
      return fn();
    } finally {
      releaseLock(lockPath, token);
    }
  }

  _resume() {
    const tail = readTail(this.dir, this.fsync);
    this.prev = tail.entry ? tail.entry.hash : GENESIS;
    this.seq = tail.entry ? tail.entry.seq : 0;
    for (const repair of tail.repairs)
      this._write({ actor: 'audit', action: 'audit.repair', data: repair });
  }

  _write(input) {
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
    appendLine(file, `${JSON.stringify({ ...entry, hash })}\n`, this.fsync);
    this.prev = hash;
    this.seq = entry.seq;
    return { seq: entry.seq, ts, hash, file };
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

function checkLine(state, text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return 'unparsable line';
  }
  if (!obj || typeof obj !== 'object') return 'unparsable line';
  const { hash, ...rest } = obj;
  if (rest.prev !== state.prev) return 'prev hash mismatch';
  if (rest.seq !== state.seq + 1)
    return `sequence gap: expected ${state.seq + 1}, found ${rest.seq}`;
  if (hashEntry(state.prev, rest) !== hash) return 'hash mismatch';
  state.prev = hash;
  state.seq = rest.seq;
  state.entries++;
  return null;
}

/** Call fn for each line of a file (an unterminated remainder included) until it returns false. */
function forEachLine(file, fn) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK);
    let carry = Buffer.alloc(0);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, READ_CHUNK, pos);
      if (n === 0) break;
      pos += n;
      const data = carry.length
        ? Buffer.concat([carry, chunk.subarray(0, n)])
        : chunk.subarray(0, n);
      let start = 0;
      for (let at = data.indexOf(NL); at !== -1; at = data.indexOf(NL, start)) {
        if (!fn(data.toString('utf8', start, at))) return;
        start = at + 1;
      }
      carry = Buffer.from(data.subarray(start));
    }
    if (carry.length) fn(carry.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The newest complete entry, walking back from the newest file. A tail without its newline is a
 * write torn by a crash: it is truncated off and described in `repairs`.
 */
function readTail(dir, sync) {
  const repairs = [];
  const files = auditFiles(dir);
  for (let i = files.length - 1; i >= 0; i--) {
    const fd = fs.openSync(path.join(dir, files[i]), 'r+');
    try {
      let size = fs.fstatSync(fd).size;
      if (size > 0 && readRange(fd, size - 1, size)[0] !== NL) {
        const start = lastNewlineBefore(fd, size) + 1;
        const torn = readRange(fd, start, size);
        fs.ftruncateSync(fd, start);
        if (sync) fs.fsyncSync(fd);
        repairs.push({
          file: files[i],
          offset: start,
          bytes: size - start,
          sha256: createHash('sha256').update(torn).digest('hex'),
        });
        size = start;
      }
      const last = lastLine(fd, size);
      if (last) return { entry: parseTail(files[i], last), repairs };
    } finally {
      fs.closeSync(fd);
    }
  }
  return { entry: null, repairs };
}

/** The last non-empty newline-terminated line of a file of `size` bytes ending in a newline. */
function lastLine(fd, size) {
  let end = size - 1;
  while (end >= 0) {
    const start = lastNewlineBefore(fd, end) + 1;
    if (start < end) return { start, bytes: readRange(fd, start, end) };
    end = start - 1;
  }
  return null;
}

function parseTail(file, last) {
  let obj = null;
  try {
    obj = JSON.parse(last.bytes.toString('utf8'));
  } catch {
    obj = null;
  }
  if (!obj || typeof obj.hash !== 'string' || !Number.isInteger(obj.seq))
    throw E.internal(`audit ${file} ends in a complete line that is not an audit entry`, {
      file,
      offset: last.start,
    });
  return obj;
}

function readRange(fd, start, end) {
  const buf = Buffer.alloc(end - start);
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}

/** Offset of the last newline strictly before `pos`, or -1. */
function lastNewlineBefore(fd, pos) {
  let end = pos;
  while (end > 0) {
    const start = Math.max(0, end - TAIL_CHUNK);
    const at = readRange(fd, start, end).lastIndexOf(NL);
    if (at !== -1) return start + at;
    end = start;
  }
  return -1;
}

function appendLine(file, line, sync) {
  const created = !fs.existsSync(file);
  const buf = Buffer.from(line);
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    const n = fs.writeSync(fd, buf);
    if (n !== buf.length)
      throw E.internal(`short audit write to ${path.basename(file)}`, {
        file: path.basename(file),
        wrote: n,
        expected: buf.length,
      });
    if (sync) fs.fdatasyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (sync && created) {
    const dirFd = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

/**
 * Take the cross-process audit lock: an O_EXCL lockfile naming its holder. A lock whose holder is
 * gone, or that is older than `staleMs`, is broken; waiting longer than `timeoutMs` is E_BUSY.
 */
function acquireLock(lockPath, timeoutMs, staleMs) {
  const token = `${process.pid}:${threadId}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (breakStaleLock(lockPath, staleMs)) continue;
    if (Date.now() >= deadline)
      throw E.busy(`audit lock ${lockPath} is held by another writer`, {
        lock: lockPath,
        timeoutMs,
      });
    Atomics.wait(SLEEPER, 0, 0, 1 + Math.floor(Math.random() * 3));
  }
}

function releaseLock(lockPath, token) {
  if (readLock(lockPath) === token) fs.rmSync(lockPath, { force: true });
}

function readLock(lockPath) {
  try {
    return fs.readFileSync(lockPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/** Remove the lock if its holder is gone; true when the lock is no longer there. */
function breakStaleLock(lockPath, staleMs) {
  const held = readLock(lockPath);
  if (held === null) return true;
  if (!lockIsStale(lockPath, held, staleMs)) return false;
  const guard = `${lockPath}.break`;
  try {
    fs.writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (lockIsStale(guard, '', staleMs)) fs.rmSync(guard, { force: true });
    return false;
  }
  try {
    if (readLock(lockPath) === held) fs.rmSync(lockPath, { force: true });
  } finally {
    fs.rmSync(guard, { force: true });
  }
  return true;
}

function lockIsStale(file, held, staleMs) {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (Date.now() - mtimeMs > staleMs) return true;
  const [pid, thread] = held.split(':').map(Number);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Appends are synchronous, so a lock naming this very thread was left by a dead process that
  // had the same pid.
  if (pid === process.pid) return thread === threadId;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}
