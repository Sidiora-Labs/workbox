import { validateParams } from '@workbox/protocol';
import { brokerStatus } from './status.js';
import { recordEvidence } from './evidence.js';
import { artifactPut, artifactGet, artifactList } from './artifacts.js';
import { askRaise, askStatus, askList, askWait } from './asks.js';
import { secretList, secretResolve } from './secrets.js';
import { eventEmit } from './events.js';
import { leaseStatus, leaseRenew } from './leases.js';
import { checkpointCreate, checkpointList } from './checkpoints.js';
import { presetManifest } from './presets.js';
import { netPolicy, netTest } from './net.js';

export { brokerStatus } from './status.js';
export { recordEvidence, validateEnvelope } from './evidence.js';
export { artifactPut, artifactGet, artifactList } from './artifacts.js';
export {
  askRaise,
  askStatus,
  askList,
  askWait,
  answerAskHost,
  validateAnswer,
  publicAsk,
} from './asks.js';
export { secretList, secretResolve } from './secrets.js';
export {
  eventEmit,
  assertBoundedJson,
  appendLogged,
  MAX_EVENT_PAYLOAD_BYTES,
  RESERVED_EVENT_PREFIXES,
} from './events.js';
export { leaseStatus, leaseRenew, issueLease, hashToken } from './leases.js';
export {
  checkpointCreate,
  checkpointList,
  checkpointRestore,
  assertSafeTarNames,
  sha256OfFile,
  withQuiesced,
} from './checkpoints.js';
export { stdoutChannel, webhookChannel, notifyAsk } from './channels.js';
export { presetManifest, PRESET_NAMES } from './presets.js';
export { netPolicy, netTest } from './net.js';
export {
  acceptOutboxFile,
  deliverToInbox,
  artifactPath,
  assertOutboxName,
  DEFAULT_MAX_ARTIFACT_BYTES,
} from './outbox.js';

/**
 * @typedef {object} BrokerContext
 * @property {import('../store.js').Store} store
 * @property {import('../audit.js').Audit} [audit]
 * @property {string} sandboxId
 * @property {string} outboxDir shared run/outbox
 * @property {string} inboxDir shared run/inbox
 * @property {string} artifactsDir content-addressed store root
 * @property {string} checkpointsDir
 * @property {string} [upperDir] sandbox upper layer (checkpoints)
 * @property {string} [cgroupPath] sandbox cgroup, frozen while a checkpoint is archived
 * @property {{base: number, count: number}} [uidRange] mapped owner range for outbox files
 * @property {import('../secrets.js').SecretProvider} [secrets]
 * @property {object} [limits]
 * @property {object} [network]
 * @property {() => object} [usage]
 * @property {number} [leaseTtlMs]
 * @property {number} [maxArtifactBytes]
 * @property {() => number} [clock]
 * @property {(ask: object) => void} [onAsk]
 * @property {(type: string, payload?: object, opts?: {causation?: string, source?: 'host'|'wb'}) => {seq: number}} [logEvent]
 *   append to this sandbox's event log and announce the row
 * @property {(host: string, port: number, timeoutMs: number) => Promise<object>} [netProbe]
 */

/** Method name -> handler over a BrokerContext. */
export const BROKER_HANDLERS = Object.freeze({
  'broker.status': (ctx) => brokerStatus(ctx),
  'broker.evidence.record': recordEvidence,
  'broker.artifact.put': artifactPut,
  'broker.artifact.get': artifactGet,
  'broker.artifact.list': artifactList,
  'broker.ask.raise': askRaise,
  'broker.ask.status': askStatus,
  'broker.ask.list': askList,
  'broker.ask.wait': (ctx, p, opts) => askWait(ctx, p, opts),
  'broker.secret.list': (ctx) => secretList(ctx),
  'broker.secret.resolve': secretResolve,
  'broker.event.emit': eventEmit,
  'broker.lease.status': (ctx) => leaseStatus(ctx),
  'broker.lease.renew': leaseRenew,
  'broker.checkpoint.create': checkpointCreate,
  'broker.checkpoint.list': (ctx) => checkpointList(ctx),
  'broker.net.policy': (ctx) => netPolicy(ctx),
  'broker.net.test': netTest,
  'broker.preset.manifest': presetManifest,
});

/**
 * Register every broker handler on a control Peer, validating params with the protocol schemas.
 * @param {import('@workbox/protocol').Peer} peer
 * @param {BrokerContext} ctx
 */
export function registerBrokerHandlers(peer, ctx) {
  for (const [method, handler] of Object.entries(BROKER_HANDLERS)) {
    peer.handle(method, (params, hctx) =>
      handler(ctx, validateParams(method, params), { signal: hctx?.signal }),
    );
  }
  return peer;
}
