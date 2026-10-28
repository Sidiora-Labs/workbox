#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { WorkboxClient } from '@workbox/sdk';
import { runStdio } from './server.js';

/** @param {{env?: NodeJS.ProcessEnv}} [opts] */
export function main(opts = {}) {
  const env = opts.env ?? process.env;
  if ((env._WB_MCP_ARGS ?? '').includes('--version')) {
    process.stdout.write('workbox-mcp 0.1.0-dev\n');
    return null;
  }
  const client = new WorkboxClient({
    baseUrl: env.WORKBOX_SERVER ?? 'http://127.0.0.1:8790',
    token: env.WORKBOX_TOKEN ?? '',
  });
  return runStdio({ client });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--version')) process.stdout.write('workbox-mcp 0.1.0-dev\n');
  else main();
}
