import { E } from '@workbox/core';

/**
 * What a principal may see. A principal without a binding sees every sandbox. A bound principal
 * sees a sandbox when its id is in `binding.sandboxIds`, or when every `binding.labels` entry
 * equals the sandbox's label of that name; a binding with neither sees nothing. A sandbox it
 * cannot see answers exactly as one that does not exist.
 */

/**
 * @param {{binding?: object|null}|null|undefined} principal
 * @returns {boolean} true when the principal is limited to some sandboxes
 */
export function isBound(principal) {
  return Boolean(principal?.binding);
}

/**
 * @param {{binding?: {labels?: Record<string, string>, sandboxIds?: readonly string[]}|null}|null|undefined} principal
 * @param {{id: string, labels?: Record<string, unknown>}|null|undefined} row a sandbox row
 * @returns {boolean}
 */
export function sandboxVisible(principal, row) {
  if (!principal || !row) return false;
  const binding = principal.binding;
  if (!binding) return true;
  if (binding.sandboxIds?.includes(row.id)) return true;
  const want = Object.entries(binding.labels ?? {});
  if (!want.length) return false;
  const have = row.labels ?? {};
  return want.every(([k, val]) => Object.hasOwn(have, k) && have[k] === val);
}

/**
 * Refuse a bound principal with E_DENIED (403): for routes that act on the whole fleet.
 * @param {{binding?: object|null}|null|undefined} principal
 */
export function requireUnbound(principal) {
  if (isBound(principal))
    throw E.denied('this route needs a key that is not bound to sandboxes', {
      principal: principal.id,
    });
}

/**
 * The labels a sandbox created by this principal gets: a label-bound principal's binding labels
 * are forced onto the request's. A request label that conflicts with the binding is E_DENIED, and
 * so is any create by a principal bound only by sandbox ids. An unbound principal's labels pass
 * through unchanged.
 * @param {{id?: string, binding?: {labels?: Record<string, string>, sandboxIds?: readonly string[]}|null}|null|undefined} principal
 * @param {Record<string, string>|undefined} labels the labels in the create request
 * @returns {Record<string, string>|undefined}
 */
export function createLabels(principal, labels) {
  const binding = principal?.binding;
  if (!binding) return labels;
  const forced = Object.entries(binding.labels ?? {});
  if (!forced.length)
    throw E.denied('a key bound to sandbox ids cannot create sandboxes', {
      principal: principal.id,
    });
  const out = { ...(labels ?? {}) };
  for (const [k, val] of forced) {
    if (Object.hasOwn(out, k) && out[k] !== val)
      throw E.denied(`label ${k} must be ${JSON.stringify(val)} for this key`, { label: k });
    out[k] = val;
  }
  return out;
}
