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
} from '@workbox/core';

/**
 * Build the local engine (config, store, audit, cgroups, rootfs/runtime, manager) in-process.
 * Used by `workbox` in local mode and by `workbox serve`.
 * @param {{configFile?: string, env?: NodeJS.ProcessEnv, overrides?: object, reconcile?: boolean}} [opts]
 */
export async function openLocalEngine(opts = {}) {
  const config = loadConfig({ file: opts.configFile, env: opts.env, overrides: opts.overrides });
  fs.mkdirSync(config.paths.root, { recursive: true, mode: 0o700 });
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
    },
  };
}
