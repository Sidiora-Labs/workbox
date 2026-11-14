/** Declared command options, validated before any engine or network side effects. */
const spec = (args = '', values = '', flags = '') => ({
  args,
  values: values.split(' ').filter(Boolean),
  flags: flags.split(' ').filter(Boolean),
});

const COMMANDS = {
  doctor: spec(),
  'rootfs build': spec('[name]'),
  'rootfs list': spec(),
  'runtime install': spec('', 'node-version tarball'),
  'runtime list': spec(),
  'sandbox create': spec('', 'name rootfs runtime network idempotency-key'),
  'sandbox ls': spec(),
  'sandbox inspect': spec('<id>'),
  'sandbox rm': spec('<id>'),
  'sandbox drain': spec('<id>'),
  'sandbox events': spec('<id>'),
  'sandbox exec': spec('<id> -- <cmd...>'),
  'sandbox shell': spec('<id>'),
  'sandbox attach': spec('<id> <sessionId>'),
  'sandbox run': spec('<id> -- <cmd...>', 'name', 'wait'),
  'sandbox logs': spec('<id> <sessionId>'),
  'sandbox wait': spec('<id> <sessionId>', 'timeout'),
  'sandbox kill': spec('<id> <sessionId>', 'signal'),
  'sandbox cp': spec('<src> <dest>'),
  shell: spec('<id>'),
  events: spec('', 'sandbox type after', 'follow -f'),
  agent: spec(
    '<claude|codex> [<sandbox-id>]',
    'prompt -p name network allow secret',
    'no-secret detach',
  ),
  'key create': spec('', 'name scope label sandbox ttl'),
  'key ls': spec(),
  'key rm': spec('<keyId>'),
  'webhook add': spec('<url>', 'type sandbox label description'),
  'webhook ls': spec(),
  'webhook rm': spec('<webhookId>'),
  'webhook test': spec('<webhookId>'),
  'webhook rotate': spec('<webhookId>'),
  'webhook deliveries': spec('<webhookId>', 'status limit'),
  serve: spec('', 'config port host tls-cert tls-key'),
  'audit verify': spec(),
};

const ALIASES = {
  'sandbox list': 'sandbox ls',
  'sandbox destroy': 'sandbox rm',
  'key list': 'key ls',
  'key revoke': 'key rm',
  'webhook list': 'webhook ls',
  'webhook create': 'webhook add',
  'webhook delete': 'webhook rm',
  'webhook rotate-secret': 'webhook rotate',
};
const flag = (s) => (s.startsWith('-') ? s : `--${s}`);
const invalid = (message) => Object.assign(new Error(message), { code: 'E_INVALID_PARAMS' });

function usage(key, entry) {
  const options = [
    ...entry.values.map((s) => `[${flag(s)} VALUE]`),
    ...entry.flags.map((s) => `[${flag(s)}]`),
  ];
  return `workbox ${key} ${entry.args} ${options.join(' ')}`.trim();
}

function commandEntry(argv, help) {
  const group = Object.keys(COMMANDS).some((key) => key.startsWith(`${argv[0]} `));
  const given = group ? `${argv[0]} ${argv[1] ?? ''}` : argv[0];
  const key = ALIASES[given] ?? given;
  const entry = COMMANDS[key];
  if (!entry) {
    if (group && help && (!argv[1] || argv[1].startsWith('-')))
      return {
        help: Object.entries(COMMANDS)
          .filter(([k]) => k.startsWith(`${argv[0]} `))
          .map(([k, v]) => usage(k, v))
          .join('\n'),
      };
    throw invalid(`unknown command ${given.trim()}`);
  }
  return { key, entry, group };
}

function validateOptions(args, key, entry) {
  const values = new Set(['--server', '--token', ...entry.values.map(flag)]);
  const flags = new Set([...(key === 'agent' ? [] : ['--json']), ...entry.flags.map(flag)]);
  let operands = 0;
  let bareCommand = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') return { help: true };
    // Preserve the historically supported bare `exec <id> <command...>` spelling.
    if (key === 'sandbox exec' && operands > 0 && !values.has(a) && !flags.has(a)) {
      bareCommand = true;
      break;
    }
    if (values.has(a)) {
      if (i + 1 >= args.length || args[i + 1].startsWith('--'))
        throw invalid(`${a} needs a value; usage: ${usage(key, entry)}`);
      const value = args[++i];
      if (a === '--network' && !['none', 'egress', 'allowlist'].includes(value))
        throw invalid('--network must be none, egress or allowlist');
    } else if (a.startsWith('-') && !flags.has(a)) {
      const known = [...values, ...flags].join(', ');
      throw invalid(`unknown option ${a}; valid options: ${known}`);
    } else if (!a.startsWith('-')) operands++;
  }
  return { operands, bareCommand };
}

/**
 * Validate command options and operands without side effects, or return contextual help.
 * @param {string[]} argv
 * @returns {string|null}
 */
export function validateCommand(argv) {
  const dash = argv.indexOf('--');
  const header = dash < 0 ? argv : argv.slice(0, dash);
  const help = header.includes('--help') || header.includes('-h');
  const resolved = commandEntry(argv, help);
  if (resolved.help) return resolved.help;
  const { key, entry, group } = resolved;
  const {
    operands,
    bareCommand,
    help: commandHelp,
  } = validateOptions(header.slice(group ? 2 : 1), key, entry);
  if (commandHelp)
    return `${usage(key, entry)}\n\nCommon options: --server URL --token TOKEN ${key === 'agent' ? '' : '--json '}--help\n`;
  const slots = entry.args.split(' -- ')[0].split(' ').filter(Boolean);
  const required = slots.filter((s) => s.startsWith('<')).length;
  if (operands < required || operands > slots.length)
    throw invalid(`wrong number of arguments; usage: ${usage(key, entry)}`);
  if (entry.args.includes(' -- ') && !bareCommand && (dash < 0 || dash === argv.length - 1))
    throw invalid(`a command after -- is required; usage: ${usage(key, entry)}`);
  return null;
}
