import { E } from '../errors.js';
import { assertBoundedJson } from './events.js';

/**
 * `broker.preset.manifest`: mirror a wb preset preparation manifest into the host store, as sent,
 * so the in-box file and the host row carry the same versions and digests. The shape is checked:
 * a status of `ok` or `failed`, and per tool a version, the installed path and its sha256.
 */

/** Known preset names (recipes live in wb). */
export const PRESET_NAMES = Object.freeze(['web', 'python', 'rust', 'go', 'system', 'agents']);

const SHA256_RE = /^[0-9a-f]{64}$/;

function assertTools(tools) {
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools))
    throw E.invalid('preset manifest tools must be an object', { field: 'manifest.tools' });
  for (const [tool, entry] of Object.entries(tools)) {
    const ok =
      typeof entry?.version === 'string' &&
      entry.version.length > 0 &&
      typeof entry.path === 'string' &&
      SHA256_RE.test(String(entry.sha256));
    if (!ok)
      throw E.invalid(`preset manifest tool ${tool} needs a version, path and sha256`, {
        field: `manifest.tools.${tool}`,
      });
  }
}

/** @param {object} ctx @param {{name: string, manifest: object}} params */
export function presetManifest(ctx, params) {
  if (!PRESET_NAMES.includes(params.name))
    throw E.invalid(`unknown preset ${params.name}`, { known: [...PRESET_NAMES] });
  assertBoundedJson(params.manifest);
  const bytes = Buffer.byteLength(JSON.stringify(params.manifest));
  if (bytes > 256 * 1024) throw E.limit('preset manifest too large', { bytes });
  const { status, tools } = params.manifest;
  if (status !== 'ok' && status !== 'failed')
    throw E.invalid('preset manifest status must be ok or failed', { field: 'manifest.status' });
  assertTools(tools);
  ctx.store.upsertPreset(ctx.sandboxId, params.name, params.manifest);
  ctx.audit?.append({
    actor: 'broker',
    action: 'preset.manifest',
    sandboxId: ctx.sandboxId,
    data: {
      name: params.name,
      status,
      digest: typeof params.manifest.digest === 'string' ? params.manifest.digest : null,
    },
  });
  return { name: params.name, mirrored: true };
}
