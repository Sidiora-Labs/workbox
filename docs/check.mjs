#!/usr/bin/env node
/** Fail when docs/wb.md is stale or a relative doc link is dead. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderWbDoc } from './gen-wb.mjs';

const docs = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(docs, '..');
const problems = [];

const expected = renderWbDoc();
const actual = fs.existsSync(path.join(docs, 'wb.md')) ? fs.readFileSync(path.join(docs, 'wb.md'), 'utf8') : '';
if (actual !== expected) problems.push('docs/wb.md is stale; run: node docs/gen-wb.mjs');

for (const name of ['architecture.md', 'security.md', 'wb.md', 'hyperfide-provider.md', 'operations.md', 'measurements.md']) {
  if (!fs.existsSync(path.join(docs, name))) problems.push(`missing docs/${name}`);
}

for (const file of collectMd(root)) {
  const text = fs.readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|#|mailto:)/.test(target)) continue;
    const clean = target.split('#')[0];
    if (!clean) continue;
    const resolved = clean.startsWith('/') ? clean : path.resolve(path.dirname(file), clean);
    if (!fs.existsSync(resolved)) problems.push(`${path.relative(root, file)}: dead link ${target}`);
  }
}

function collectMd(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectMd(p, out);
    else if (e.name.endsWith('.md') && (p.includes(`${path.sep}docs${path.sep}`) || e.name === 'README.md')) out.push(p);
  }
  return out;
}

if (problems.length) {
  for (const p of problems) console.error(`docs/check: ${p}`);
  process.exit(1);
}
console.log('docs/check: ok');
