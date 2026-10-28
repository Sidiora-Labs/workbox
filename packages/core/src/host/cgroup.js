import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { E } from '../errors.js';

/** Controllers the sandbox parent must delegate to its children. */
export const REQUIRED_CONTROLLERS = Object.freeze(['cpu', 'memory', 'pids']);
export const OPTIONAL_CONTROLLERS = Object.freeze(['io']);
export const CPU_PERIOD_USEC = 100_000;

const NAME_RE = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * @typedef {object} Limits
 * @property {number} memoryBytes memory.max
 * @property {number} swapBytes memory.swap.max
 * @property {number} cpuMillis CPU quota in millicores (1000 = one full CPU)
 * @property {number} pids pids.max
 */

/**
 * cgroup v2 management for sandboxes: one parent (`<root>/<parent>`) with delegated controllers,
 * one child per sandbox. All sysfs access is synchronous; waits poll.
 */
export class CgroupManager {
  /**
   * @param {{root?: string, parent?: string}} [opts]
   */
  constructor(opts = {}) {
    this.root = opts.root ?? '/sys/fs/cgroup';
    this.parent = opts.parent ?? 'workbox';
    if (!NAME_RE.test(this.parent))
      throw E.invalid(`invalid cgroup parent ${this.parent}`, { parent: this.parent });
  }

  get parentPath() {
    return path.join(this.root, this.parent);
  }

  /** Controllers available at the root, per cgroup.controllers. */
  rootControllers() {
    return readWords(path.join(this.root, 'cgroup.controllers'));
  }

  /**
   * Create the parent and enable the required controllers for its children.
   * @returns {{path: string, controllers: string[]}}
   */
  ensureParent() {
    const available = this.rootControllers();
    const missing = REQUIRED_CONTROLLERS.filter((c) => !available.includes(c));
    if (missing.length)
      throw E.unavailable(`cgroup v2 root lacks controllers ${missing.join(', ')}`, {
        missing,
        available,
      });
    fs.mkdirSync(this.parentPath, { recursive: true });
    const wanted = [
      ...REQUIRED_CONTROLLERS,
      ...OPTIONAL_CONTROLLERS.filter((c) => available.includes(c)),
    ];
    const enabled = readWords(path.join(this.parentPath, 'cgroup.subtree_control'));
    const toEnable = wanted.filter((c) => !enabled.includes(c));
    if (toEnable.length)
      writeFile(
        path.join(this.parentPath, 'cgroup.subtree_control'),
        toEnable.map((c) => `+${c}`).join(' '),
      );
    return {
      path: this.parentPath,
      controllers: readWords(path.join(this.parentPath, 'cgroup.subtree_control')),
    };
  }

  /** @param {string} name */
  childPath(name) {
    if (!NAME_RE.test(name)) throw E.invalid(`invalid cgroup name ${name}`, { name });
    return path.join(this.parentPath, name);
  }

  /**
   * Create a child cgroup and apply limits before any process joins it.
   * @param {string} name
   * @param {Limits} limits
   * @returns {string} the cgroup path
   */
  create(name, limits) {
    const p = this.childPath(name);
    if (fs.existsSync(p)) throw E.conflict(`cgroup ${name} already exists`, { name, path: p });
    fs.mkdirSync(p);
    try {
      this.applyLimits(p, limits);
    } catch (e) {
      try {
        fs.rmdirSync(p);
      } catch {
        // the failing limit write is the error worth reporting
      }
      throw e;
    }
    return p;
  }

  /**
   * @param {string} p cgroup path
   * @param {Limits} limits
   */
  applyLimits(p, limits) {
    for (const [key, min] of [
      ['memoryBytes', 1],
      ['swapBytes', 0],
      ['cpuMillis', 1],
      ['pids', 1],
    ]) {
      if (!Number.isInteger(limits[key]) || limits[key] < min)
        throw E.invalid(`limit ${key} must be an integer >= ${min}`, { key, value: limits[key] });
    }
    writeFile(path.join(p, 'memory.max'), String(limits.memoryBytes));
    writeFile(path.join(p, 'memory.swap.max'), String(limits.swapBytes));
    writeFile(
      path.join(p, 'cpu.max'),
      `${Math.round((limits.cpuMillis * CPU_PERIOD_USEC) / 1000)} ${CPU_PERIOD_USEC}`,
    );
    writeFile(path.join(p, 'pids.max'), String(limits.pids));
  }

  /**
   * @param {string} p
   * @returns {Limits}
   */
  readLimits(p) {
    const [quota, period] = readFile(path.join(p, 'cpu.max')).split(/\s+/);
    return {
      memoryBytes: parseMax(readFile(path.join(p, 'memory.max'))),
      swapBytes: parseMax(readFile(path.join(p, 'memory.swap.max'))),
      cpuMillis: quota === 'max' ? Infinity : Math.round((Number(quota) * 1000) / Number(period)),
      pids: parseMax(readFile(path.join(p, 'pids.max'))),
    };
  }

  /** @param {string} p */
  exists(p) {
    return fs.existsSync(path.join(p, 'cgroup.procs'));
  }

  /** @param {string} p @returns {number[]} */
  procs(p) {
    return readFile(path.join(p, 'cgroup.procs')).split('\n').filter(Boolean).map(Number);
  }

  /**
   * Move a process into the cgroup.
   * @param {string} p
   * @param {number} pid
   */
  addProcess(p, pid) {
    writeFile(path.join(p, 'cgroup.procs'), String(pid));
  }

  /**
   * Usage and event counters.
   * @param {string} p
   */
  stats(p) {
    const memoryEvents = parseKV(readFile(path.join(p, 'memory.events')));
    const cpuStat = parseKV(readFile(path.join(p, 'cpu.stat')));
    const peakFile = path.join(p, 'memory.peak');
    return {
      memoryCurrent: Number(readFile(path.join(p, 'memory.current'))),
      memoryPeak: fs.existsSync(peakFile) ? Number(readFile(peakFile)) : null,
      memoryEvents,
      cpuUsageUsec: cpuStat.usage_usec ?? 0,
      cpuThrottledUsec: cpuStat.throttled_usec ?? 0,
      pidsCurrent: Number(readFile(path.join(p, 'pids.current'))),
      procs: this.procs(p).length,
    };
  }

  /**
   * Kill every process in the cgroup. Uses cgroup.kill when the kernel has it, SIGKILL per pid otherwise.
   * @param {string} p
   */
  kill(p) {
    const killFile = path.join(p, 'cgroup.kill');
    if (fs.existsSync(killFile)) {
      writeFile(killFile, '1');
      return 'cgroup.kill';
    }
    for (const pid of this.procs(p)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    return 'sigkill';
  }

  /**
   * Poll until cgroup.procs is empty.
   * @param {string} p
   * @param {{timeoutMs?: number, pollMs?: number}} [opts]
   * @returns {Promise<boolean>} true when empty before the timeout
   */
  async waitEmpty(p, opts = {}) {
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    const poll = opts.pollMs ?? 20;
    for (;;) {
      if (!this.exists(p) || this.procs(p).length === 0) return true;
      if (Date.now() >= deadline) return false;
      await sleep(poll);
    }
  }

  /**
   * Kill, wait for emptiness, then remove the directory. Throws E_STATE when processes outlive the timeout.
   * @param {string} p
   * @param {{timeoutMs?: number}} [opts]
   */
  async remove(p, opts = {}) {
    if (!this.exists(p)) return { removed: false, reason: 'absent' };
    const method = this.kill(p);
    const empty = await this.waitEmpty(p, { timeoutMs: opts.timeoutMs ?? 10_000 });
    if (!empty)
      throw E.state(`cgroup ${p} still has processes after kill`, {
        path: p,
        procs: this.procs(p),
      });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.rmdirSync(p);
        return { removed: true, method };
      } catch (e) {
        if (e.code === 'ENOENT') return { removed: true, method };
        if (e.code !== 'EBUSY' || Date.now() >= deadline)
          throw E.state(`cannot remove cgroup ${p}: ${e.message}`, { path: p, code: e.code });
        await sleep(20);
      }
    }
  }

  /** Names of child cgroups under the parent. */
  list() {
    if (!fs.existsSync(this.parentPath)) return [];
    return fs
      .readdirSync(this.parentPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }
}

/** @param {string} text */
export function parseMax(text) {
  const t = text.trim();
  return t === 'max' ? Infinity : Number(t);
}

/** Parse "key value" lines into an object of numbers. @param {string} text */
export function parseKV(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const [k, val] = line.trim().split(/\s+/);
    if (k) out[k] = Number(val);
  }
  return out;
}

function readFile(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {
    throw E.unavailable(`cannot read ${p}: ${e.message}`, { path: p, code: e.code });
  }
}

function writeFile(p, value) {
  try {
    fs.writeFileSync(p, value);
  } catch (e) {
    throw E.unavailable(`cannot write ${JSON.stringify(value)} to ${p}: ${e.message}`, {
      path: p,
      value,
      code: e.code,
    });
  }
}

function readWords(p) {
  return readFile(p).split(/\s+/).filter(Boolean);
}
