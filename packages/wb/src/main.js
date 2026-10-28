#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { ProtocolError, Codes } from '@workbox/protocol';
import { WbClient } from './client.js';
import { COMMANDS, findCommand, toolsJson, toolsText, helpFor } from './registry.js';

/** wb version string. */
export const WB_VERSION = '0.1.0-dev';

/**
 * Stable exit codes (plan E2): 0 ok, 1 internal, 2 usage, 3 not-found, 4 denied/unavailable,
 * 5 timeout. `wb run` propagates the wrapped command's own non-zero exit through `exitCode`.
 * @param {string} code protocol error code
 */
export function exitCodeFor(code) {
  switch (code) {
    case Codes.INVALID_PARAMS:
    case Codes.UNKNOWN_METHOD:
    case Codes.PARSE:
      return 2;
    case Codes.NOT_FOUND:
      return 3;
    case Codes.DENIED:
    case Codes.QUARANTINED:
    case Codes.UNAVAILABLE:
    case Codes.CLOSED:
      return 4;
    case Codes.TIMEOUT:
      return 5;
    default:
      return 1;
  }
}

/**
 * @param {string[]} argv
 * @param {{client?: WbClient, out?: NodeJS.WriteStream, err?: NodeJS.WriteStream}} [deps]
 * @returns {Promise<number>} exit code
 */
function printResult(out, name, result, json) {
  if (json) out.write(`${JSON.stringify(result ?? null)}\n`);
  else if (result && !['run', 'session', 'secret'].includes(name))
    out.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function dispatch(io, deps, name, rest, json) {
  const { out, err } = io;
  if (!name || name === '--help' || (name === 'help' && rest.length === 0)) {
    out.write(
      `wb — the workbox agent toolkit\n\n${toolsText()}\n\nRun 'wb <command> --help' for one command, or 'wb tools --json'.\n`,
    );
    return 0;
  }
  if (name === 'help') {
    const cmd = findCommand(rest[0]);
    if (!cmd) throw new ProtocolError(Codes.NOT_FOUND, `unknown command ${rest[0]}`);
    out.write(`${helpFor(cmd)}\n`);
    return 0;
  }
  const cmd = findCommand(name);
  if (!cmd)
    throw new ProtocolError(Codes.INVALID_PARAMS, `unknown wb command ${name}`, {
      known: COMMANDS.map((c) => c.name),
    });
  if (rest.includes('--help')) {
    out.write(
      json
        ? `${JSON.stringify({ name: cmd.name, summary: cmd.summary, usage: cmd.usage })}\n`
        : `${helpFor(cmd)}\n`,
    );
    return 0;
  }
  if (name === 'tools') {
    out.write(json ? `${JSON.stringify(toolsJson())}\n` : `${toolsText()}\n`);
    return 0;
  }
  const client = deps.client ?? new WbClient();
  try {
    const result = await cmd.run({ client, out, err }, rest);
    printResult(out, name, result, json);
    return typeof result?.exitCode === 'number' && result.exitCode !== 0 ? result.exitCode : 0;
  } finally {
    if (deps.client === undefined) client.close();
  }
}

export async function main(argv, deps = {}) {
  const out = deps.out ?? process.stdout;
  const err = deps.err ?? process.stderr;
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  try {
    if (args.includes('--version') || args[0] === 'version') {
      out.write(json ? `${JSON.stringify({ version: WB_VERSION })}\n` : `wb ${WB_VERSION}\n`);
      return 0;
    }
    const [name, ...rest] = args;
    return await dispatch({ out, err }, deps, name, rest, json);
  } catch (e) {
    const pe = ProtocolError.from(e);
    if (json) out.write(`${JSON.stringify({ error: pe.toJSON() })}\n`);
    else err.write(`wb: ${pe.message} (${pe.code})\n`);
    return exitCodeFor(pe.code);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
