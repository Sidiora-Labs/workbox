#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { WorkboxClient } from '@workbox/sdk';
import { VERSION, runStdio } from './server.js';

/** Server the MCP bridge talks to when WORKBOX_SERVER is unset. */
export const DEFAULT_SERVER = 'http://127.0.0.1:8790';

/**
 * `workbox-mcp`: MCP over stdio, bridged through the SDK to the Workbox server named by
 * WORKBOX_SERVER with the bearer token in WORKBOX_TOKEN. `--version` prints the version.
 * @param {{argv?: string[], env?: NodeJS.ProcessEnv, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} [opts]
 * @returns {Promise<void>} resolves once the input has ended and every reply is written
 */
export function main(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const env = opts.env ?? process.env;
  const output = opts.output ?? process.stdout;
  if (argv.includes('--version')) {
    output.write(`workbox-mcp ${VERSION}\n`);
    return Promise.resolve();
  }
  const client = new WorkboxClient({
    baseUrl: env.WORKBOX_SERVER || DEFAULT_SERVER,
    token: env.WORKBOX_TOKEN ?? '',
  });
  return runStdio({ client, input: opts.input ?? process.stdin, output });
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
