import { E } from '../errors.js';
import { assertBoundedJson } from './events.js';

/** `broker.preset.manifest`: mirror a wb preset preparation manifest into the host store. */

/** Known preset names (recipes live in wb). */
export const PRESET_NAMES = Object.freeze(['web', 'python', 'rust', 'go', 'system', 'agents']);

/** @param {object} ctx @param {{name: string, manifest: object}} params */
export function presetManifest(ctx, params) {
  if (!PRESET_NAMES.includes(params.name))
    throw E.invalid(`unknown preset ${params.name}`, { known: [...PRESET_NAMES] });
  assertBoundedJson(params.manifest);
  const bytes = Buffer.byteLength(JSON.stringify(params.manifest));
  if (bytes > 256 * 1024) throw E.limit('preset manifest too large', { bytes });
  ctx.store.upsertPreset(ctx.sandboxId, params.name, params.manifest);
  ctx.audit?.append({
    actor: 'broker',
    action: 'preset.manifest',
    sandboxId: ctx.sandboxId,
    data: { name: params.name, status: params.manifest?.status ?? null },
  });
  return { name: params.name, mirrored: true };
}
