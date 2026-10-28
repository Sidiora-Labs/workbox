import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { E } from '../errors.js';
import { nullLogger } from '../log.js';
import { removeUnder, withLockFile, lockPathFor, makeStaging, commitStaging } from './safefs.js';

export const ROOTFS_MANIFEST = 'manifest.json';
export const MANIFEST_SCHEMA = 1;
const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const S_IFMT = 0o170000;
const S_SUID_SGID = 0o6000;

/** Directory holding the built-in Dockerfiles: <repo>/rootfs/<name>/Dockerfile */
export const BUILTIN_ROOTFS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../rootfs',
);

/**
 * @typedef {object} RootfsManifest
 * @property {number} schema
 * @property {string} name
 * @property {string} digest sha256 over the sorted inode listing (mode, owner, size, content)
 * @property {number} files inode count
 * @property {number} bytes total regular-file bytes
 * @property {{base: number}} uid the shift applied on disk
 * @property {{image: string, imageId: string, dockerfileSha256: string}} source
 * @property {number} createdAt
 */

/**
 * Builds and manages uid-shifted root filesystems under `<root>/rootfs/<name>`.
 */
export class RootfsManager {
  /**
   * @param {{paths: {rootfs: string}, uid: {base: number, count: number}, logger?: import('../log.js').Logger, docker?: string}} opts
   */
  constructor(opts) {
    this.dirRoot = opts.paths.rootfs;
    this.uid = opts.uid;
    this.log = opts.logger ?? nullLogger();
    this.docker = opts.docker ?? 'docker';
  }

  /** @param {string} name */
  dir(name) {
    if (!NAME_RE.test(name)) throw E.invalid(`invalid rootfs name ${name}`, { name });
    return path.join(this.dirRoot, name);
  }

  /** @param {string} name @returns {RootfsManifest|null} */
  get(name) {
    const file = path.join(this.dir(name), ROOTFS_MANIFEST);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** @param {string} name */
  require(name) {
    const m = this.get(name);
    if (!m)
      throw E.notFound(`rootfs ${name} is not built`, {
        name,
        remedy: `workbox rootfs build ${name}`,
      });
    return m;
  }

  /** @returns {RootfsManifest[]} */
  list() {
    if (!fs.existsSync(this.dirRoot)) return [];
    return fs
      .readdirSync(this.dirRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.endsWith('.tmp'))
      .map((d) => this.get(d.name))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Build the Dockerfile, export the container filesystem, shift ownership and write the manifest.
   * The result appears atomically; an existing rootfs is replaced only when `force` is set.
   * Builders of one name serialise on a lockfile and stage in a private mkdtemp directory beside
   * the target; one that waited while another built the same Dockerfile returns that build.
   * @param {string} name
   * @param {{dockerfileDir?: string, force?: boolean, tag?: string}} [opts]
   * @returns {Promise<RootfsManifest>}
   */
  async build(name, opts = {}) {
    const target = this.dir(name);
    const dockerfileDir = opts.dockerfileDir ?? path.join(BUILTIN_ROOTFS_DIR, name);
    const dockerfile = path.join(dockerfileDir, 'Dockerfile');
    if (!fs.existsSync(dockerfile))
      throw E.notFound(`no Dockerfile at ${dockerfile}`, { dockerfile });
    const seen = this.get(name);
    return withLockFile(lockPathFor(this.dirRoot, name), async () => {
      const now = this.get(name);
      if (
        now &&
        now.createdAt !== seen?.createdAt &&
        now.source?.dockerfileSha256 === sha256File(dockerfile)
      ) {
        this.log.info('rootfs built by a concurrent builder', { name, digest: now.digest });
        return now;
      }
      if (fs.existsSync(target) && !opts.force)
        throw E.conflict(`rootfs ${name} already exists`, { name, path: target });
      const tag = opts.tag ?? `workbox-rootfs-${name}:latest`;
      return this._buildLocked(name, { target, dockerfileDir, dockerfile, tag });
    });
  }

  /** Build into a fresh staging directory and commit it; the caller holds the lock. */
  async _buildLocked(name, { target, dockerfileDir, dockerfile, tag }) {
    const staging = makeStaging(this.dirRoot, name);
    let containerId = null;
    try {
      this.log.info('docker build', { name, tag, dockerfileDir });
      await this._docker(['build', '--quiet', '-t', tag, dockerfileDir], { timeoutMs: 1_800_000 });
      const imageId = (await this._docker(['image', 'inspect', '--format', '{{.Id}}', tag])).trim();
      containerId = (await this._docker(['create', tag])).trim();
      this.log.info('docker export', { name, containerId });
      await this._exportInto(containerId, staging);
      const shifted = shiftOwnership(staging, this.uid.base);
      const listing = digestTree(staging, this.uid.base);
      /** @type {RootfsManifest} */
      const manifest = {
        schema: MANIFEST_SCHEMA,
        name,
        digest: listing.digest,
        files: listing.files,
        bytes: listing.bytes,
        uid: { base: this.uid.base },
        source: { image: tag, imageId, dockerfileSha256: sha256File(dockerfile) },
        shifted,
        createdAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(staging, ROOTFS_MANIFEST),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o644 },
      );
      commitStaging(this.dirRoot, staging, target);
      this.log.info('rootfs built', {
        name,
        digest: manifest.digest,
        files: manifest.files,
        bytes: manifest.bytes,
      });
      return manifest;
    } catch (e) {
      removeUnder(this.dirRoot, staging);
      throw e;
    } finally {
      if (containerId) await this._docker(['rm', '-f', containerId]).catch(() => undefined);
    }
  }

  /** @param {string} name */
  remove(name) {
    const target = this.dir(name);
    if (!fs.existsSync(target)) return false;
    return removeUnder(this.dirRoot, target);
  }

  /**
   * @param {string[]} args
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<string>} stdout
   */
  _docker(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.docker, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 120_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(E.unavailable(`cannot run ${this.docker}: ${e.message}`, { args }));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else
          reject(
            E.unavailable(
              `docker ${args[0]} failed (${signal ?? `exit ${code}`}): ${err.trim().slice(-2000)}`,
              { args, code, signal },
            ),
          );
      });
    });
  }

  /**
   * Stream `docker export` into tar extracting as root with numeric owners and xattrs.
   * @param {string} containerId
   * @param {string} dir
   */
  async _exportInto(containerId, dir) {
    const exp = spawn(this.docker, ['export', containerId], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn(
      'tar',
      ['-x', '-p', '--numeric-owner', '--xattrs', '--xattrs-include=*', '-C', dir, '-f', '-'],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    let tarErr = '';
    let expErr = '';
    tar.stderr.on('data', (d) => (tarErr += d));
    exp.stderr.on('data', (d) => (expErr += d));
    const tarExit = once(tar, 'close');
    const expExit = once(exp, 'close');
    await pipeline(exp.stdout, tar.stdin);
    const [[tarCode], [expCode]] = await Promise.all([tarExit, expExit]);
    if (expCode !== 0)
      throw E.unavailable(`docker export failed: ${expErr.trim()}`, { code: expCode });
    if (tarCode !== 0)
      throw E.unavailable(`tar extraction failed: ${tarErr.trim()}`, { code: tarCode });
  }
}

/**
 * Add `base` to every inode's uid and gid, restoring setuid/setgid bits that chown clears.
 * Already-shifted trees (uid >= base) are left alone so the operation is idempotent.
 * @param {string} dir
 * @param {number} base
 * @returns {{inodes: number, setuid: number}}
 */
export function shiftOwnership(dir, base) {
  const stats = { inodes: 0, setuid: 0 };
  const visit = (p) => {
    const st = fs.lstatSync(p);
    stats.inodes++;
    if (st.uid < base) {
      fs.lchownSync(p, st.uid + base, st.gid + base);
      if (!st.isSymbolicLink() && st.mode & S_SUID_SGID) {
        fs.chmodSync(p, st.mode & 0o7777);
        stats.setuid++;
      }
    }
    if (st.isDirectory()) for (const name of fs.readdirSync(p)) visit(path.join(p, name));
  };
  visit(dir);
  return stats;
}

/**
 * Deterministic digest of a tree: type, mode, shifted owner, size and content per inode, sorted
 * by path. mtimes are excluded so identical content yields an identical digest.
 * @param {string} dir
 * @param {number} base uid shift to subtract so the digest is independent of the host range
 * @param {{exclude?: string[]}} [opts] relative paths to skip (the manifest itself is always skipped)
 * @returns {{digest: string, files: number, bytes: number}}
 */
export function digestTree(dir, base, opts = {}) {
  const exclude = new Set([ROOTFS_MANIFEST, ...(opts.exclude ?? [])]);
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    const names = fs.readdirSync(abs).sort();
    for (const name of names) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (exclude.has(relPath)) continue;
      const p = path.join(dir, relPath);
      const st = fs.lstatSync(p);
      files++;
      const type = st.mode & S_IFMT;
      let content = '';
      if (st.isSymbolicLink()) content = fs.readlinkSync(p);
      else if (st.isFile()) {
        content = sha256File(p);
        bytes += st.size;
      } else if (st.isCharacterDevice() || st.isBlockDevice()) content = String(st.rdev);
      hash.update(
        `${type.toString(8)} ${(st.mode & 0o7777).toString(8)} ${st.uid - base} ${st.gid - base} ${relPath} ${st.isFile() ? st.size : 0} ${content}\n`,
      );
      if (st.isDirectory()) walk(relPath);
    }
  };
  walk('');
  return { digest: hash.digest('hex'), files, bytes };
}

/** @param {string} file */
export function sha256File(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}
