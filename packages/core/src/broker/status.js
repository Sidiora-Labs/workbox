/**
 * `broker.status`: sandbox identity, limits, current usage and network mode for `wb status`.
 * The context supplies live values (cgroup usage from the supervisor when available).
 */

/**
 * @param {object} ctx broker context (see broker/index.js)
 * @returns {object}
 */
export function brokerStatus(ctx) {
  const sandbox = ctx.store.requireSandbox(ctx.sandboxId);
  const usage = typeof ctx.usage === 'function' ? ctx.usage() : {};
  return {
    sandboxId: sandbox.id,
    name: sandbox.name,
    state: sandbox.state,
    health: sandbox.health,
    bootId: sandbox.bootId,
    rootfs: sandbox.rootfs,
    runtime: sandbox.runtime,
    limits: ctx.limits ?? sandbox.profile?.limits ?? {},
    usage: usage ?? {},
    network: ctx.network ?? sandbox.profile?.network ?? { mode: 'none' },
    createdAt: sandbox.createdAt,
    readyAt: sandbox.readyAt,
  };
}
