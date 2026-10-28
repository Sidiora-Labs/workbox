import {
  statusCommand,
  sessionCommand,
  runCommand,
  askCommand,
  secretCommand,
  eventCommand,
  leaseCommand,
  checkpointCommand,
  artifactCommand,
  netCommand,
  presetCommand,
} from './commands.js';

/**
 * The single command table. `--help`, `wb tools` and `docs/wb.md` are all generated from it,
 * so the reference cannot drift from the implementation.
 * @typedef {{name: string, summary: string, usage: string, run: (ctx: object, argv: string[]) => unknown}} Command
 */

/** @type {Command[]} */
export const COMMANDS = Object.freeze([
  {
    name: 'status',
    summary: 'Sandbox id, boot id, limits, usage and network mode',
    usage: 'wb status [--json]',
    run: statusCommand,
  },
  { name: 'tools', summary: 'List every wb subcommand', usage: 'wb tools [--json]', run: null },
  {
    name: 'help',
    summary: 'Show help for wb or one subcommand',
    usage: 'wb help [command]',
    run: null,
  },
  {
    name: 'session',
    summary: 'Durable sessions: start|list|attach|input|stop',
    usage: 'wb session start [--name n] [--cwd d] [--env K=V] [--pty] -- <cmd...>',
    run: sessionCommand,
  },
  {
    name: 'run',
    summary: 'Run a command and record an evidence envelope',
    usage: 'wb run -- <cmd...>',
    run: runCommand,
  },
  {
    name: 'ask',
    summary: 'Ask a human: raise|status|list|wait',
    usage: 'wb ask raise --kind question|decision|permission|secret [--option o] <title>',
    run: askCommand,
  },
  {
    name: 'secret',
    summary: 'Brokered secrets: exec|list (values injected into the child only)',
    usage: 'wb secret exec <ref>... -- <cmd...> | wb secret list',
    run: secretCommand,
  },
  {
    name: 'event',
    summary: 'Append a structured event',
    usage: 'wb event emit <type> [json]',
    run: eventCommand,
  },
  {
    name: 'lease',
    summary: 'Lease status|renew',
    usage: 'wb lease status | wb lease renew [--ttl-ms n]',
    run: leaseCommand,
  },
  {
    name: 'checkpoint',
    summary: 'Checkpoint create|list',
    usage: 'wb checkpoint create [--name n] | wb checkpoint list',
    run: checkpointCommand,
  },
  {
    name: 'artifact',
    summary: 'Artifacts: put|get|list',
    usage: 'wb artifact put <file> | get <sha256> [dest] | list',
    run: artifactCommand,
  },
  {
    name: 'net',
    summary: 'Network policy|test',
    usage: 'wb net policy | wb net test <host> <port>',
    run: netCommand,
  },
  {
    name: 'preset',
    summary: 'Toolchain presets: list|install',
    usage: 'wb preset list | wb preset install <web|python|rust|go|system|agents>',
    run: presetCommand,
  },
]);

/** @param {string} name */
export function findCommand(name) {
  return COMMANDS.find((c) => c.name === name) ?? null;
}

/** Machine-readable tool list (`wb tools --json`). */
export function toolsJson() {
  return {
    schema: 1,
    tools: COMMANDS.map(({ name, summary, usage }) => ({ name, summary, usage })),
  };
}

/** Human-readable tool list. */
export function toolsText() {
  return COMMANDS.map((c) => `${c.name.padEnd(11)}${c.summary}`).join('\n');
}

/** @param {Command} cmd */
export function helpFor(cmd) {
  return `${cmd.name} — ${cmd.summary}\n\nUsage:\n  ${cmd.usage}\n\nEvery subcommand accepts --help and --json.`;
}
