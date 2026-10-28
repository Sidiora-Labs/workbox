import { acceptOutboxFile, deliverToInbox } from './outbox.js';

/** `broker.artifact.*` handlers over the outbox/CAS handoff. */

/** @param {object} ctx @param {object} params */
export function artifactPut(ctx, params) {
  const accepted = acceptOutboxFile({
    outboxDir: ctx.outboxDir,
    artifactsDir: ctx.artifactsDir,
    outboxName: params.outboxName,
    sha256: params.sha256,
    size: params.size,
    uidRange: ctx.uidRange,
    maxBytes: ctx.maxArtifactBytes,
  });
  ctx.store.putArtifact({
    sha256: accepted.sha256,
    size: accepted.size,
    contentType: params.contentType,
  });
  ctx.store.refArtifact(ctx.sandboxId, accepted.sha256, {
    name: params.name ?? '',
    kind: params.kind,
  });
  ctx.audit?.append({
    actor: 'broker',
    action: 'artifact.put',
    sandboxId: ctx.sandboxId,
    data: { sha256: accepted.sha256, size: accepted.size, name: params.name ?? '' },
  });
  return { sha256: accepted.sha256, size: accepted.size };
}

/** @param {object} ctx @param {{sha256: string}} params */
export function artifactGet(ctx, params) {
  const mine = ctx.store.listArtifacts(ctx.sandboxId, { limit: 1000 });
  if (!mine.items.some((a) => a.sha256 === params.sha256)) {
    // Also allow artifacts this sandbox produced as evidence logs.
    const art = ctx.store.getArtifact(params.sha256);
    if (!art) return deliver(ctx, params);
  }
  return deliver(ctx, params);
}

function deliver(ctx, params) {
  const out = deliverToInbox({
    artifactsDir: ctx.artifactsDir,
    inboxDir: ctx.inboxDir,
    sha256: params.sha256,
  });
  ctx.audit?.append({
    actor: 'broker',
    action: 'artifact.get',
    sandboxId: ctx.sandboxId,
    data: { sha256: params.sha256 },
  });
  return out;
}

/** @param {object} ctx @param {{limit?: number, cursor?: string}} params */
export function artifactList(ctx, params) {
  return ctx.store.listArtifacts(ctx.sandboxId, { limit: params.limit, cursor: params.cursor });
}
