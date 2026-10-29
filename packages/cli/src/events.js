import { E } from '@workbox/core';
import { EventFeed, EventHub, drained } from '@workbox/server';

/**
 * `workbox events`: sandbox events as one JSON object per line, from the local engine's store or
 * through `--server`. With `--follow` it keeps printing events as they are logged until SIGINT or
 * SIGTERM: on the local engine through the Manager's `'logged'` rows, remotely over the events
 * WebSocket.
 */

/** Usage of `workbox events`. */
export const EVENTS_USAGE = 'workbox events [--sandbox id] [--type t]... [--after seq] [--follow]';

/** Rows read per page when listing stored events. */
const PAGE = 500;

const usage = (message) => E.invalid(`${message}\n${EVENTS_USAGE}`);

/**
 * The flags of `workbox events`. `--type` repeats and takes an exact type or `prefix.*`.
 * @param {string[]} argv
 * @returns {{sandboxId?: string, types?: string[], afterSeq?: number, follow: boolean}}
 */
export function parseEventsArgs(argv) {
  const out = { follow: false };
  const types = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--follow' || flag === '-f') {
      out.follow = true;
      continue;
    }
    if (flag === '--json') continue;
    if (!['--sandbox', '--type', '--after'].includes(flag)) throw usage(`unknown argument ${flag}`);
    if (i + 1 >= argv.length) throw usage(`${flag} needs a value`);
    const value = argv[++i];
    if (flag === '--sandbox') out.sandboxId = value;
    else if (flag === '--type') types.push(value);
    else {
      if (!/^\d+$/.test(value)) throw usage(`--after ${value} must be a sequence number`);
      out.afterSeq = Number(value);
    }
  }
  if (types.length) out.types = types;
  return out;
}

/**
 * `workbox events`. Without `--follow` it prints the stored events after `--after` (default 0)
 * and returns; with it, it prints the stored events after `--after` when given, then new ones as
 * they are logged, until the signal aborts (by default SIGINT or SIGTERM).
 * @param {{engine?: {store: object, manager: object}|null, client?: object|null, out?: {write: (s: string) => unknown}, signal?: AbortSignal}} ctx
 * @param {string[]} argv
 * @returns {Promise<{text: true}>}
 */
export async function eventsCommand(ctx, argv) {
  const opts = parseEventsArgs(argv);
  const out = ctx.out ?? process.stdout;
  const print = (row) => out.write(`${JSON.stringify(row)}\n`);
  if (!ctx.client && !ctx.engine) throw E.invalid('this command needs a local engine or --server');
  if (!opts.follow) {
    await listStored(ctx, opts, print);
    return { text: true };
  }
  await untilStopped(ctx.signal, (signal) =>
    ctx.client
      ? followRemote(ctx.client, opts, print, signal)
      : followLocal(ctx.engine, opts, print, out, signal),
  );
  return { text: true };
}

async function listStored(ctx, opts, print) {
  let afterSeq = opts.afterSeq ?? 0;
  const query = { types: opts.types, sandboxId: opts.sandboxId, limit: PAGE };
  for (;;) {
    const events = ctx.client
      ? (await ctx.client.listEvents({ ...query, afterSeq })).events
      : ctx.engine.store.listFleetEvents({ ...query, afterSeq });
    for (const row of events) print(row);
    if (events.length < PAGE) return;
    afterSeq = events[events.length - 1].seq;
  }
}

/** Run `fn` with a signal that aborts on `given`, SIGINT or SIGTERM; an abort is a clean end. */
async function untilStopped(given, fn) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  const signals = given ? [given] : [];
  if (!given) for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stop);
  const signal = AbortSignal.any([ac.signal, ...signals]);
  try {
    await fn(signal);
  } catch (e) {
    if (!signal.aborted) throw e;
  } finally {
    for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, stop);
  }
}

async function followRemote(client, opts, print, signal) {
  const stream = client.events({
    afterSeq: opts.afterSeq,
    types: opts.types,
    sandboxId: opts.sandboxId,
    signal,
  });
  for await (const row of stream) print(row);
}

async function followLocal(engine, opts, print, out, signal) {
  const feed = new EventFeed(
    new EventHub(engine.manager),
    { afterSeq: opts.afterSeq, types: opts.types, sandboxId: opts.sandboxId },
    { send: print, ready: () => drained(out) },
  );
  try {
    await feed.start();
    if (!signal.aborted)
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
  } finally {
    feed.close();
  }
}
