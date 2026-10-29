import { E } from '@workbox/core';
import { createStoredKey } from '@workbox/server';

/**
 * `workbox key`: mint, list and revoke stored API keys, on the local engine's store or through
 * `--server`. A minted token is printed once and cannot be shown again.
 */

/** Usage of `workbox key`. */
export const KEY_USAGE = [
  'workbox key create --name N --scope S [--scope S]... [--label k=v]... [--sandbox ID]... [--ttl 30d|12h|3600s]',
  'workbox key ls',
  'workbox key rm <keyId>',
].join('\n');

const TTL_UNITS = Object.freeze({ s: 1, m: 60, h: 3600, d: 86_400 });

const CREATE_FLAGS = new Set(['--name', '--scope', '--label', '--sandbox', '--ttl']);

const usage = (message) => E.invalid(`${message}\n${KEY_USAGE}`);

/**
 * A key lifetime: a whole number followed by `s`, `m`, `h` or `d`.
 * @param {string} text e.g. `30d`, `12h`, `3600s`
 * @returns {number} seconds
 */
export function parseTtl(text) {
  const m = /^([1-9]\d*)([smhd])$/.exec(String(text));
  if (!m)
    throw E.invalid(`--ttl ${text} must be a whole number followed by s, m, h or d, such as 30d`, {
      ttl: text,
    });
  return Number(m[1]) * TTL_UNITS[m[2]];
}

/**
 * The flags of `workbox key create`. `--scope`, `--label k=v` and `--sandbox ID` repeat.
 * @param {string[]} argv
 * @returns {{name: string, scopes: string[], labels?: Record<string, string>, sandboxIds?: string[], ttlSeconds?: number}}
 */
export function parseKeyCreate(argv) {
  let name;
  let ttlSeconds;
  const scopes = [];
  const labels = {};
  const sandboxIds = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!CREATE_FLAGS.has(flag)) throw usage(`unknown argument ${flag}`);
    if (i + 1 >= argv.length) throw usage(`${flag} needs a value`);
    const value = argv[++i];
    if (flag === '--name') name = value;
    else if (flag === '--scope') scopes.push(value);
    else if (flag === '--sandbox') sandboxIds.push(value);
    else if (flag === '--ttl') ttlSeconds = parseTtl(value);
    else {
      const eq = value.indexOf('=');
      if (eq <= 0) throw usage(`--label ${value} must be key=value`);
      labels[value.slice(0, eq)] = value.slice(eq + 1);
    }
  }
  if (!name) throw usage('--name is required');
  if (!scopes.length) throw usage('at least one --scope is required');
  const input = { name, scopes };
  if (Object.keys(labels).length) input.labels = labels;
  if (sandboxIds.length) input.sandboxIds = sandboxIds;
  if (ttlSeconds !== undefined) input.ttlSeconds = ttlSeconds;
  return input;
}

function keyStore(ctx) {
  if (ctx.engine) return ctx.engine.store;
  throw E.invalid('this command needs a local engine or --server');
}

/**
 * `workbox key create|ls|rm`. `create` prints the new key with its token; the token is not
 * stored and is never shown again.
 * @param {{engine?: {store: object}|null, client?: object|null, err?: {write: (s: string) => unknown}}} ctx
 * @param {string[]} argv
 */
export async function keyCommand(ctx, argv) {
  const [sub, ...rest] = argv.filter((a) => a !== '--json');
  if (sub === 'create') {
    const input = parseKeyCreate(rest);
    const key = ctx.client
      ? await ctx.client.createKey(input)
      : createStoredKey(keyStore(ctx), input, 'cli');
    ctx.err?.write('workbox: the token is shown only this once; store it now\n');
    return key;
  }
  if (sub === 'ls' || sub === 'list') {
    if (rest.length) throw usage(`unexpected argument ${rest[0]}`);
    return ctx.client ? ctx.client.listKeys() : { keys: keyStore(ctx).listApiKeys() };
  }
  if (sub === 'rm' || sub === 'revoke') {
    if (rest.length !== 1) throw usage(`workbox key ${sub} takes one key id`);
    return ctx.client ? ctx.client.revokeKey(rest[0]) : keyStore(ctx).revokeApiKey(rest[0]);
  }
  throw usage(`unknown key subcommand ${sub ?? ''}`);
}
