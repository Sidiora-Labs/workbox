import { E } from '../errors.js';

/**
 * `broker.evidence.record`: store a `wb run` evidence envelope. The envelope shape is checked
 * field by field (it arrives as `v.any()` over the wire), bounded, and never trusted blindly.
 */

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * Validate and normalise an evidence envelope.
 * @param {unknown} envelope
 * @returns {object} normalised envelope
 */
function envelopeProblems(e) {
  const problems = [];
  if (!Array.isArray(e.argv) || e.argv.length === 0 || e.argv.some((a) => typeof a !== 'string'))
    problems.push('argv must be a non-empty string array');
  if (typeof e.cwd !== 'string' || e.cwd.length === 0) problems.push('cwd is required');
  if (!(e.exitCode === null || Number.isInteger(e.exitCode)))
    problems.push('exitCode must be int|null');
  if (!(e.signal === null || e.signal === undefined || typeof e.signal === 'string'))
    problems.push('signal must be string|null');
  return problems;
}

function timingProblems(e) {
  const problems = [];
  for (const k of ['startedAt', 'endedAt', 'durationMs'])
    if (!Number.isFinite(e[k]) || e[k] < 0) problems.push(`${k} must be a non-negative number`);
  for (const k of ['stdoutSha256', 'stderrSha256'])
    if (!HEX64.test(String(e[k] ?? ''))) problems.push(`${k} must be a sha256 hex digest`);
  if (e.logSha256 !== undefined && e.logSha256 !== null && !HEX64.test(String(e.logSha256)))
    problems.push('logSha256 must be a sha256 hex digest');
  return problems;
}

export function validateEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope))
    throw E.invalid('evidence envelope must be an object');
  const e = envelope;
  const problems = [...envelopeProblems(e), ...timingProblems(e)];
  if (problems.length)
    throw E.invalid(`invalid evidence envelope: ${problems.join('; ')}`, { problems });
  return {
    argv: e.argv.slice(0, 4096),
    cwd: e.cwd.slice(0, 4096),
    exitCode: e.exitCode ?? null,
    signal: e.signal ?? null,
    startedAt: e.startedAt,
    endedAt: e.endedAt,
    durationMs: e.durationMs,
    peakRssBytes: Number.isFinite(e.peakRssBytes) ? e.peakRssBytes : null,
    stdoutSha256: e.stdoutSha256,
    stderrSha256: e.stderrSha256,
    logSha256: e.logSha256 ?? null,
  };
}

/** @param {object} ctx @param {{envelope: object}} params */
export function recordEvidence(ctx, params) {
  const envelope = validateEnvelope(params.envelope);
  const row = ctx.store.recordEvidence({
    sandboxId: ctx.sandboxId,
    envelope,
    logSha256: envelope.logSha256 ?? undefined,
  });
  ctx.audit?.append({
    actor: 'broker',
    action: 'evidence.record',
    sandboxId: ctx.sandboxId,
    data: { id: row.id, argv: envelope.argv[0], exitCode: envelope.exitCode },
  });
  return { id: row.id, createdAt: row.createdAt };
}
