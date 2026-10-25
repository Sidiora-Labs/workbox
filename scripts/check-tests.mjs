#!/usr/bin/env node
/**
 * The 1:1 test gate. Fails unless:
 *   - every packages/<p>/src/**\/*.js has packages/<p>/test/unit/<same relative path>.test.js
 *   - every non-stub package has at least one test/integration/*.test.js
 *   - once the server package is real, test/e2e holds at least one *.test.js
 * A stub package is one whose src/ is only index.js exporting nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = path.join(root, 'packages');
const problems = [];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

function isStub(pkgDir) {
  const files = walk(path.join(pkgDir, 'src'));
  if (files.length !== 1 || path.basename(files[0]) !== 'index.js') return false;
  return fs.readFileSync(files[0], 'utf8').trim() === 'export {};';
}

const packages = fs
  .readdirSync(packagesDir)
  .filter((n) => fs.statSync(path.join(packagesDir, n)).isDirectory());
let checked = 0;
for (const name of packages) {
  const pkgDir = path.join(packagesDir, name);
  if (isStub(pkgDir)) continue;
  const srcDir = path.join(pkgDir, 'src');
  for (const file of walk(srcDir)) {
    const rel = path.relative(srcDir, file);
    const expected = path.join(pkgDir, 'test', 'unit', rel.replace(/\.js$/, '.test.js'));
    checked++;
    if (!fs.existsSync(expected))
      problems.push(
        `${name}: ${rel} has no unit test at test/unit/${path.relative(path.join(pkgDir, 'test', 'unit'), expected)}`,
      );
  }
  const integration = walk(path.join(pkgDir, 'test', 'integration')).filter((f) =>
    f.endsWith('.test.js'),
  );
  if (integration.length === 0)
    problems.push(`${name}: no integration test under test/integration/`);
  for (const file of walk(path.join(pkgDir, 'test'))) {
    const rel = path.relative(path.join(pkgDir, 'test'), file);
    if (!/^(unit|integration|helpers)\//.test(rel))
      problems.push(`${name}: ${rel} is outside test/unit, test/integration or test/helpers`);
  }
}

if (!isStub(path.join(packagesDir, 'server'))) {
  const e2e = walk(path.join(root, 'test', 'e2e')).filter((f) => f.endsWith('.test.js'));
  if (e2e.length === 0) problems.push('repo: server is real but test/e2e has no *.test.js');
}

if (problems.length) {
  console.error(`check-tests: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-tests: ok (${checked} source modules mapped 1:1, ${packages.length} packages)`);
