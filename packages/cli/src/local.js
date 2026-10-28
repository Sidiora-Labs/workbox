import fs from 'node:fs';
import {
  loadConfig,
  Store,
  Audit,
  CgroupManager,
  RootfsManager,
  RuntimeManager,
  Manager,
  SecretProvider,
  createLogger,
  ensureRootAccess,
  holdLockFile,
  lockPathFor,
  E,
} from '@workbox/core';

/**
 * Take the lock that makes this engine the only one driving the root's sandboxes. A second engine
 * would reattach to sandboxes another engine holds, fail with E_BUSY and record them SUSPECT.
 * @param {string} root
 * @returns {Promise<() => void>} release
 */
export async function lockEngine(root) {
  try {
    return await holdLockFile(lockPathFor(root, 'engine'), 'a Workbox engine');
  } catch (e) {
    if (e.code !== 'E_BUSY') throw e;
    throw E.busy(
      `the Workbox root ${root} is in use by another engine (${e.data?.holder ?? 'unknown'}); ` +
        'talk to its server with --server URL --token T',
      { root, holder: e.data?.holder ?? null },
    );
  }
}

/**
 * Build the local engine (config, store, audit, cgroups, rootfs/runtime, manager) in-process.
 * Used by `workbox` in local mode and by `workbox serve`. With `exclusive` the engine first takes
 * the root's engine lock (see {@link lockEngine}) and releases it on close.
 * @param {{configFile?: string, env?: NodeJS.ProcessEnv, overrides?: object, reconcile?: boolean, exclusive?: boolean}} [opts]
 */
export async function openLocalEngine(opts = {}) {
  const config = loadConfig({ file: opts.configFile, env: opts.env, overrides: opts.overrides });
  ensureRootAccess(config.paths.root, config.uid.base);
  const unlock = opts.exclusive ? await lockEngine(config.paths.root) : () => {};
  try {
    return await buildEngine(config, opts, unlock);
  } catch (e) {
    unlock();
    throw e;
  }
}

async function buildEngine(config, opts, unlock) {
  fs.mkdirSync(config.paths.sandboxes, { recursive: true });
  const store = Store.open(config.paths.db);
  const audit = new Audit({ dir: config.paths.audit }).open();
  const cgroups = new CgroupManager({ root: config.cgroup.root, parent: config.cgroup.parent });
  const rootfs = new RootfsManager({ paths: config.paths, uid: config.uid });
  const runtime = new RuntimeManager({ paths: config.paths });
  let secrets = null;
  try {
    secrets = new SecretProvider({ file: config.secretsFile });
  } catch {
    secrets = null;
  }
  const logger = createLogger({ component: 'workbox' });
  const manager = new Manager({
    config,
    store,
    cgroups,
    rootfs,
    runtime,
    audit,
    logger,
    secrets: secrets ?? undefined,
  });
  if (opts.reconcile) await manager.reconcile().catch(() => undefined);
  return {
    config,
    store,
    audit,
    cgroups,
    rootfs,
    runtime,
    manager,
    logger,
    close() {
      manager.close();
      store.close();
      unlock();
    },
  };
}
