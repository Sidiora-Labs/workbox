import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { threadId } from 'node:worker_threads';
import { setTimeout as sleep } from 'node:timers/promises';
import { E } from '../errors.js';

/**
 * The single choke point for host-side deletes (H14), ported from tryboxi internal/safefs (MIT).
 * Every path is resolved, symlinks included, and must land strictly inside an explicit root. This
 * is the only host-side module allowed to call fs.rm/fs.rmSync; a source scan in its unit test
 * enforces that. It also holds the install primitives built on it (H8): a cross-process lockfile,
 * a private mkdtemp staging directory beside the target, and a commit that fsyncs the rename.
 */

const LOCK_POLL_MS = 50;
const LOCK_TIMEOUT_MS = 30 * 60_000;
/** An unreadable lockfile or break guard older than this was left by a crashed writer. */
const LOCK_GRACE_MS = 10_000;
const MKDTEMP_SUFFIX = /^[A-Za-z0-9]{6}$/;
/** Tokens of the lockfiles this thread holds, so one naming this thread but not held is stale. */
const heldLocks = new Set();

/** `data.reason` values on the E_DENIED errors this module throws. */
export const SafeFsReason = Object.freeze({
  OUTSIDE_ROOT: 'outside_root',
  IS_ROOT: 'is_root',
  ROOT_TOO_BROAD: 'root_too_broad',
});

/**
 * Absolute, symlink-resolved form of `p`. When `p` (or a suffix of it) does not exist yet, the
 * deepest existing ancestor is resolved and the remainder appended, so a path about to be created
 * can be checked too.
 * @param {string} p
 */
function resolve(p) {
  const abs = path.resolve(p);
  const rest = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

/** True when the resolved `child` is `root` or lies beneath it. */
function within(root, child) {
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

function resolveRoot(root) {
  const r = resolve(root);
  if (r === path.parse(r).root)
    throw E.denied(`safefs: root ${root} is too broad`, {
      reason: SafeFsReason.ROOT_TOO_BROAD,
      root,
    });
  return r;
}

/**
 * The resolved form of `p` when it lies strictly inside `root`. Throws E_DENIED with
 * `data.reason` `is_root` for the root itself and `outside_root` for anything else outside it.
 * @param {string} root
 * @param {string} p
 * @returns {string}
 */
export function checkUnder(root, p) {
  const r = resolveRoot(root);
  const real = resolve(p);
  if (real === r)
    throw E.denied(`safefs: refusing to operate on the root ${root} itself`, {
      reason: SafeFsReason.IS_ROOT,
      root,
      path: p,
    });
  if (!within(r, real))
    throw E.denied(`safefs: ${p} is not under ${root}`, {
      reason: SafeFsReason.OUTSIDE_ROOT,
      root,
      path: p,
    });
  return real;
}

/**
 * Delete `p` recursively, only when it resolves strictly inside `root`. A symlink is removed as a
 * link and never followed; only its parent has to be inside `root`. A missing path is not an
 * error. Refusals are the E_DENIED errors of {@link checkUnder}.
 * @param {string} root
 * @param {string} p
 * @returns {boolean} true when something was removed, false when `p` did not exist
 */
export function removeUnder(root, p) {
  resolveRoot(root);
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink()) {
    try {
      checkUnder(root, path.dirname(p));
    } catch (e) {
      if (e.data?.reason !== SafeFsReason.IS_ROOT) throw e;
    }
    fs.unlinkSync(p);
    return true;
  }
  fs.rmSync(checkUnder(root, p), { recursive: true, force: true });
  return true;
}

/** fsync a directory so a rename or create inside it survives a crash. @param {string} dir */
export function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The lockfile that serialises installers of `<root>/<name>` across processes.
 * @param {string} root
 * @param {string} name a validated single path component
 */
export function lockPathFor(root, name) {
  return path.join(root, `.${name}.lock`);
}

/**
 * Run `fn` holding the cross-process lockfile `lockPath`: an O_EXCL file naming the holder's pid,
 * thread and a random token. Waiters poll; a lock whose holder process is gone is broken, as is an
 * unreadable one older than a grace period. Waiting past `timeoutMs` is E_BUSY. The lockfile is
 * removed through {@link removeUnder} when `fn` settles.
 * @template T
 * @param {string} lockPath
 * @param {() => T|Promise<T>} fn
 * @param {{timeoutMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withLockFile(lockPath, fn, opts = {}) {
  const token = await acquireLockFile(
    lockPath,
    opts.timeoutMs ?? LOCK_TIMEOUT_MS,
    opts.pollMs ?? LOCK_POLL_MS,
  );
  try {
    return await fn();
  } finally {
    heldLocks.delete(token);
    if (readText(lockPath) === token) removeUnder(path.dirname(lockPath), lockPath);
  }
}

async function acquireLockFile(lockPath, timeoutMs, pollMs) {
  const token = `${process.pid}:${threadId}:${randomBytes(8).toString('hex')}`;
  const deadline = Date.now() + timeoutMs;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o755 });
  for (;;) {
    try {
      fs.writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 });
      heldLocks.add(token);
      return token;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    if (breakStaleLockFile(lockPath)) continue;
    if (Date.now() >= deadline)
      throw E.busy(`lock ${lockPath} is held by another installer`, {
        lock: lockPath,
        holder: readText(lockPath),
        timeoutMs,
      });
    await sleep(pollMs);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function olderThan(file, ms) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs > ms;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

/** True when the process (or, for this pid, the thread's lock) named by `held` is gone. */
function lockHolderGone(lockPath, held) {
  const [pid, thread] = held.split(':').map(Number);
  if (!Number.isInteger(pid) || pid <= 0) return olderThan(lockPath, LOCK_GRACE_MS);
  if (pid === process.pid) return thread === threadId && !heldLocks.has(held);
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

/**
 * Remove the lock if its holder is gone; true when the lock is no longer there. A `.break` guard
 * keeps two waiters from both breaking it, the second deleting a lock the first just took.
 */
function breakStaleLockFile(lockPath) {
  const dir = path.dirname(lockPath);
  const held = readText(lockPath);
  if (held === null) return true;
  if (!lockHolderGone(lockPath, held)) return false;
  const guard = `${lockPath}.break`;
  try {
    fs.writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (olderThan(guard, LOCK_GRACE_MS)) removeUnder(dir, guard);
    return false;
  }
  try {
    if (readText(lockPath) === held) removeUnder(dir, lockPath);
  } finally {
    removeUnder(dir, guard);
  }
  return true;
}

/**
 * A fresh 0755 staging directory for `<root>/<name>`, made with mkdtemp beside the target so no
 * two installers share a path and the final rename stays on one filesystem. Staging directories an
 * earlier installer of the same name left behind (and the legacy `<name>.tmp`) are removed first,
 * so call this only while holding {@link lockPathFor} that name.
 * @param {string} root
 * @param {string} name a validated single path component
 * @returns {string}
 */
export function makeStaging(root, name) {
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const prefix = `.${name}.staging-`;
  for (const entry of fs.readdirSync(root)) {
    const leftover =
      entry === `${name}.tmp` ||
      (entry.startsWith(prefix) && MKDTEMP_SUFFIX.test(entry.slice(prefix.length)));
    if (leftover) removeUnder(root, path.join(root, entry));
  }
  const dir = fs.mkdtempSync(path.join(root, prefix));
  fs.chmodSync(dir, 0o755);
  return dir;
}

/**
 * Put a finished staging tree in place: the old `target` goes through removeUnder, `staging` is
 * renamed onto it and the parent directory fsynced so the rename is durable. Both lie under `root`.
 * @param {string} root
 * @param {string} staging
 * @param {string} target
 */
export function commitStaging(root, staging, target) {
  checkUnder(root, staging);
  checkUnder(root, target);
  removeUnder(root, target);
  fs.renameSync(staging, target);
  fsyncDir(path.dirname(target));
}
