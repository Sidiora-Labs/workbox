#!/usr/bin/env node
/** Regenerate docs/wb.md from `wb tools --json` (the wb registry). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toolsJson } from '../packages/wb/src/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export function renderWbDoc() {
  const { tools } = toolsJson();
  const lines = [
    '# wb reference',
    '',
    'Generated from `wb tools --json` by docs/gen-wb.mjs — do not edit by hand.',
    'Every subcommand accepts `--help` and `--json`. Diagnostics go to stderr.',
    'Exit codes: 0 ok, 1 internal, 2 usage, 3 not found, 4 denied/unavailable, 5 timeout.',
    '`wb run` propagates the wrapped command exit code.',
    '',
    '| Command | Summary | Usage |',
    '|---|---|---|',
    ...tools.map((t) => `| \`${t.name}\` | ${t.summary} | \`${t.usage}\` |`),
    '',
  ];
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  fs.writeFileSync(path.join(here, 'wb.md'), renderWbDoc());
  console.log('docs/wb.md regenerated');
}
