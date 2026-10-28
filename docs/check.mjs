#!/usr/bin/env node
/**
 * Documentation gate (spec task 4.2): every required page exists, docs/wb.md equals what
 * docs/gen-wb.mjs renders from `wb tools --json`, and every relative link and anchor in README.md
 * and docs/ resolves, and every page under docs/ is reachable from docs/README.md. Before trusting the staleness check it proves, on a temporary copy, that a
 * deliberately staled wb.md is caught and the current one is not.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WB_DOC, renderWbDoc } from './gen-wb.mjs';

const docs = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(docs, '..');

/** Pages req 7 ac_4 and the README require. */
export const REQUIRED = Object.freeze([
  'architecture.md',
  'security.md',
  'wb.md',
  'hyperfide-provider.md',
  'operations.md',
  'measurements.md',
]);

/**
 * @param {string} file a wb.md candidate
 * @param {string} expected the rendered reference
 * @returns {string|null} the problem, or null when the file is current
 */
export function wbStaleness(file, expected) {
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (actual === expected) return null;
  const name = path.relative(root, file);
  return `${name} is stale or missing; run: node docs/gen-wb.mjs`;
}

/**
 * Self-test of the staleness check on a temporary copy: a wb.md with one command row removed must
 * be flagged, an exact copy must pass.
 * @param {string} expected
 * @returns {string[]} problems with the checker itself
 */
export function selfTest(expected) {
  const problems = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbox-docs-check-'));
  const copy = path.join(dir, 'wb.md');
  try {
    const rows = expected.split('\n');
    const row = rows.findIndex((l) => l.startsWith('| `'));
    if (row === -1) problems.push('self-test: the rendered wb.md has no command rows');
    fs.writeFileSync(copy, rows.filter((_, i) => i !== row).join('\n'));
    if (wbStaleness(copy, expected) === null)
      problems.push('self-test: a staled wb.md copy was not detected');
    fs.writeFileSync(copy, expected);
    if (wbStaleness(copy, expected) !== null)
      problems.push('self-test: a current wb.md copy was reported stale');
  } finally {
    if (fs.existsSync(copy)) fs.unlinkSync(copy);
    fs.rmdirSync(dir);
  }
  return problems;
}

/** Markdown files the gate covers: README.md and everything under docs/. */
export function collectMd() {
  const out = [path.join(root, 'README.md')];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(docs);
  return out;
}

/** Markdown text with fenced code blocks blanked out. @param {string} text */
export function stripFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m && (fence === null || m[1].startsWith(fence))) {
      fence = fence === null ? m[1] : null;
      kept.push('');
    } else kept.push(fence === null ? line : '');
  }
  return kept.join('\n');
}

/** Markdown text with fenced code blocks and inline code spans blanked out. @param {string} text */
export function stripCode(text) {
  return stripFences(text)
    .split('\n')
    .map((line) => line.replace(/(`+)[\s\S]*?\1/g, ''))
    .join('\n');
}

/**
 * GitHub heading anchors of a markdown document, duplicates suffixed -1, -2, ...
 * @param {string} text
 * @returns {Set<string>}
 */
export function anchorsOf(text) {
  const seen = new Map();
  const out = new Set();
  for (const line of stripFences(text).split('\n')) {
    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const base = h[1]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Link targets of a markdown document: inline links and reference definitions. @param {string} text */
export function linksOf(text) {
  const body = stripCode(text);
  const out = [];
  for (const m of body.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
    out.push(m[1]);
  for (const m of body.matchAll(/^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm))
    out.push(m[1]);
  return out;
}

/**
 * Problems with one link of `file`.
 * @param {string} file
 * @param {string} target
 * @returns {string|null}
 */
export function linkProblem(file, target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const hash = target.indexOf('#');
  const rawPath = hash === -1 ? target : target.slice(0, hash);
  const anchor = hash === -1 ? null : decodeURIComponent(target.slice(hash + 1));
  const resolved = rawPath ? path.resolve(path.dirname(file), decodeURIComponent(rawPath)) : file;
  const where = path.relative(root, file);
  if (!fs.existsSync(resolved)) return `${where}: dead link ${target}`;
  if (anchor === null) return null;
  if (!resolved.endsWith('.md') || fs.statSync(resolved).isDirectory())
    return `${where}: anchor on a non-markdown target ${target}`;
  if (!anchorsOf(fs.readFileSync(resolved, 'utf8')).has(anchor))
    return `${where}: no heading for anchor ${target}`;
  return null;
}

/**
 * Pages under docs/ that docs/README.md does not reach by following relative markdown links.
 * @param {string[]} files markdown files covered by the gate
 * @returns {string[]} problems, one per unreachable page, or one when the index is missing
 */
export function unreachablePages(files) {
  const index = path.join(docs, 'README.md');
  if (!fs.existsSync(index)) return ['missing docs/README.md, the documentation index'];
  const seen = new Set([index]);
  const queue = [index];
  while (queue.length) {
    const file = queue.pop();
    for (const target of linksOf(fs.readFileSync(file, 'utf8'))) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const rawPath = target.split('#')[0];
      if (!rawPath) continue;
      const next = path.resolve(path.dirname(file), decodeURIComponent(rawPath));
      if (!next.endsWith('.md') || seen.has(next) || !fs.existsSync(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return files
    .filter((f) => f.startsWith(docs + path.sep) && !seen.has(f))
    .map((f) => `${path.relative(root, f)} is not reachable from docs/README.md`);
}

/** Run every check. @returns {Promise<string[]>} */
export async function check() {
  const problems = [];
  for (const name of REQUIRED)
    if (!fs.existsSync(path.join(docs, name))) problems.push(`missing docs/${name}`);
  const expected = await renderWbDoc();
  problems.push(...selfTest(expected));
  const stale = wbStaleness(WB_DOC, expected);
  if (stale) problems.push(stale);
  const files = collectMd();
  problems.push(...unreachablePages(files));
  for (const file of files) {
    if (!fs.existsSync(file)) {
      problems.push(`missing ${path.relative(root, file)}`);
      continue;
    }
    for (const target of linksOf(fs.readFileSync(file, 'utf8'))) {
      const problem = linkProblem(file, target);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const problems = await check();
  for (const p of problems) console.error(`docs/check: ${p}`);
  if (problems.length) process.exit(1);
  console.log('docs/check: ok');
}
