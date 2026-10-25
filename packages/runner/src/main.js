import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Runner } from './runner.js';
import { createLog } from './log.js';

export const DEFAULT_BOOT_FILE = '/run/workbox/boot.json';

/**
 * Parse `--boot <file> --socket <path> --keep-boot-file --log-level <level>`.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { boot: DEFAULT_BOOT_FILE, socket: null, keepBootFile: false, logLevel: 'info' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--boot') out.boot = next();
    else if (a === '--socket') out.socket = next();
    else if (a === '--keep-boot-file') out.keepBootFile = true;
    else if (a === '--log-level') out.logLevel = next();
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/**
 * Read and validate the boot file written by the host.
 * @param {string} file
 */
export function readBootFile(file) {
  const boot = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['bootId', 'nonce', 'sandboxId', 'protocol', 'socket']) {
    if (boot[key] === undefined || boot[key] === null)
      throw new Error(`boot file ${file} lacks ${key}`);
  }
  return boot;
}

/**
 * Entry point. Reads the boot identity, removes the boot file so no later process can read the
 * nonce, starts the runner and keeps the process alive until it stops.
 * @param {string[]} argv
 * @param {{exit?: (code: number) => void, log?: ReturnType<typeof createLog>}} [deps]
 * @returns {Promise<Runner>}
 */
export async function main(argv, deps = {}) {
  const args = parseArgs(argv);
  const log = deps.log ?? createLog({ level: args.logLevel });
  const boot = readBootFile(args.boot);
  if (!args.keepBootFile) fs.unlinkSync(args.boot);
  const runner = new Runner({ socketPath: args.socket ?? boot.socket, boot, log });
  const exit = deps.exit ?? ((code) => process.exit(code));
  const onSignal = (sig) => {
    log.info('signal', { signal: sig });
    runner.stop({ reason: sig }).then(() => exit(0));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  runner.once('stopped', () => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  });
  await runner.start();
  return runner;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', msg: 'runner failed to start', error: e.message })}\n`,
    );
    process.exit(1);
  });
}
