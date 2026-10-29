#!/usr/bin/env node
/**
 * Regenerate docs/reference/openapi.json from the server's own document (`buildOpenApi` in
 * packages/server/src/openapi.js), pretty-printed and formatted with the repo's prettier config
 * so the file is stable under `prettier --write`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { SERVER_VERSION, buildOpenApi } from '../packages/server/src/openapi.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Path of the checked-in document. */
export const OPENAPI_DOC = path.join(here, 'reference', 'openapi.json');

/** The complete docs/reference/openapi.json text. @returns {Promise<string>} */
export async function renderOpenApiDoc() {
  const doc = buildOpenApi({ version: SERVER_VERSION });
  const options = (await resolveConfig(OPENAPI_DOC)) ?? {};
  return format(`${JSON.stringify(doc, null, 2)}\n`, { ...options, filepath: OPENAPI_DOC });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  fs.writeFileSync(OPENAPI_DOC, await renderOpenApiDoc());
  console.log('docs/reference/openapi.json regenerated');
}
