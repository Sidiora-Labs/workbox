import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { E } from '../errors.js';

/**
 * The agent→host file crossing (spec design `artifacts`). The agent sends only a name, size and
 * digest; the host opens the outbox file with O_NOFOLLOW, requires a regular file owned by the
 * mapped uid range (when a range is configured), verifies size and SHA-256 while streaming into
 * the content-addressed store, then unlinks the outbox copy.
 */

/** Default per-artifact size cap (256 MiB), enforced while streaming. */
export const DEFAULT_MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/** @param {string} name */
export function assertOutboxName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name === '.' || name === '..')
    throw E.invalid(`invalid outbox name ${String(name)}`, { name: String(name) });
  return name;
}

/**
 * Accept one outbox file into the CAS.
 * @param {{outboxDir: string, artifactsDir: string, outboxName: string, sha256: string, size: number, uidRange?: {base: number, count: number}, maxBytes?: number}} opts
 * @returns {{sha256: string, size: number, path: string}}
 */
export function acceptOutboxFile(opts) {
  assertOutboxName(opts.outboxName);
  if (!/^[a-f0-9]{64}$/.test(opts.sha256 ?? '')) throw E.invalid('sha256 must be 64 lowercase hex');
  if (!Number.isInteger(opts.size) || opts.size < 0)
    throw E.invalid('size must be a non-negative integer');
  const max = opts.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (opts.size > max) throw E.limit(`artifact exceeds ${max} bytes`, { size: opts.size, max });
  const src = path.join(opts.outboxDir, opts.outboxName);
  let fd;
  try {
    fd = fs.openSync(src, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (e) {
    throw E.notFound(`outbox file ${opts.outboxName} cannot be opened: ${e.message}`, {
      errno: e.code,
    });
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw E.denied(`outbox entry ${opts.outboxName} is not a regular file`);
    if (opts.uidRange) {
      const { base, count } = opts.uidRange;
      if (st.uid < base || st.uid >= base + count)
        throw E.denied(`outbox file owned by uid ${st.uid} outside the mapped range`, {
          uid: st.uid,
        });
    }
    fs.mkdirSync(opts.artifactsDir, { recursive: true });
    const destDir = path.join(opts.artifactsDir, opts.sha256.slice(0, 2));
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, opts.sha256);
    const tmp = `${dest}.tmp-${process.pid}`;
    const hash = createHash('sha256');
    let total = 0;
    const out = fs.openSync(tmp, 'w', 0o600);
    try {
      const buf = Buffer.alloc(1024 * 1024);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n === 0) break;
        total += n;
        if (total > max) throw E.limit(`artifact exceeds ${max} bytes while streaming`, { max });
        hash.update(buf.subarray(0, n));
        fs.writeSync(out, buf, 0, n);
      }
    } finally {
      fs.closeSync(out);
    }
    const digest = hash.digest('hex');
    if (digest !== opts.sha256 || total !== opts.size) {
      fs.rmSync(tmp, { force: true });
      throw E.invalid('outbox digest/size mismatch', {
        expectedSha256: opts.sha256,
        actualSha256: digest,
        expectedSize: opts.size,
        actualSize: total,
      });
    }
    if (fs.existsSync(dest)) fs.rmSync(tmp, { force: true });
    else fs.renameSync(tmp, dest);
    return { sha256: digest, size: total, path: dest };
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(src);
    } catch {
      // already unlinked by a racing accept; the CAS copy is authoritative
    }
  }
}

/**
 * Copy a CAS artifact into the sandbox inbox for `wb artifact get`. With a mapped uid range the
 * copy is owned by the sandbox root so the box can read it.
 * @param {{artifactsDir: string, inboxDir: string, sha256: string, uidRange?: {base: number, count: number}}} opts
 * @returns {{sha256: string, inboxName: string, size: number}}
 */
export function deliverToInbox(opts) {
  if (!/^[a-f0-9]{64}$/.test(opts.sha256 ?? '')) throw E.invalid('sha256 must be 64 lowercase hex');
  const src = artifactPath(opts.artifactsDir, opts.sha256);
  if (!fs.existsSync(src))
    throw E.notFound(`artifact ${opts.sha256} not in the store`, { sha256: opts.sha256 });
  fs.mkdirSync(opts.inboxDir, { recursive: true });
  const inboxName = opts.sha256;
  const dest = path.join(opts.inboxDir, inboxName);
  fs.copyFileSync(src, dest);
  if (opts.uidRange) fs.chownSync(dest, opts.uidRange.base, opts.uidRange.base);
  return { sha256: opts.sha256, inboxName, size: fs.statSync(src).size };
}

/** @param {string} artifactsDir @param {string} sha256 */
export function artifactPath(artifactsDir, sha256) {
  return path.join(artifactsDir, String(sha256).slice(0, 2), String(sha256));
}
