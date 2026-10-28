import fs from 'node:fs';
import path from 'node:path';
import { E } from '../errors.js';

/**
 * The single choke point for host-side deletes (H14), ported from tryboxi internal/safefs (MIT).
 * Every path is resolved, symlinks included, and must land strictly inside an explicit root. This
 * is the only host-side module allowed to call fs.rm/fs.rmSync; an eslint rule enforces that.
 */

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
