import fs from 'node:fs';
import { Codes, SESSION_READ_MAX_BYTES } from '@workbox/protocol';
import { httpStatusFor } from '@workbox/core';
import { ANY_KEY, FLEET_ROUTES, SCOPES, SCOPE_MATRIX } from './auth.js';
import { DELIVERY_STATUSES } from './webhooks.js';
import { MAX_EVENT_WAIT_MS, MAX_TYPE_PATTERNS } from './streams.js';
import { BODY_SCHEMAS, MAX_BODY_BYTES } from './server.js';

/**
 * The OpenAPI 3.1 document of the REST and WebSocket API, generated from the code: the routes
 * and scopes of `SCOPE_MATRIX`, the request bodies of `BODY_SCHEMAS` converted to JSON Schema,
 * and ROUTE_DOCS below for what the code does not say (summaries, query parameters, responses).
 * Every route needs a ROUTE_DOCS entry and every entry a route; buildOpenApi refuses otherwise.
 */

/** The version of this package, which the served document carries. */
export const SERVER_VERSION = JSON.parse(
  fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/** Where the server serves the document. */
export const OPENAPI_PATH = '/v1/openapi.json';

/** Routes served without authentication (the browser guard still applies to them). */
export const PUBLIC_ROUTES = Object.freeze(['GET /healthz', 'GET /readyz', `GET ${OPENAPI_PATH}`]);

/** The protocol's base64 string pattern; strings with it are marked `contentEncoding: base64`. */
export const BASE64_PATTERN = '^[A-Za-z0-9+/]*={0,2}$';

const ERROR_REF = '#/components/responses/Error';

const PATH_PARAMS = Object.freeze({
  id: { description: 'Sandbox id.', schema: { type: 'string', minLength: 1 } },
  sessionId: {
    description: 'Session id.',
    schema: { type: 'string', minLength: 1, maxLength: 64 },
  },
  sha256: {
    description: 'Artifact digest: 64 lowercase hex characters.',
    schema: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
  askId: { description: 'Ask id.', schema: { type: 'string', minLength: 1 } },
  keyId: { description: 'Stored key id.', schema: { type: 'string', minLength: 1 } },
  webhookId: { description: 'Webhook id.', schema: { type: 'string', minLength: 1 } },
  deliveryId: { description: 'Delivery id.', schema: { type: 'string', minLength: 1 } },
});

const text = (description, schema = {}) => ({ description, schema: { type: 'string', ...schema } });
const count = (description, schema = {}) => ({
  description,
  schema: { type: 'integer', minimum: 0, ...schema },
});
const flag = (description) => ({ description, schema: { type: 'string', enum: ['1'] } });
const needed = (param) => ({ ...param, required: true });

const PAGE = Object.freeze({
  cursor: text('The `cursor` of the previous page.'),
  limit: count('Rows per page (default 50; more than 1000 counts as 1000).'),
});

const AFTER_SEQ = count('Events with a greater `seq` (default 0).');
const TYPES = text(
  `Comma-separated event types, each exact or \`prefix.*\` for every type starting with \`prefix.\`; at most ${MAX_TYPE_PATTERNS}. May repeat.`,
);
const FLEET_SANDBOX = text('Only the events of this sandbox.');
const EVENT_POLL = Object.freeze({
  afterSeq: AFTER_SEQ,
  limit: count('At most this many events (default 100, at most 1000).'),
  types: TYPES,
  waitMs: count(
    'Long-poll: with nothing after `afterSeq` yet, wait this long for a new matching event.',
    { maximum: MAX_EVENT_WAIT_MS },
  ),
});
const EVENT_STREAM = Object.freeze({
  afterSeq: count('Replay the stored events after this `seq` first; without it, only new ones.'),
  types: TYPES,
});

const EVENTS_ANSWER =
  '`{events, nextSeq}` in `seq` order. Each event is `{seq, sandboxId, type, source, payload, causation, at}`. Pass `nextSeq` back as `afterSeq` for the next page.';

const EVENT_FRAMES = [
  'Server frames:',
  '',
  '- `{"type": "event", "event": {...}}`, one per event, in `seq` order.',
  '- `{"type": "live", "seq": N}`, once, when the stream turns live: every matching event up to `N` has been sent and later ones follow as they are logged.',
  '- `{"type": "error", "code", "message"}` before the server closes the stream with 1011.',
  '',
  "A client that reads too slowly is dropped once 1 MiB is waiting to be sent to it; shutdown closes the stream with 1001. To resume, reconnect with `afterSeq` set to the last `seq` received, or to the `live` frame's `N` when that is greater.",
].join('\n');

const SESSION_FRAMES = [
  'Server frames:',
  '',
  '- `{"type": "ready", "sessionId"}` first; client frames sent before it are not read.',
  '- `{"type": "session.output", "params": {sessionId, stream, seq, data}}`: output, `data` base64, `stream` `stdout`, `stderr` or `pty`. The session\'s retained output is replayed first.',
  '- `{"type": "session.exit", "params": {sessionId, code, signal, seq, at}}` when the session exits.',
  '- `{"type": "error", "code", "message"}` when a client frame fails; a failed attach also closes the socket with 1011.',
  '',
  'Client frames:',
  '',
  '- `{"type": "input", "data": "<base64>", "eof": true}`: write to stdin; `eof` is optional and closes it.',
  '- `{"type": "resize", "rows", "cols"}`: resize a PTY session.',
  '- `{"type": "signal", "signal": "SIGINT"}`: signal the session\'s process group.',
  '',
  'Closing the socket detaches; the session keeps running.',
].join('\n');

/**
 * What the code does not say about each route: `operationId`, `summary`, `description`, the
 * `query` parameters, the success `status` (default 200), what it `returns`, its `media`
 * (`json` by default, `binary` for raw bytes, `prometheus` for metrics), a `binary` request
 * `body`, and `ws` for a WebSocket route. Keys are SCOPE_MATRIX keys and PUBLIC_ROUTES.
 */
export const ROUTE_DOCS = Object.freeze({
  'GET /healthz': {
    operationId: 'getHealth',
    summary: 'Liveness',
    description: 'Answers while the process serves requests.',
    returns: '`{ok: true}`.',
  },
  'GET /readyz': {
    operationId: 'getReadiness',
    summary: 'Readiness',
    description: 'Answers 503 `E_UNAVAILABLE` while the server is not ready or shuts down.',
    returns: '`{ready: true}`.',
  },
  [`GET ${OPENAPI_PATH}`]: {
    operationId: 'getOpenApi',
    summary: 'This document',
    description: 'The OpenAPI 3.1 document of this server, generated from its route table.',
    returns: 'The OpenAPI document.',
  },
  'GET /metrics': {
    operationId: 'getMetrics',
    summary: 'Prometheus metrics',
    description:
      'HTTP requests by route, method and status, WebSocket counts and sandboxes by state.',
    returns: 'Prometheus text exposition format 0.0.4.',
    media: 'prometheus',
  },
  'GET /v1/sandboxes': {
    operationId: 'listSandboxes',
    summary: 'List sandboxes',
    description:
      'One page of the inventory; pass the returned `cursor` back until `complete` is true. A bound key lists only the sandboxes it sees.',
    query: { ...PAGE, includeDeleted: flag('Include destroyed sandboxes.') },
    returns: '`{items, cursor, complete}`; each item is a sandbox row.',
  },
  'POST /v1/sandboxes': {
    operationId: 'createSandbox',
    summary: 'Create a sandbox',
    description:
      'Create a sandbox and wait until it is ready. The same `idempotencyKey` returns the sandbox it made before. `fromCheckpoint` restores a checkpoint. A bound key puts its labels on the new sandbox; a body label with another value is 403, and a key bound only by `sandboxIds` cannot create sandboxes.',
    status: 201,
    returns: 'The sandbox row.',
  },
  'GET /v1/sandboxes/:id': {
    operationId: 'getSandbox',
    summary: 'Inspect a sandbox',
    description: 'The sandbox row with its state, limits and health.',
    returns: 'The sandbox.',
  },
  'DELETE /v1/sandboxes/:id': {
    operationId: 'destroySandbox',
    summary: 'Destroy a sandbox',
    description: 'Stop every session and remove the sandbox.',
    returns: 'The destroyed sandbox.',
  },
  'POST /v1/sandboxes/:id/drain': {
    operationId: 'drainSandbox',
    summary: 'Drain a sandbox',
    description: 'Stop accepting new work in the sandbox.',
    returns: 'The drained sandbox.',
  },
  'POST /v1/sandboxes/:id/exec': {
    operationId: 'execCommand',
    summary: 'Run a command to completion',
    description:
      'Run `argv` in the sandbox and wait for it to finish. `input` is written to stdin; output beyond `maxOutputBytes` is cut.',
    returns: 'The exit code and the captured stdout and stderr.',
  },
  'GET /v1/sandboxes/:id/files': {
    operationId: 'getFile',
    summary: 'Read, list or stat a path',
    description:
      'With `list=1`, list the directory at `path`; with `stat=1`, stat it; otherwise read a byte range of the file (at most 4 MiB per call).',
    query: {
      path: needed(text('Absolute path inside the sandbox.', { minLength: 1 })),
      list: flag('List the directory: `{path, entries: [{name, type}]}`.'),
      stat: flag('Stat the path: `{path, size, mode, uid, gid, isFile, isDir, mtimeMs}`.'),
      offset: count('First byte to read (default 0).'),
      length: count('Bytes to read (at most 4194304).', { maximum: 4 * 1024 * 1024 }),
    },
    returns: 'A read is `{path, size, offset, data, eof}` with `data` base64.',
  },
  'PUT /v1/sandboxes/:id/files': {
    operationId: 'writeFile',
    summary: 'Write a file',
    description:
      'Write base64 `data` to `path`, replacing the file or with `append` adding to it. `mkdirs` creates missing parent directories.',
    returns: '`{path, bytes, size}`.',
  },
  'DELETE /v1/sandboxes/:id/files': {
    operationId: 'removeFile',
    summary: 'Remove a file or directory',
    description: 'Remove the file or empty directory at `path`; with `recursive=1`, a whole tree.',
    query: {
      path: needed(text('Absolute path inside the sandbox.', { minLength: 1 })),
      recursive: flag('Remove a directory and everything in it.'),
    },
    returns: '`{path, removed: true}`.',
  },
  'POST /v1/sandboxes/:id/files/mkdir': {
    operationId: 'makeDirectory',
    summary: 'Create a directory',
    description:
      'Create the directory at `path`. `parents` defaults to true; when false, a missing parent is 404.',
    returns: '`{path, created: true}`.',
  },
  'GET /v1/sandboxes/:id/files/raw': {
    operationId: 'downloadFile',
    summary: 'Download a file',
    description:
      "The file's bytes, streamed, with `content-length` from its size. If the file shrinks while it is read, the connection is cut short of that length.",
    query: { path: needed(text('Absolute path of the file.', { minLength: 1 })) },
    returns: "The file's bytes.",
    media: 'binary',
  },
  'PUT /v1/sandboxes/:id/files/raw': {
    operationId: 'uploadFile',
    summary: 'Upload a file',
    description:
      "Replace the file at `path` with the request body, streamed into the sandbox as it arrives. A body over the server's upload cap (default 1 GiB) is 413 `E_LIMIT`. On any failure the partly written file is removed.",
    query: {
      path: needed(text('Absolute path of the file.', { minLength: 1 })),
      mode: text('Octal file mode, such as `644`.', { pattern: '^0?[0-7]{1,4}$' }),
      mkdirs: flag('Create missing parent directories.'),
    },
    body: 'binary',
    returns: '`{path, bytes}`.',
  },
  'GET /v1/sandboxes/:id/sessions': {
    operationId: 'listSessions',
    summary: 'List sessions',
    description:
      "Live and exited sessions: from the runner while its control channel is up (`source: runner`), else from the server's records (`source: store`).",
    returns: '`{source, sessions}`.',
  },
  'POST /v1/sandboxes/:id/sessions': {
    operationId: 'startSession',
    summary: 'Start a session',
    description:
      'Start a durable session from `argv`. It keeps running whether or not anyone is attached; `pty` gives it a terminal.',
    status: 201,
    returns: 'The session, with its `sessionId`.',
  },
  'GET /v1/sandboxes/:id/sessions/:sessionId': {
    operationId: 'getSession',
    summary: 'Inspect a session',
    description: 'One session with `exited`: `{code, signal, at}`, or null while it runs.',
    returns: 'The session.',
  },
  'DELETE /v1/sandboxes/:id/sessions/:sessionId': {
    operationId: 'removeSession',
    summary: 'Forget a session',
    description: 'Forget an exited session and its output; 409 `E_STATE` while it runs.',
    returns: '`{sessionId, removed: true}`.',
  },
  'GET /v1/sandboxes/:id/sessions/:sessionId/output': {
    operationId: 'readSessionOutput',
    summary: 'Read session output',
    description:
      'Retained output without attaching. Chunks are whole: they come from `fromSeq` until the next would pass `maxBytes`, and at least one comes when any is retained. Read again from `nextSeq` while `truncated` is true. `gap` is `{requested, available}` when earlier output was dropped from the spool. Once `exited` is set, every byte of output is in the spool. A sandbox whose runner lacks this call answers 501 `E_UNSUPPORTED`.',
    query: {
      fromSeq: count('First chunk sequence number (default 0).'),
      maxBytes: count('Most output bytes to return (default 1048576).', {
        minimum: 1,
        maximum: SESSION_READ_MAX_BYTES,
      }),
      encoding: text('`base64` (default) or `text` for UTF-8 `data`.', {
        enum: ['base64', 'text'],
      }),
    },
    returns: '`{sessionId, chunks: [{seq, stream, data}], nextSeq, gap, truncated, exited}`.',
  },
  'POST /v1/sandboxes/:id/sessions/:sessionId/wait': {
    operationId: 'waitForSession',
    summary: 'Wait for a session to exit',
    description:
      'Answer as soon as the session exits, at once if it already has, or with `exited: null` when `timeoutMs` (default 30000) passes first; call again to keep waiting.',
    returns: '`{sessionId, exited}`; `exited` is `{code, signal, at}` or null.',
  },
  'POST /v1/sandboxes/:id/sessions/:sessionId/input': {
    operationId: 'sendSessionInput',
    summary: 'Write to session stdin',
    description:
      'Write base64 `data` or UTF-8 `text` (not both) to the session stdin; `eof` closes it.',
    returns: 'The runner acknowledgement.',
  },
  'POST /v1/sandboxes/:id/sessions/:sessionId/signal': {
    operationId: 'signalSession',
    summary: 'Signal a session',
    description: "Send a signal, such as `SIGTERM`, to the session's process group.",
    returns: 'The runner acknowledgement.',
  },
  'POST /v1/sandboxes/:id/sessions/:sessionId/stop': {
    operationId: 'stopSession',
    summary: 'Stop a session',
    description: 'SIGTERM the session, then SIGKILL after `graceMs`.',
    returns: 'The exit.',
  },
  'POST /v1/sandboxes/:id/sessions/:sessionId/resize': {
    operationId: 'resizeSession',
    summary: 'Resize a PTY session',
    description: 'Set the terminal size. A session without a PTY is 501.',
    returns: 'The runner acknowledgement.',
  },
  'GET /v1/sandboxes/:id/sessions/:sessionId/ws': {
    operationId: 'attachSession',
    summary: 'Attach to a session (WebSocket)',
    description: `Attach to a session over a WebSocket: output, input, resize and signal. A plain GET is 426.\n\n${SESSION_FRAMES}`,
    ws: true,
  },
  'GET /v1/sandboxes/:id/evidence': {
    operationId: 'listEvidence',
    summary: 'List evidence',
    description: 'Evidence envelopes recorded by `wb run` in the sandbox.',
    query: PAGE,
    returns: '`{items, cursor, complete}`.',
  },
  'GET /v1/sandboxes/:id/artifacts': {
    operationId: 'listArtifacts',
    summary: 'List artifacts',
    description: 'Artifacts the sandbox recorded.',
    query: PAGE,
    returns: '`{items, cursor, complete}`.',
  },
  'GET /v1/sandboxes/:id/artifacts/:sha256': {
    operationId: 'downloadArtifact',
    summary: 'Download an artifact',
    description: "The artifact's bytes, streamed; 404 unless this sandbox holds that digest.",
    returns: "The artifact's bytes.",
    media: 'binary',
  },
  'GET /v1/sandboxes/:id/checkpoints': {
    operationId: 'listCheckpoints',
    summary: 'List checkpoints',
    description: "The sandbox's checkpoints.",
    returns: '`{checkpoints}`.',
  },
  'POST /v1/sandboxes/:id/checkpoints': {
    operationId: 'createCheckpoint',
    summary: 'Create a checkpoint',
    description:
      "Checkpoint the sandbox's upper layer, optionally limited to `paths`, with a `name` and `summary`.",
    status: 201,
    returns: 'The checkpoint.',
  },
  'GET /v1/sandboxes/:id/events': {
    operationId: 'listSandboxEvents',
    summary: "List a sandbox's events",
    description:
      "This sandbox's events after `afterSeq`. With `waitMs`, the request answers as soon as a matching event is logged, or with an empty `events` when the time is up.",
    query: EVENT_POLL,
    returns: EVENTS_ANSWER,
  },
  'GET /v1/sandboxes/:id/events/ws': {
    operationId: 'streamSandboxEvents',
    summary: "Stream a sandbox's events (WebSocket)",
    description: `This sandbox's events over a WebSocket: the stored ones after \`afterSeq\`, then live ones, each once and in order. A plain GET is 426.\n\n${EVENT_FRAMES}`,
    query: EVENT_STREAM,
    ws: true,
  },
  'GET /v1/events': {
    operationId: 'listEvents',
    summary: 'List events',
    description:
      'Events of every sandbox the key sees, after `afterSeq`. With `waitMs`, the request answers as soon as a matching event is logged, or with an empty `events` when the time is up.',
    query: { ...EVENT_POLL, sandboxId: FLEET_SANDBOX },
    returns: EVENTS_ANSWER,
  },
  'GET /v1/events/ws': {
    operationId: 'streamEvents',
    summary: 'Stream events (WebSocket)',
    description: `Events of every sandbox the key sees over a WebSocket: the stored ones after \`afterSeq\`, then live ones, each once and in order. A plain GET is 426.\n\n${EVENT_FRAMES}`,
    query: { ...EVENT_STREAM, sandboxId: FLEET_SANDBOX },
    ws: true,
  },
  'POST /v1/reconcile': {
    operationId: 'reconcile',
    summary: 'Reconcile with the host',
    description: 'Compare the recorded sandboxes with what runs on the host.',
    returns: '`{attached, absent, suspect, quarantined}`, each a list of sandbox ids.',
  },
  'GET /v1/asks': {
    operationId: 'listAsks',
    summary: 'List asks',
    description: 'Questions raised with `wb ask` inside sandboxes.',
    query: {
      status: text('Which asks (default `all`).', { enum: ['open', 'answered', 'expired', 'all'] }),
      sandboxId: text('Only the asks of this sandbox.'),
      limit: count('At most this many (default 100; more than 1000 counts as 1000).'),
    },
    returns: '`{asks}`.',
  },
  'POST /v1/asks/:askId/answer': {
    operationId: 'answerAsk',
    summary: 'Answer an ask',
    description: 'Answer a pending ask; `answer` is any JSON value.',
    returns: 'The answered ask.',
  },
  'GET /v1/whoami': {
    operationId: 'whoami',
    summary: 'The calling key',
    description: 'The key this request authenticated with.',
    returns: '`{id, scopes, binding, source, expiresAt}`; `source` is `config` or `store`.',
  },
  'POST /v1/keys': {
    operationId: 'createKey',
    summary: 'Mint a stored key',
    description:
      'Mint a key with `scopes`, optionally bound to sandboxes by `labels` or `sandboxIds` and expiring after `ttlSeconds`. The token is in this answer only.',
    status: 201,
    returns: '`{id, name, token, scopes, binding, createdAt, expiresAt}`.',
  },
  'GET /v1/keys': {
    operationId: 'listKeys',
    summary: 'List stored keys',
    description: 'Stored keys with `lastUsedAt` and `revokedAt`; never a token or its digest.',
    returns: '`{keys}`.',
  },
  'DELETE /v1/keys/:keyId': {
    operationId: 'revokeKey',
    summary: 'Revoke a stored key',
    description: 'The key stops working on the next request.',
    returns: 'The revoked key.',
  },
  'POST /v1/webhooks': {
    operationId: 'createWebhook',
    summary: 'Register a webhook',
    description:
      '`url` must be `https:` without credentials and resolve only to public addresses unless the server configuration allows otherwise. `types` holds event types or `prefix.*` patterns; none means every type. `sandboxId` must name a sandbox the key sees. `labels` keeps events of sandboxes that carry every label. The signing `secret` is in this answer only.',
    status: 201,
    returns: 'The webhook with its `secret`.',
  },
  'GET /v1/webhooks': {
    operationId: 'listWebhooks',
    summary: 'List webhooks',
    description:
      'Webhooks in creation order, without secrets. A bound key sees the ones it created.',
    returns: '`{webhooks}`.',
  },
  'GET /v1/webhooks/:webhookId': {
    operationId: 'getWebhook',
    summary: 'Inspect a webhook',
    description: 'One webhook, without its secret.',
    returns:
      '`{id, url, types, sandboxId, labels, description, enabled, disabledReason, ownerKey, binding, lastSeq, createdAt, updatedAt}`.',
  },
  'PATCH /v1/webhooks/:webhookId': {
    operationId: 'updateWebhook',
    summary: 'Change a webhook',
    description:
      'Change `url`, `types`, `description` or `enabled`; enabling clears `disabledReason`.',
    returns: 'The webhook.',
  },
  'DELETE /v1/webhooks/:webhookId': {
    operationId: 'deleteWebhook',
    summary: 'Delete a webhook',
    description: 'Delete the webhook and its deliveries.',
    returns: 'The deleted webhook.',
  },
  'POST /v1/webhooks/:webhookId/rotate-secret': {
    operationId: 'rotateWebhookSecret',
    summary: 'Rotate the signing secret',
    description: 'Replace the signing secret; later attempts, retries included, use the new one.',
    returns: 'The webhook with its new `secret`.',
  },
  'POST /v1/webhooks/:webhookId/test': {
    operationId: 'testWebhook',
    summary: 'Send a test delivery',
    description:
      'Queue one `webhook.test` delivery, outside the event log: its `seq` and `sandboxId` are null.',
    status: 202,
    returns: 'The queued delivery.',
  },
  'GET /v1/webhooks/:webhookId/deliveries': {
    operationId: 'listWebhookDeliveries',
    summary: 'List deliveries',
    description: "The webhook's deliveries, newest first.",
    query: {
      status: text('Only deliveries in this state.', { enum: [...DELIVERY_STATUSES] }),
      ...PAGE,
    },
    returns:
      '`{items, cursor, complete}`; each delivery is `{id, webhookId, eventSeq, event, status, attempts, nextAt, lastStatus, lastError, createdAt, deliveredAt}`.',
  },
  'POST /v1/webhooks/:webhookId/deliveries/:deliveryId/retry': {
    operationId: 'retryWebhookDelivery',
    summary: 'Retry a delivery',
    description: 'Send a delivery again now, whatever its state.',
    status: 202,
    returns: 'The delivery.',
  },
});

/**
 * Every route the server answers: the SCOPE_MATRIX keys and the public routes.
 * @returns {string[]}
 */
export function allRoutes() {
  return [...PUBLIC_ROUTES, ...Object.keys(SCOPE_MATRIX)];
}

/**
 * Problems with a route documentation table: a route without an entry, or an entry naming no
 * route.
 * @param {Record<string, object>} [docs]
 * @param {string[]} [routes]
 * @returns {string[]}
 */
export function routeDocProblems(docs = ROUTE_DOCS, routes = allRoutes()) {
  const problems = [];
  for (const route of routes)
    if (!Object.hasOwn(docs, route)) problems.push(`${route} has no ROUTE_DOCS entry`);
  for (const route of Object.keys(docs))
    if (!routes.includes(route)) problems.push(`ROUTE_DOCS entry ${route} names no route`);
  return problems;
}

/**
 * A route template's path in OpenAPI form: `:name` segments become `{name}`.
 * @param {string} template e.g. `/v1/sandboxes/:id`
 */
export function openApiPath(template) {
  return template
    .split('/')
    .map((part) => (part.startsWith(':') ? `{${part.slice(1)}}` : part))
    .join('/');
}

/**
 * A JavaScript RegExp as a JSON Schema pattern. The `s` flag is spelled out (each `.` outside a
 * character class becomes `[\s\S]`), `u` is JSON Schema's own mode; any other flag cannot be
 * expressed and throws.
 * @param {RegExp} re
 */
export function patternOf(re) {
  const other = re.flags.replace(/[su]/g, '');
  if (other) throw new Error(`pattern ${re} has flags JSON Schema cannot express: ${other}`);
  if (!re.flags.includes('s')) return re.source;
  let out = '';
  let inClass = false;
  for (let i = 0; i < re.source.length; i++) {
    const c = re.source[i];
    if (c === '\\') {
      out += re.source.slice(i, i + 2);
      i++;
    } else if (inClass) {
      inClass = c !== ']';
      out += c;
    } else {
      inClass = c === '[';
      out += c === '.' ? '[\\s\\S]' : c;
    }
  }
  return out;
}

function bounded(out, s, minKey, maxKey) {
  if (s.min !== undefined) out[minKey] = s.min;
  if (s.max !== undefined) out[maxKey] = s.max;
  return out;
}

function enumType(values) {
  const types = [...new Set(values.map((x) => (Number.isInteger(x) ? 'integer' : typeof x)))];
  return types.length === 1 && ['string', 'integer', 'number', 'boolean'].includes(types[0])
    ? { type: types[0] }
    : {};
}

const CONVERT = {
  string: (s) => {
    const out = bounded({ type: 'string' }, s, 'minLength', 'maxLength');
    if (!s.pattern) return out;
    out.pattern = patternOf(s.pattern);
    if (out.pattern === BASE64_PATTERN) {
      out.contentEncoding = 'base64';
      out.description = 'Base64-encoded bytes.';
    }
    return out;
  },
  integer: (s) => bounded({ type: 'integer' }, s, 'minimum', 'maximum'),
  number: (s) => bounded({ type: 'number' }, s, 'minimum', 'maximum'),
  boolean: () => ({ type: 'boolean' }),
  any: () => ({}),
  enum: (s) => ({ ...enumType(s.values), enum: [...s.values] }),
  array: (s) => bounded({ type: 'array', items: toJsonSchema(s.items) }, s, 'minItems', 'maxItems'),
  object: (s) => {
    const properties = {};
    for (const [name, sub] of Object.entries(s.props)) properties[name] = toJsonSchema(sub);
    const out = { type: 'object', properties };
    if (s.required.length) out.required = [...s.required];
    if (!s.additional) out.additionalProperties = false;
    return out;
  },
  record: (s) => {
    const out = { type: 'object', additionalProperties: toJsonSchema(s.values) };
    if (s.max !== undefined) out.maxProperties = s.max;
    if (s.keyPattern) out.propertyNames = { pattern: patternOf(s.keyPattern) };
    return out;
  },
  oneOf: (s) => ({ oneOf: s.schemas.map(toJsonSchema) }),
};

function withNull(out) {
  if (out.oneOf) return { oneOf: [...out.oneOf, { type: 'null' }] };
  if (out.enum) out.enum = [...out.enum, null];
  if (typeof out.type === 'string') out.type = [out.type, 'null'];
  return out;
}

/**
 * Convert a protocol `v` schema to JSON Schema (draft 2020-12, as OpenAPI 3.1 uses it). String
 * bounds count UTF-8 bytes on the server; `optional` shows only in the parent's `required`.
 * @param {{kind: string, nullable?: boolean, [k: string]: any}} schema
 * @returns {Record<string, any>}
 */
export function toJsonSchema(schema) {
  const convert = CONVERT[schema.kind];
  if (!convert) throw new Error(`unknown schema kind ${schema.kind}`);
  const out = convert(schema);
  return schema.nullable && schema.kind !== 'any' ? withNull(out) : out;
}

/** Tag of a route template: the area of the API it belongs to. @param {string} template */
function tagOf(template) {
  const [, root, area, , sub] = template.split('/');
  if (root !== 'v1') return 'system';
  if (area === 'sandboxes' && ['files', 'sessions', 'events'].includes(sub)) return sub;
  const tags = {
    sandboxes: 'sandboxes',
    reconcile: 'sandboxes',
    events: 'events',
    asks: 'asks',
    keys: 'keys',
    webhooks: 'webhooks',
  };
  return tags[area] ?? 'system';
}

const TAGS = Object.freeze([
  { name: 'system', description: 'Health, readiness, metrics, this document and the calling key.' },
  { name: 'sandboxes', description: 'Create, inspect, run in, checkpoint and destroy sandboxes.' },
  { name: 'files', description: 'Read, write and transfer files inside a sandbox.' },
  { name: 'sessions', description: 'Durable sessions: start, drive, wait for and read them.' },
  { name: 'events', description: 'The event log, by long-poll or WebSocket.' },
  { name: 'asks', description: 'Questions raised inside sandboxes with `wb ask`.' },
  { name: 'keys', description: 'Stored API keys and their bindings.' },
  { name: 'webhooks', description: 'Signed webhook deliveries of events.' },
]);

function scopeOf(key) {
  if (PUBLIC_ROUTES.includes(key)) return 'none';
  return SCOPE_MATRIX[key] === ANY_KEY ? 'any key' : SCOPE_MATRIX[key];
}

function accessNote(scope, unbound) {
  if (scope === 'none') return 'No authentication.';
  const needs = scope === 'any key' ? 'Scope: any key.' : `Scope: \`${scope}\`.`;
  return unbound
    ? `${needs} Needs a key that is not bound to sandboxes; a bound key is refused with 403.`
    : needs;
}

function errorRef(description) {
  return { $ref: ERROR_REF, description };
}

const MEDIA = Object.freeze({
  json: 'application/json',
  binary: 'application/octet-stream',
  prometheus: 'text/plain; version=0.0.4',
});

function requestBody(key, doc) {
  if (doc.body === 'binary')
    return { required: true, content: { [MEDIA.binary]: {} }, description: "The file's bytes." };
  const schema = BODY_SCHEMAS[key];
  if (!schema) return undefined;
  return {
    required: schema.required.length > 0,
    content: { [MEDIA.json]: { schema: toJsonSchema(schema) } },
  };
}

function responses(doc, scope, hasParams, hasInput) {
  const out = {};
  if (doc.ws) {
    out['101'] = { description: 'Switching Protocols: the WebSocket is open.' };
    out['426'] = errorRef('A plain GET without a WebSocket upgrade (`E_INVALID_PARAMS`).');
  } else
    out[String(doc.status ?? 200)] = {
      description: doc.returns,
      content: { [MEDIA[doc.media ?? 'json']]: {} },
    };
  if (hasInput)
    out['400'] = errorRef('An invalid body or query (`E_INVALID_PARAMS`) naming the first path.');
  if (scope !== 'none') out['401'] = errorRef('A missing or invalid bearer token (`E_DENIED`).');
  out['403'] = errorRef(
    scope === 'none'
      ? 'A browser-originated request or a Host the server does not serve (`E_DENIED`).'
      : 'The key lacks the scope, or a browser-originated request or foreign Host (`E_DENIED`).',
  );
  if (hasParams) out['404'] = errorRef('No such resource, or one the key does not see.');
  if (scope !== 'none')
    out['429'] = errorRef(
      'Too many failed authentications from this address (`E_LIMIT`); see `Retry-After`.',
    );
  out.default = errorRef('Any other failure; see the error codes.');
  return out;
}

function parameters(template, query = {}) {
  const out = [];
  for (const part of template.split('/')) {
    if (!part.startsWith(':')) continue;
    const name = part.slice(1);
    const known = PATH_PARAMS[name];
    if (!known) throw new Error(`path parameter ${name} of ${template} is not described`);
    out.push({ name, in: 'path', required: true, ...known });
  }
  for (const [name, param] of Object.entries(query))
    out.push({ name, in: 'query', required: param.required ?? false, ...param });
  return out;
}

function operation(key) {
  const [, template] = key.split(' ');
  const doc = ROUTE_DOCS[key];
  const scope = scopeOf(key);
  const unbound = FLEET_ROUTES.includes(key);
  const op = {
    operationId: doc.operationId,
    summary: doc.summary,
    description: `${doc.description}\n\n${accessNote(scope, unbound)}`,
    tags: [tagOf(template)],
  };
  const params = parameters(template, doc.query);
  if (params.length) op.parameters = params;
  const body = requestBody(key, doc);
  if (body) op.requestBody = body;
  op.responses = responses(doc, scope, template.includes('/:'), Boolean(body || doc.query));
  if (scope === 'none') op.security = [];
  else if (doc.ws) op.security = [{ bearer: [] }, { queryToken: [] }];
  op['x-workbox-scope'] = scope;
  if (unbound) op['x-workbox-unbound-key'] = true;
  if (doc.ws) op['x-websocket'] = true;
  return op;
}

function errorTable() {
  const byStatus = new Map();
  for (const code of Object.values(Codes)) {
    const status = httpStatusFor(code);
    byStatus.set(status, [...(byStatus.get(status) ?? []), `\`${code}\``]);
  }
  return [...byStatus.keys()]
    .sort((a, b) => a - b)
    .map((status) => `- ${status}: ${byStatus.get(status).join(', ')}`)
    .join('\n');
}

function components() {
  return {
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description: `A scoped API key: \`Authorization: Bearer <token>\`. Scopes are ${SCOPES.map((s) => `\`${s}\``).join(', ')}; \`admin\` stands for all of them.`,
      },
      queryToken: {
        type: 'apiKey',
        in: 'query',
        name: 'token',
        description: 'The same token as a query parameter, accepted on WebSocket upgrades only.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', description: 'Stable code, such as `E_NOT_FOUND`.' },
              message: { type: 'string', description: 'For people; may change.' },
              details: {
                description:
                  'Machine-readable detail, such as `{errors: [{path, message}]}` for a validation failure.',
              },
              requestId: {
                type: 'string',
                description:
                  'The request id, also in the `x-request-id` header; absent when a WebSocket upgrade is refused.',
              },
            },
          },
        },
        description: `The error envelope. Each code answers with one status:\n\n${errorTable()}\n\nA missing or invalid token is 401 \`E_DENIED\`, a body over the size cap 413 \`E_LIMIT\`, a route that exists under another method 405 \`E_INVALID_PARAMS\`, and an unknown path 404. The 5xx message of an error without a code is \`internal error\`.`,
      },
    },
    responses: {
      Error: {
        description: 'The error envelope.',
        content: { [MEDIA.json]: { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };
}

/**
 * The OpenAPI 3.1 document of the API. Deterministic: the same code gives the same document,
 * keys in the same order.
 * @param {{version: string}} opts `version` is the document's `info.version`
 * @returns {Record<string, any>}
 */
export function buildOpenApi({ version }) {
  const problems = routeDocProblems();
  if (problems.length) throw new Error(`OpenAPI route table: ${problems.join('; ')}`);
  const paths = {};
  for (const key of allRoutes()) {
    const [method, template] = key.split(' ');
    const at = openApiPath(template);
    paths[at] ??= {};
    paths[at][method.toLowerCase()] = operation(key);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Workbox API',
      version,
      summary: 'Sandboxes for AI agents over REST and WebSocket.',
      description: [
        "Create sandboxes, run commands and durable sessions in them, move files, follow events and manage keys and webhooks. This document is generated from the server's route table and request schemas.",
        'Authenticate with `Authorization: Bearer <token>`. Each operation names the scope it needs in `x-workbox-scope` and its description; `admin` stands for every scope. Operations with `x-workbox-unbound-key` refuse a key bound to sandboxes. Operations with `x-websocket` are WebSocket upgrades. A request carrying `Origin` or `Sec-Fetch-Site`, or addressed to a Host the server does not serve, is refused with 403 before authentication.',
        `JSON bodies are at most ${MAX_BODY_BYTES} bytes and are checked against the schemas here; string lengths count UTF-8 bytes. Send \`x-request-id\` to choose the request id that errors and logs carry.`,
      ].join('\n\n'),
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [
      {
        url: '/',
        description:
          'The server that serves this document; `workbox serve` listens on http://127.0.0.1:8790 by default.',
      },
    ],
    security: [{ bearer: [] }],
    tags: TAGS.map((t) => ({ ...t })),
    paths,
    components: components(),
  };
}
