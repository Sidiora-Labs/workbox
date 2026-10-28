import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { E } from '../errors.js';
import { nullLogger } from '../log.js';
import { digestTree, sha256File } from './rootfs.js';

export const RUNTIME_MANIFEST = 'manifest.json';
export const CURRENT = 'current';
export const DEFAULT_NODE_VERSION = '22.22.2';
export const DEFAULT_CACHE_DIR = '/var/cache/workbox';
export const NODE_DIST = 'https://nodejs.org/dist';
/** Packages copied into the runtime; they must stay dependency-free. */
export const RUNTIME_PACKAGES = Object.freeze(['protocol', 'runner', 'wb']);
const VERSION_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The monorepo root, resolved from this file: packages/core/src/host -> repo */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * @typedef {object} RuntimeManifest
 * @property {number} schema
 * @property {string} version runtime directory name
 * @property {{version: string, sha256: string, tarball: string}} node
 * @property {Record<string, {version: string, digest: string, files: number}>} packages
 * @property {string} digest sha256 over the whole runtime tree
 * @property {number} createdAt
 */

/**
 * Installs the in-box runtime under `<root>/runtime/<version>` and points `current` at it:
 * node/ (the official tarball), lib/{protocol,runner,wb} (copied from the repo), bin/{wb,init.sh}.
 */
export class RuntimeManager {
  /**
   * @param {{paths: {runtime: string}, logger?: import('../log.js').Logger, repoRoot?: string, cacheDir?: string, fetch?: typeof fetch}} opts
   */
  constructor(opts) {
    this.dirRoot = opts.paths.runtime;
    this.log = opts.logger ?? nullLogger();
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** @param {string} version */
  dir(version) {
    if (!VERSION_RE.test(version))
      throw E.invalid(`invalid runtime version ${version}`, { version });
    return path.join(this.dirRoot, version);
  }

  get currentPath() {
    return path.join(this.dirRoot, CURRENT);
  }

  /** @param {string} version @returns {RuntimeManifest|null} */
  get(version) {
    const file = path.join(this.dir(version), RUNTIME_MANIFEST);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  /** The runtime `current` points at, or null. */
  current() {
    try {
      const target = fs.readlinkSync(this.currentPath);
      return this.get(path.basename(target));
    } catch {
      return null;
    }
  }

  /** @param {string} version */
  require(version = CURRENT) {
    const m = version === CURRENT ? this.current() : this.get(version);
    if (!m)
      throw E.notFound(`runtime ${version} is not installed`, {
        version,
        remedy: 'workbox runtime install',
      });
    return m;
  }

  /** @returns {RuntimeManifest[]} */
  list() {
    if (!fs.existsSync(this.dirRoot)) return [];
    return fs
      .readdirSync(this.dirRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.endsWith('.tmp'))
      .map((d) => this.get(d.name))
      .filter(Boolean)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Install a runtime. The Node tarball is taken from `nodeTarball`, else from the cache, else
   * downloaded; its SHA-256 is always verified against SHASUMS256.txt for that release.
   * @param {{nodeVersion?: string, nodeTarball?: string, shasums?: string, version?: string, force?: boolean, setCurrent?: boolean}} [opts]
   * @returns {Promise<RuntimeManifest>}
   */
  async install(opts = {}) {
    const nodeVersion = opts.nodeVersion ?? DEFAULT_NODE_VERSION;
    const tarballName = `node-v${nodeVersion}-linux-x64.tar.xz`;
    fs.mkdirSync(this.cacheDir, { recursive: true, mode: 0o755 });
    const tarball = await this._ensureCached(
      opts.nodeTarball,
      tarballName,
      `${NODE_DIST}/v${nodeVersion}/${tarballName}`,
    );
    const shasums = await this._ensureCached(
      opts.shasums,
      `SHASUMS256-v${nodeVersion}.txt`,
      `${NODE_DIST}/v${nodeVersion}/SHASUMS256.txt`,
    );
    const expected = expectedSha(fs.readFileSync(shasums, 'utf8'), tarballName);
    const actual = sha256File(tarball);
    if (actual !== expected)
      throw E.conflict(`node tarball checksum mismatch`, { tarball, expected, actual });

    const packages = this._collectPackages();
    const version =
      opts.version ??
      `${nodeVersion}-${createHash('sha256')
        .update(JSON.stringify(packages.map((p) => [p.name, p.digest])))
        .digest('hex')
        .slice(0, 12)}`;
    const target = this.dir(version);
    if (fs.existsSync(target) && !opts.force)
      throw E.conflict(`runtime ${version} already exists`, { version, path: target });
    const staging = `${target}.tmp`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'node'), { recursive: true, mode: 0o755 });
    try {
      this.log.info('extracting node', { tarball, version });
      await extractTarXz(tarball, path.join(staging, 'node'));
      const manifestPackages = {};
      for (const pkg of packages) {
        const dest = path.join(staging, 'lib', pkg.name);
        copyPackage(pkg.dir, dest);
        manifestPackages[pkg.name] = { version: pkg.version, digest: pkg.digest, files: pkg.files };
      }
      for (const dependant of ['runner', 'wb']) {
        const nm = path.join(staging, 'lib', dependant, 'node_modules', '@workbox');
        fs.mkdirSync(nm, { recursive: true, mode: 0o755 });
        fs.symlinkSync('../../../protocol', path.join(nm, 'protocol'));
      }
      fs.mkdirSync(path.join(staging, 'bin'), { mode: 0o755 });
      fs.copyFileSync(path.join(this.repoRoot, 'packages/wb/bin/wb'), path.join(staging, 'bin/wb'));
      fs.copyFileSync(
        path.join(this.repoRoot, 'packages/runner/bin/init.sh'),
        path.join(staging, 'bin/init.sh'),
      );
      fs.chmodSync(path.join(staging, 'bin/wb'), 0o755);
      fs.chmodSync(path.join(staging, 'bin/init.sh'), 0o755);
      makeWorldReadable(staging);
      const tree = digestTree(staging, 0);
      /** @type {RuntimeManifest} */
      const manifest = {
        schema: 1,
        version,
        node: { version: nodeVersion, sha256: actual, tarball: tarballName },
        packages: manifestPackages,
        digest: tree.digest,
        files: tree.files,
        createdAt: Date.now(),
      };
      fs.writeFileSync(
        path.join(staging, RUNTIME_MANIFEST),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o644 },
      );
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);
      if (opts.setCurrent !== false) this.setCurrent(version);
      this.log.info('runtime installed', { version, digest: manifest.digest });
      return manifest;
    } catch (e) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw e;
    }
  }

  /**
   * True when the current runtime carries exactly the repo's protocol, runner and wb packages.
   * @returns {{fresh: boolean, current: RuntimeManifest|null, stale: string[]}}
   */
  isFresh() {
    const current = this.current();
    if (!current) return { fresh: false, current: null, stale: [...RUNTIME_PACKAGES] };
    const stale = this._collectPackages()
      .filter((p) => current.packages[p.name]?.digest !== p.digest)
      .map((p) => p.name);
    return { fresh: stale.length === 0, current, stale };
  }

  /**
   * Install a new runtime version when the in-box packages changed, otherwise return the current one.
   * @param {Parameters<RuntimeManager['install']>[0]} [opts]
   */
  async ensureFresh(opts = {}) {
    const state = this.isFresh();
    if (state.fresh) return state.current;
    this.log.info('runtime stale, reinstalling', { stale: state.stale });
    return this.install({ ...opts, force: true });
  }

  /** Atomically point `current` at a version. @param {string} version */
  setCurrent(version) {
    if (!this.get(version)) throw E.notFound(`runtime ${version} is not installed`, { version });
    const tmp = `${this.currentPath}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(version, tmp);
    fs.renameSync(tmp, this.currentPath);
  }

  /** @param {string} version */
  remove(version) {
    const target = this.dir(version);
    if (!fs.existsSync(target)) return false;
    const cur = this.current();
    if (cur && cur.version === version) throw E.state(`runtime ${version} is current`, { version });
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }

  _collectPackages() {
    return RUNTIME_PACKAGES.map((name) => {
      const dir = path.join(this.repoRoot, 'packages', name);
      const pkgJson = path.join(dir, 'package.json');
      if (!fs.existsSync(pkgJson))
        throw E.notFound(`package ${name} not found at ${dir}`, { name, dir });
      const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
      const deps = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@workbox/'));
      if (deps.length)
        throw E.unsupported(
          `runtime package ${name} must have no external dependencies, found ${deps.join(', ')}`,
          { name, deps },
        );
      const digest = digestPackage(dir);
      return { name, dir, version: pkg.version, digest: digest.digest, files: digest.files };
    });
  }

  async _ensureCached(explicit, fileName, url) {
    if (explicit) {
      if (!fs.existsSync(explicit))
        throw E.notFound(`${explicit} does not exist`, { path: explicit });
      return explicit;
    }
    const cached = path.join(this.cacheDir, fileName);
    if (fs.existsSync(cached)) return cached;
    this.log.info('downloading', { url });
    const res = await this.fetch(url);
    if (!res.ok)
      throw E.unavailable(`download of ${url} failed: HTTP ${res.status}`, {
        url,
        status: res.status,
      });
    const tmp = `${cached}.part`;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp, { mode: 0o644 }));
    fs.renameSync(tmp, cached);
    return cached;
  }
}

/**
 * @param {string} shasums SHASUMS256.txt contents
 * @param {string} fileName
 */
export function expectedSha(shasums, fileName) {
  for (const line of shasums.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (name === fileName && /^[a-f0-9]{64}$/.test(sha ?? '')) return sha;
  }
  throw E.notFound(`${fileName} not listed in SHASUMS256.txt`, { fileName });
}

/** Digest of a package's shippable files (package.json, src/, bin/). @param {string} dir */
export function digestPackage(dir) {
  const hash = createHash('sha256');
  let files = 0;
  for (const rel of shippableFiles(dir)) {
    hash.update(`${rel}\n${sha256File(path.join(dir, rel))}\n`);
    files++;
  }
  return { digest: hash.digest('hex'), files };
}

/** @param {string} dir @returns {string[]} sorted relative paths */
export function shippableFiles(dir) {
  const out = ['package.json'];
  for (const sub of ['src', 'bin']) {
    const abs = path.join(dir, sub);
    if (!fs.existsSync(abs)) continue;
    const walk = (rel) => {
      for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
        const r = `${rel}/${name}`;
        if (fs.statSync(path.join(dir, r)).isDirectory()) walk(r);
        else out.push(r);
      }
    };
    walk(sub);
  }
  return out.sort();
}

function copyPackage(src, dest) {
  for (const rel of shippableFiles(src)) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o755 });
    fs.copyFileSync(path.join(src, rel), to);
  }
}

/** Files 0644 (0755 when executable), directories 0755, owned by the installer (root). @param {string} dir */
export function makeWorldReadable(dir) {
  const visit = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      fs.chmodSync(p, 0o755);
      for (const name of fs.readdirSync(p)) visit(path.join(p, name));
    } else {
      fs.chmodSync(p, st.mode & 0o111 ? 0o755 : 0o644);
    }
  };
  visit(dir);
}

/**
 * @param {string} tarball .tar.xz with one top-level directory
 * @param {string} dest directory that receives the contents (top-level stripped)
 */
export async function extractTarXz(tarball, dest) {
  const tar = spawn('tar', ['-xJf', tarball, '--strip-components=1', '-C', dest], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let err = '';
  tar.stderr.on('data', (d) => (err += d));
  const [code] = await once(tar, 'exit');
  if (code !== 0)
    throw E.unavailable(`tar failed extracting ${tarball}: ${err.trim()}`, { tarball, code });
}
