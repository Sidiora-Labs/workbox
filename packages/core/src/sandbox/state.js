import { E } from '../errors.js';

/** Desired lifecycle states of a sandbox. */
export const States = Object.freeze({
  REQUESTED: 'REQUESTED',
  PROVISIONING: 'PROVISIONING',
  BOOTSTRAPPING: 'BOOTSTRAPPING',
  READY: 'READY',
  DRAINING: 'DRAINING',
  DELETING: 'DELETING',
  DELETED: 'DELETED',
  QUARANTINED: 'QUARANTINED',
});

/** Observed health, independent of desired state. */
export const Health = Object.freeze({
  HEALTHY: 'HEALTHY',
  SUSPECT: 'SUSPECT',
  UNKNOWN: 'UNKNOWN',
  ABSENT: 'ABSENT',
});

/** Legal transitions: from -> allowed targets. */
export const TRANSITIONS = Object.freeze({
  REQUESTED: Object.freeze(['PROVISIONING', 'DELETING']),
  PROVISIONING: Object.freeze(['BOOTSTRAPPING', 'QUARANTINED', 'DELETING']),
  BOOTSTRAPPING: Object.freeze(['READY', 'QUARANTINED', 'DELETING']),
  READY: Object.freeze(['DRAINING', 'QUARANTINED', 'DELETING']),
  DRAINING: Object.freeze(['DELETING', 'QUARANTINED']),
  QUARANTINED: Object.freeze(['DRAINING', 'DELETING']),
  DELETING: Object.freeze(['DELETED', 'QUARANTINED']),
  DELETED: Object.freeze([]),
});

/** States in which sandbox processes are expected to exist. */
export const LIVE_STATES = Object.freeze([
  'PROVISIONING',
  'BOOTSTRAPPING',
  'READY',
  'DRAINING',
  'QUARANTINED',
]);

/**
 * @param {string} from
 * @param {string} to
 */
export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/**
 * @param {string} from
 * @param {string} to
 * @throws {import('../errors.js').WorkboxError} E_STATE with from, to and allowed
 */
export function assertTransition(from, to) {
  if (!(to in States)) throw E.invalid(`unknown state ${to}`, { to });
  if (!canTransition(from, to)) {
    throw E.state(`cannot move sandbox from ${from} to ${to}`, {
      from,
      to,
      allowed: TRANSITIONS[from] ?? [],
    });
  }
}

/** @param {string} state */
export function isLive(state) {
  return LIVE_STATES.includes(state);
}

/** @param {string} state */
export function isTerminal(state) {
  return state === States.DELETED;
}
