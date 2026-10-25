import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/config.js';
import { Store } from '../../src/store.js';
import { Audit } from '../../src/audit.js';
import { CgroupManager } from '../../src/host/cgroup.js';
import { RootfsManager } from '../../src/host/rootfs.js';
import { RuntimeManager } from '../../src/host/runtime.js';
import { nullLogger } from '../../src/log.js';
import { tmpDir } from './tmp.js';

/**
 * Shared, lazily built assets for integration tests: the minimal rootfs and the runtime live under
 * WORKBOX_TEST_ASSETS (default /var/tmp/workbox-test-assets) so every test file does not rebuild
 * them. Each test still gets its own Workbox root for store, audit and sandboxes.
 */
export const ASSETS_ROOT = process.env.WORKBOX_TEST_ASSETS ?? '/var/tmp/workbox-test-assets';

export async function ensureAssets() {
  const cfg = loadConfig({ env: { WORKBOX_ROOT: ASSETS_ROOT } });
  const rootfs = new RootfsManager({ paths: cfg.paths, uid: cfg.uid });
  const runtime = new RuntimeManager({ paths: cfg.paths, cacheDir: '/var/cache/workbox' });
  if (!rootfs.get('minimal')) await rootfs.build('minimal');
  await runtime.ensureFresh();
  return { rootfs, runtime, assetsConfig: cfg };
}

/**
 * A complete engine wired to a temporary root, sharing rootfs and runtime from ASSETS_ROOT.
 * @param {{cgroupParent?: string, network?: 'none'|'egress'|'allowlist'}} [opts]
 */
export async function testEngine(opts = {}) {
  const { rootfs, runtime } = await ensureAssets();
  const t = tmpDir('workbox-engine-');
  fs.chmodSync(t.dir, 0o711);
  const parent = opts.cgroupParent ?? `workbox-test-${process.pid}`;
  const config = loadConfig({
    env: {
      WORKBOX_ROOT: t.dir,
      WORKBOX_CGROUP_PARENT: parent,
      WORKBOX_NETWORK_MODE: opts.network ?? 'none',
    },
  });
  fs.mkdirSync(config.paths.sandboxes, { recursive: true });
  const store = Store.open(config.paths.db);
  const audit = new Audit({ dir: config.paths.audit }).open();
  const cgroups = new CgroupManager({ root: config.cgroup.root, parent });
  cgroups.ensureParent();
  const logger = process.env.WORKBOX_TEST_LOG ? undefined : nullLogger();
  const cleanup = async () => {
    for (const name of cgroups.list())
      await cgroups.remove(cgroups.childPath(name), { timeoutMs: 10_000 }).catch(() => undefined);
    try {
      fs.rmdirSync(cgroups.parentPath);
    } catch {
      // another test may own it
    }
    store.close();
    t.cleanup();
  };
  return {
    config,
    store,
    audit,
    cgroups,
    rootfs,
    runtime,
    logger,
    dir: t.dir,
    cleanup,
    sandboxesDir: path.join(t.dir, 'sandboxes'),
  };
}
