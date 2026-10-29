import { E } from '@workbox/core';
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  queueTestDelivery,
  rotateWebhookSecret,
} from '@workbox/server';

/**
 * `workbox webhook`: register, list, test, rotate and remove webhooks and list their deliveries,
 * on the local engine's store or through `--server`. A signing secret is printed when a webhook
 * is added or its secret rotated, and never again. On the local engine a webhook belongs to the
 * principal `cli`; a running `workbox serve` on the same root picks up local changes within a
 * few seconds.
 */

/** Usage of `workbox webhook`. */
export const WEBHOOK_USAGE = [
  'workbox webhook add <url> [--type T]... [--sandbox ID] [--label k=v]... [--description D]',
  'workbox webhook ls',
  'workbox webhook rm <webhookId>',
  'workbox webhook test <webhookId>',
  'workbox webhook rotate <webhookId>',
  'workbox webhook deliveries <webhookId> [--status pending|delivered|failed] [--limit N]',
].join('\n');

/** The principal that owns webhooks added on the local engine. */
export const LOCAL_OWNER = Object.freeze({ id: 'cli', binding: null });

const ADD_FLAGS = new Set(['--type', '--sandbox', '--label', '--description']);
const DELIVERY_FLAGS = new Set(['--status', '--limit']);

const usage = (message) => E.invalid(`${message}\n${WEBHOOK_USAGE}`);

/**
 * The arguments of `workbox webhook add`. `--type` and `--label k=v` repeat.
 * @param {string[]} argv
 * @returns {{url: string, types?: string[], sandboxId?: string, labels?: Record<string, string>, description?: string}}
 */
export function parseWebhookAdd(argv) {
  let url;
  let sandboxId;
  let description;
  const types = [];
  const labels = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (url !== undefined) throw usage(`unexpected argument ${arg}`);
      url = arg;
      continue;
    }
    if (!ADD_FLAGS.has(arg)) throw usage(`unknown argument ${arg}`);
    if (i + 1 >= argv.length) throw usage(`${arg} needs a value`);
    const value = argv[++i];
    if (arg === '--type') types.push(value);
    else if (arg === '--sandbox') sandboxId = value;
    else if (arg === '--description') description = value;
    else {
      const eq = value.indexOf('=');
      if (eq <= 0) throw usage(`--label ${value} must be key=value`);
      labels[value.slice(0, eq)] = value.slice(eq + 1);
    }
  }
  if (url === undefined) throw usage('the webhook url is required');
  const input = { url };
  if (types.length) input.types = types;
  if (sandboxId !== undefined) input.sandboxId = sandboxId;
  if (Object.keys(labels).length) input.labels = labels;
  if (description !== undefined) input.description = description;
  return input;
}

/**
 * The arguments of `workbox webhook deliveries`.
 * @param {string[]} argv
 * @returns {{webhookId: string, status?: string, limit?: number}}
 */
export function parseDeliveries(argv) {
  let webhookId;
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (webhookId !== undefined) throw usage(`unexpected argument ${arg}`);
      webhookId = arg;
      continue;
    }
    if (!DELIVERY_FLAGS.has(arg)) throw usage(`unknown argument ${arg}`);
    if (i + 1 >= argv.length) throw usage(`${arg} needs a value`);
    const value = argv[++i];
    if (arg === '--status') opts.status = value;
    else {
      if (!/^[1-9]\d*$/.test(value)) throw usage(`--limit ${value} must be a positive integer`);
      opts.limit = Number(value);
    }
  }
  if (webhookId === undefined) throw usage('workbox webhook deliveries takes one webhook id');
  return { webhookId, ...opts };
}

function oneId(sub, rest) {
  if (rest.length !== 1) throw usage(`workbox webhook ${sub} takes one webhook id`);
  return rest[0];
}

function localEngine(ctx) {
  if (ctx.engine) return ctx.engine;
  throw E.invalid('this command needs a local engine or --server');
}

/** Other names the subcommands answer to. */
const ALIASES = Object.freeze({
  create: 'add',
  list: 'ls',
  delete: 'rm',
  'rotate-secret': 'rotate',
});

/** The webhook operations through `--server`. */
function remoteOps(client) {
  return {
    add: (input) => client.createWebhook(input),
    ls: () => client.listWebhooks(),
    rm: (id) => client.deleteWebhook(id),
    test: (id) => client.testWebhook(id),
    rotate: (id) => client.rotateWebhookSecret(id),
    deliveries: (id, opts) => client.listWebhookDeliveries(id, opts),
  };
}

/** The webhook operations on the local engine's store, as the principal `cli`. */
function localOps(engine) {
  const { store } = engine;
  return {
    add: (input) => createWebhook(store, input, LOCAL_OWNER, engine.config?.webhooks),
    ls: () => listWebhooks(store, LOCAL_OWNER),
    rm: (id) => deleteWebhook(store, id, LOCAL_OWNER),
    test: (id) => queueTestDelivery(store, id, LOCAL_OWNER),
    rotate: (id) => rotateWebhookSecret(store, id, LOCAL_OWNER),
    deliveries: (id, opts) => listDeliveries(store, id, LOCAL_OWNER, opts),
  };
}

const SUBCOMMANDS = new Set(['add', 'ls', 'rm', 'test', 'rotate', 'deliveries']);

/**
 * `workbox webhook add|ls|rm|test|rotate|deliveries`.
 * @param {{engine?: {store: object, config?: {webhooks?: object}}|null, client?: object|null, err?: {write: (s: string) => unknown}}} ctx
 * @param {string[]} argv
 */
export async function webhookCommand(ctx, argv) {
  const [given, ...rest] = argv.filter((a) => a !== '--json');
  const sub = ALIASES[given] ?? given;
  if (!SUBCOMMANDS.has(sub)) throw usage(`unknown webhook subcommand ${given ?? ''}`);
  const ops = () => (ctx.client ? remoteOps(ctx.client) : localOps(localEngine(ctx)));
  if (sub === 'add') {
    const input = parseWebhookAdd(rest);
    const row = await ops().add(input);
    ctx.err?.write('workbox: the secret is shown only this once; store it now\n');
    return row;
  }
  if (sub === 'ls') {
    if (rest.length) throw usage(`unexpected argument ${rest[0]}`);
    return ops().ls();
  }
  if (sub === 'deliveries') {
    const { webhookId, ...opts } = parseDeliveries(rest);
    return ops().deliveries(webhookId, opts);
  }
  const id = oneId(given, rest);
  const row = await ops()[sub](id);
  if (sub === 'rotate')
    ctx.err?.write('workbox: the new secret is shown only this once; store it now\n');
  return row;
}
