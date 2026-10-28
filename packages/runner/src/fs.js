import fs from 'node:fs';
import path from 'node:path';
import { ProtocolError, Codes } from '@workbox/protocol';

/**
 * In-box filesystem handlers for the protocol `fs.*` methods. The runner is already inside the
 * sandbox mount namespace, so confinement means: absolute paths only, NUL rejected, and the
 * symlink-resolved target of a write must stay under the configured root (default: `/`).
 */

/** Maximum bytes returned by one fs.read. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

/**
 * @param {{root?: string}} [opts]
 */
export function createFs(opts = {}) {
  const root = path.resolve(opts.root ?? '/');

  function resolve(p, { mustExist = true } = {}) {
    if (typeof p !== 'string' || p.length === 0 || p.includes('\0') || !path.isAbsolute(p))
      throw new ProtocolError(Codes.INVALID_PARAMS, `path must be absolute: ${String(p)}`);
    let real;
    try {
      real = mustExist ? fs.realpathSync(p) : realpathLoose(p);
    } catch (e) {
      throw new ProtocolError(Codes.NOT_FOUND, `path not found: ${p}`, { errno: e.code });
    }
    if (root !== '/' && real !== root && !real.startsWith(`${root}${path.sep}`))
      throw new ProtocolError(Codes.DENIED, `path escapes root: ${p}`);
    return real;
  }

  return {
    /** @param {{path: string, offset?: number, length?: number}} p */
    read(p) {
      const real = resolve(p.path);
      const st = fs.statSync(real);
      if (!st.isFile()) throw new ProtocolError(Codes.INVALID_PARAMS, `not a file: ${p.path}`);
      const offset = p.offset ?? 0;
      const length = Math.min(p.length ?? MAX_READ_BYTES, MAX_READ_BYTES);
      const buf = Buffer.alloc(Math.max(0, Math.min(length, st.size - offset)));
      const fd = fs.openSync(real, 'r');
      try {
        const n = fs.readSync(fd, buf, 0, buf.length, offset);
        return {
          path: p.path,
          size: st.size,
          offset,
          data: buf.subarray(0, n).toString('base64'),
          eof: offset + n >= st.size,
        };
      } finally {
        fs.closeSync(fd);
      }
    },
    /** @param {{path: string, data: string, append?: boolean, mode?: number, mkdirs?: boolean}} p */
    write(p) {
      const target = path.resolve(p.path);
      if (p.mkdirs) fs.mkdirSync(path.dirname(target), { recursive: true });
      resolve(path.dirname(target));
      const data = decodeBase64(p.data);
      if (p.append) {
        fs.appendFileSync(target, data, { mode: p.mode ?? 0o644 });
        return { path: p.path, bytes: data.length, size: fs.statSync(target).size };
      }
      const tmp = `${target}.wb-tmp-${process.pid}`;
      fs.writeFileSync(tmp, data, { mode: p.mode ?? 0o644 });
      fs.renameSync(tmp, target);
      return { path: p.path, bytes: data.length, size: data.length };
    },
    /** @param {{path: string}} p */
    list(p) {
      const real = resolve(p.path);
      const entries = fs
        .readdirSync(real, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .slice(0, 4096)
        .map((e) => ({ name: e.name, type: entryType(e) }));
      return { path: p.path, entries };
    },
    /** @param {{path: string}} p */
    stat(p) {
      const real = resolve(p.path);
      const st = fs.statSync(real);
      return {
        path: p.path,
        size: st.size,
        mode: st.mode & 0o7777,
        uid: st.uid,
        gid: st.gid,
        isFile: st.isFile(),
        isDir: st.isDirectory(),
        mtimeMs: Math.trunc(st.mtimeMs),
      };
    },
    /** @param {{path: string, mode?: number}} p */
    mkdir(p) {
      fs.mkdirSync(path.resolve(p.path), { recursive: true, mode: p.mode ?? 0o755 });
      return { path: p.path, created: true };
    },
    /** @param {{path: string, recursive?: boolean}} p */
    remove(p) {
      const real = resolve(p.path);
      const st = fs.statSync(real);
      if (st.isDirectory() && !p.recursive) fs.rmdirSync(real);
      else fs.rmSync(real, { recursive: Boolean(p.recursive), force: false });
      return { path: p.path, removed: true };
    },
  };
}

function entryType(e) {
  if (e.isDirectory()) return 'dir';
  if (e.isSymbolicLink()) return 'symlink';
  if (e.isFile()) return 'file';
  return 'other';
}

function realpathLoose(p) {
  const dir = fs.realpathSync(path.dirname(p));
  return path.join(dir, path.basename(p));
}

/** Strict base64 decode; Buffer.from alone silently ignores bad input. @param {string} s */
export function decodeBase64(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 === 1)
    throw new ProtocolError(Codes.INVALID_PARAMS, 'data is not valid base64');
  const buf = Buffer.from(s, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, ''))
    throw new ProtocolError(Codes.INVALID_PARAMS, 'data is not canonical base64');
  return buf;
}
