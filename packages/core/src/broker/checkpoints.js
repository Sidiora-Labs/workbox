import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { E } from '../errors.js';

/**
 * Checkpoints: a tar of the sandbox upper layer plus an envelope JSON with its digest.
 * `create`/`list` are broker (wb) surface; `restore` is host-side only (manager/CLI/server).
 * Extraction is guarded: the archive listing is checked first and any absolute, `..` or
 * device entry refuses the restore.
 */

async function run(argv, opts = {}) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  let out = '';
  let err = '';
  child.stdout?.on('data', (d) => {
    if (out.length < 1024 * 1024) out += d;
  });
  child.stderr?.on('data', (d) => {
    err += d;
  });
  const [code] = await once(child, 'close');
  if (code !== 0) throw E.unavailable(`${argv[0]} failed (${code}): ${err.trim().slice(-500)}`);
  return out;
}

/** @param {string} file */
export async function sha256OfFile(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (d) => hash.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return hash.digest('hex');
}

/**
 * Reject dangerous tar member names.
 * @param {string[]} names
 */
export function assertSafeTarNames(names) {
  for (const n of names) {
    if (n.startsWith('/') || n.split('/').includes('..') || n.includes('\0'))
      throw E.denied(`checkpoint archive contains unsafe path ${n}`, { name: n });
  }
  if (names.length > 1_000_000) throw E.limit('checkpoint archive has too many entries');
  return names;
}

async function waitFrozen(cgroupPath, want, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const events = fs.readFileSync(path.join(cgroupPath, 'cgroup.events'), 'utf8');
    if (new RegExp(`(^|\\n)frozen ${want}(\\n|$)`).test(events)) return;
    if (Date.now() >= deadline)
      throw E.busy(`sandbox cgroup did not reach frozen=${want} within ${timeoutMs} ms`);
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  }
}

/**
 * Run `fn` with every process of the sandbox cgroup frozen, so a running writer cannot tear the
 * archive. A context without a cgroup has no live processes and runs `fn` directly; a cgroup that
 * cannot be frozen refuses the checkpoint rather than archiving it live.
 * @param {string|undefined} cgroupPath @param {() => Promise<unknown>} fn
 */
export async function withQuiesced(cgroupPath, fn) {
  if (!cgroupPath) return fn();
  const freeze = path.join(cgroupPath, 'cgroup.freeze');
  if (!fs.existsSync(freeze))
    throw E.unavailable('sandbox cannot be quiesced for a consistent checkpoint');
  fs.writeFileSync(freeze, '1');
  try {
    await waitFrozen(cgroupPath, 1, 5_000);
    return await fn();
  } finally {
    fs.writeFileSync(freeze, '0');
  }
}

/** @param {object} ctx @param {{name?: string, summary?: string, paths?: string[]}} params */
export async function checkpointCreate(ctx, params) {
  if (!ctx.upperDir || !fs.existsSync(ctx.upperDir))
    throw E.unavailable('sandbox upper directory is not available for checkpointing');
  fs.mkdirSync(ctx.checkpointsDir, { recursive: true });
  const stamp = `${Date.now()}`;
  const tarFile = path.join(ctx.checkpointsDir, `${ctx.sandboxId}-${stamp}.tar`);
  const members = params.paths?.length ? params.paths.map((p) => p.replace(/^\//, '')) : ['.'];
  assertSafeTarNames(members);
  try {
    await withQuiesced(ctx.cgroupPath, () =>
      run(['tar', '-cf', tarFile, '-C', ctx.upperDir, ...members]),
    );
  } catch (e) {
    fs.rmSync(tarFile, { force: true });
    throw e;
  }
  const sha256 = await sha256OfFile(tarFile);
  const size = fs.statSync(tarFile).size;
  const envelope = {
    name: params.name ?? null,
    summary: params.summary ?? null,
    paths: members,
    tar: path.basename(tarFile),
    createdAt: Date.now(),
  };
  const row = ctx.store.addCheckpoint({
    sandboxId: ctx.sandboxId,
    name: params.name,
    sha256,
    size,
    envelope,
  });
  ctx.audit?.append({
    actor: 'broker',
    action: 'checkpoint.create',
    sandboxId: ctx.sandboxId,
    data: { id: row.id, sha256, size },
  });
  return { id: row.id, sha256, size, name: row.name, createdAt: row.createdAt };
}

/** @param {object} ctx */
export function checkpointList(ctx) {
  return {
    checkpoints: ctx.store.listCheckpoints(ctx.sandboxId).map((c) => ({
      id: c.id,
      name: c.name,
      sha256: c.sha256,
      size: c.size,
      createdAt: c.createdAt,
    })),
  };
}

/**
 * Host-side restore: extract a checkpoint tar into a target upper directory.
 * @param {object} ctx @param {string} checkpointId @param {string} targetUpper
 */
export async function checkpointRestore(ctx, checkpointId, targetUpper) {
  const cp = ctx.store.getCheckpoint(checkpointId);
  if (!cp) throw E.notFound(`checkpoint ${checkpointId} not found`, { checkpointId });
  const tarFile = path.join(ctx.checkpointsDir, cp.envelope.tar);
  if (!fs.existsSync(tarFile)) throw E.notFound(`checkpoint archive ${cp.envelope.tar} is missing`);
  const digest = await sha256OfFile(tarFile);
  if (digest !== cp.sha256) throw E.state('checkpoint archive digest mismatch', { checkpointId });
  const listing = await run(['tar', '-tf', tarFile]);
  assertSafeTarNames(listing.split('\n').filter(Boolean));
  fs.mkdirSync(targetUpper, { recursive: true });
  await run(['tar', '-xf', tarFile, '-C', targetUpper, '--no-same-permissions']);
  ctx.audit?.append({
    actor: 'host',
    action: 'checkpoint.restore',
    sandboxId: cp.sandboxId,
    data: { checkpointId, targetUpper },
  });
  return { checkpointId, restoredTo: targetUpper, sha256: digest };
}
