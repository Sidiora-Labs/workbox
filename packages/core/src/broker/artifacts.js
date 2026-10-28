import { E } from '../errors.js';
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

/**
 * Deliver an artifact into this sandbox's inbox. Only artifacts this sandbox references are
 * readable; a digest held by another sandbox reads as not found and is never delivered.
 * @param {object} ctx @param {{sha256: string}} params
 */
export function artifactGet(ctx, params) {
  if (!ctx.store.hasArtifactRef(ctx.sandboxId, params.sha256)) {
    ctx.audit?.append({
      actor: 'broker',
      action: 'artifact.get.denied',
      sandboxId: ctx.sandboxId,
      data: { sha256: params.sha256 },
    });
    throw E.notFound(`artifact ${params.sha256} not found`, { sha256: params.sha256 });
  }
  return deliver(ctx, params);
}

function deliver(ctx, params) {
  const out = deliverToInbox({
    artifactsDir: ctx.artifactsDir,
    inboxDir: ctx.inboxDir,
    sha256: params.sha256,
    uidRange: ctx.uidRange,
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
