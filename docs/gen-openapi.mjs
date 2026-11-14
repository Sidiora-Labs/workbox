#!/usr/bin/env node
/**
 * Regenerate docs/reference/openapi.json and its path-item files from the server's own
 * document. External references keep each generated file small while preserving the full API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { SERVER_VERSION, buildOpenApi } from '../packages/server/src/openapi.js';
import { removeUnder } from '../packages/core/src/host/safefs.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Path of the checked-in document. */
export const OPENAPI_DOC = path.join(here, 'reference', 'openapi.json');

/** Directory of generated path-item documents. */
export const OPENAPI_PARTS = path.join(here, 'reference', 'openapi');

/** All generated OpenAPI files, keyed by absolute path. @returns {Promise<Map<string, string>>} */
export async function renderOpenApiDocs() {
  const doc = buildOpenApi({ version: SERVER_VERSION });
  const options = (await resolveConfig(OPENAPI_DOC)) ?? {};
  const files = new Map();
  for (const [route, item] of Object.entries(doc.paths)) {
    const name = `${Object.values(item)[0].operationId}.json`;
    const file = path.join(OPENAPI_PARTS, name);
    // A fragment's schema references still point at components in the entry document.
    const text = JSON.stringify(item, (key, value) =>
      key === '$ref' && value.startsWith('#/') ? `../openapi.json${value}` : value,
    );
    files.set(file, await format(text, { ...options, filepath: file }));
    doc.paths[route] = { $ref: `./openapi/${name}` };
  }
  files.set(OPENAPI_DOC, await format(JSON.stringify(doc), { ...options, filepath: OPENAPI_DOC }));
  return files;
}

/** The entry document, which references the generated path items. @returns {Promise<string>} */
export async function renderOpenApiDoc() {
  return (await renderOpenApiDocs()).get(OPENAPI_DOC);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = await renderOpenApiDocs();
  fs.mkdirSync(OPENAPI_PARTS, { recursive: true });
  for (const [file, text] of files) fs.writeFileSync(file, text);
  for (const name of fs.readdirSync(OPENAPI_PARTS)) {
    const file = path.join(OPENAPI_PARTS, name);
    if (name.endsWith('.json') && !files.has(file)) removeUnder(OPENAPI_PARTS, file);
  }
  console.log(`${files.size} OpenAPI documentation files regenerated`);
}
