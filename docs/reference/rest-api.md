# REST and WebSocket API

Served by `workbox serve` (default `http://127.0.0.1:8790`) on `node:http`, or on `node:https` when
it is given a certificate. The routes, scopes and body schemas below are `SCOPE_MATRIX` in
`packages/server/src/auth.js` and `BODY_SCHEMAS` in `packages/server/src/server.js`. The
[SDK](../guides/sdk.md) covers every route; the table in
[the provider mapping](../hyperfide-provider.md) shows how they line up with Hyperfide's contract.

## OpenAPI document

`GET /v1/openapi.json` returns an OpenAPI 3.1 description of every route below, generated from the
same route table, scopes and body schemas the server enforces. It needs no token; the browser and
`Host` checks still apply. A copy is checked in at [openapi.json](openapi.json); `make openapi-docs`
rewrites it and `make docs-check` fails when it is out of date.

An agent can hand the document to its tools to learn the routes and their request shapes, then
write its own calls against them. Beyond standard OpenAPI, each operation carries:

- `x-workbox-scope`: the scope it needs (`read`, `exec`, `admin`, `answer`, `any key`, or `none`).
- `x-workbox-unbound-key: true`: a key bound to sandboxes is refused (the fleet routes).
- `x-websocket: true`: a WebSocket upgrade; its description lists the frames.

The SDK's `client.openapi()` fetches it.

## Requests

- Authenticate with `Authorization: Bearer <token>`. A WebSocket upgrade also accepts
  `?token=<token>`; see the [stated limit](../security.md#stated-limits).
- A request carrying `Origin` or `Sec-Fetch-Site`, or addressed to a `Host` other than
  `localhost`, `127.0.0.1`, `::1` or a configured `serverNames` entry, is refused with 403 before
  authentication.
- After 20 failed authentications (a missing or invalid token, on REST or a WebSocket upgrade)
  within 60 s, every request from that client address is answered 429 `E_LIMIT` with a
  `Retry-After` header, before authentication, until the 60 s that began with its first failure
  have passed. Successful requests do not count.
- Bodies are JSON, capped at 8 MiB (the protocol's frame limit) and validated against the route's
  schema; a violation is a 400 naming the first offending path. The raw file upload is the
  exception: its body is the file's bytes, capped by `maxUploadBytes` (default 1 GiB).
- Send `x-request-id` (letters, digits, `.`, `_`, `-`, up to 128) to choose the request id; otherwise
  one is generated. It is echoed in the `x-request-id` header and in errors.

## Routes

| Route                                          | Scope    | Purpose                                                                                                                                |
| ---------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                 | none     | Liveness.                                                                                                                              |
| `GET /readyz`                                  | none     | Readiness; 503 while the server shuts down.                                                                                            |
| `GET /v1/openapi.json`                         | none     | The OpenAPI 3.1 document of this API; see [above](#openapi-document).                                                                  |
| `GET /metrics`                                 | `read`   | Prometheus text.                                                                                                                       |
| `GET /v1/sandboxes`                            | `read`   | List; query `cursor`, `limit`, `includeDeleted=1`.                                                                                     |
| `POST /v1/sandboxes`                           | `admin`  | Create (201). Body: `name`, `rootfs`, `runtime`, `profile`, `labels`, `idempotencyKey`, `secretRefs`, `fromCheckpoint`.                |
| `GET /v1/sandboxes/:id`                        | `read`   | Inspect.                                                                                                                               |
| `DELETE /v1/sandboxes/:id`                     | `admin`  | Destroy.                                                                                                                               |
| `POST /v1/sandboxes/:id/drain`                 | `admin`  | Stop new work. Body: `reason`.                                                                                                         |
| `POST /v1/sandboxes/:id/exec`                  | `exec`   | Run to completion. Body: `argv` (required), `cwd`, `env`, `input`, `name`, `uid`, `gid`, `timeoutMs`, `graceMs`, `maxOutputBytes`.     |
| `GET /v1/sandboxes/:id/files`                  | `read`   | Query `path`; `list=1` lists a directory, `stat=1` stats the path, otherwise reads (`offset`, `length`).                               |
| `PUT /v1/sandboxes/:id/files`                  | `exec`   | Write. Body: `path`, `data` (base64), `append`, `mode`, `mkdirs`.                                                                      |
| `DELETE /v1/sandboxes/:id/files`               | `exec`   | Remove the file or empty directory at query `path`; `recursive=1` removes a tree.                                                      |
| `POST /v1/sandboxes/:id/files/mkdir`           | `exec`   | Create a directory. Body: `path` (required), `parents` (default true; false answers 404 when the parent is missing), `mode`.           |
| `GET /v1/sandboxes/:id/files/raw`              | `read`   | The bytes of the file at query `path` as `application/octet-stream`, streamed, of any size.                                            |
| `PUT /v1/sandboxes/:id/files/raw`              | `exec`   | Replace the file at query `path` with the request body, streamed in; `mode` (octal, e.g. `644`), `mkdirs=1`. See below.                |
| `GET /v1/sandboxes/:id/sessions`               | `read`   | List sessions.                                                                                                                         |
| `POST /v1/sandboxes/:id/sessions`              | `exec`   | Start a durable session (201).                                                                                                         |
| `GET /v1/sandboxes/:id/sessions/:sessionId`    | `read`   | One session with `exited` (`{code, signal, at}` or null).                                                                              |
| `DELETE /v1/sandboxes/:id/sessions/:sessionId` | `exec`   | Forget an exited session and its output; 409 `E_STATE` while it runs.                                                                  |
| `GET .../sessions/:sessionId/output`           | `read`   | Retained output without attaching; query `fromSeq`, `maxBytes`, `encoding`. See below.                                                 |
| `POST .../sessions/:sessionId/wait`            | `read`   | Wait for the exit. Body: `timeoutMs` (default 30000, at most 300000). Returns `{sessionId, exited}`; `exited` is null on timeout.      |
| `POST .../sessions/:sessionId/input`           | `exec`   | Write to stdin. Body: `data` (base64) or `text` (UTF-8), `eof` to close it.                                                            |
| `POST .../sessions/:sessionId/signal`          | `exec`   | Signal the session's process group. Body: `signal` (e.g. `SIGTERM`).                                                                   |
| `POST .../sessions/:sessionId/stop`            | `exec`   | SIGTERM, then SIGKILL after `graceMs`; returns the exit.                                                                               |
| `POST .../sessions/:sessionId/resize`          | `exec`   | Resize a PTY session. Body: `rows`, `cols`. A session without a PTY is 501.                                                            |
| `GET /v1/sandboxes/:id/sessions/:sessionId/ws` | `exec`   | WebSocket attach: output, input, resize and signal. A plain GET is 426.                                                                |
| `GET /v1/sandboxes/:id/evidence`               | `read`   | Evidence envelopes recorded by `wb run`; query `cursor`, `limit`.                                                                      |
| `GET /v1/sandboxes/:id/artifacts`              | `read`   | Artifacts; query `cursor`, `limit`.                                                                                                    |
| `GET /v1/sandboxes/:id/artifacts/:sha256`      | `read`   | The artifact's bytes, streamed; 404 unless this sandbox holds that digest.                                                             |
| `GET /v1/sandboxes/:id/checkpoints`            | `read`   | List checkpoints.                                                                                                                      |
| `POST /v1/sandboxes/:id/checkpoints`           | `admin`  | Create a checkpoint (201).                                                                                                             |
| `GET /v1/sandboxes/:id/events`                 | `read`   | This sandbox's events; query `afterSeq`, `limit`, `types`, `waitMs`. See [Events](#events).                                            |
| `GET /v1/sandboxes/:id/events/ws`              | `read`   | WebSocket of this sandbox's events: stored ones after `afterSeq`, then live. Query `afterSeq`, `types`. A plain GET is 426.            |
| `GET /v1/events`                               | `read`   | Events of every sandbox the key sees; query `afterSeq`, `limit`, `types`, `sandboxId`, `waitMs`.                                       |
| `GET /v1/events/ws`                            | `read`   | WebSocket of the same events: stored ones after `afterSeq`, then live. Query `afterSeq`, `types`, `sandboxId`. A plain GET is 426.     |
| `POST /v1/reconcile`                           | `admin`  | Reconcile against the host; lists `attached`, `absent`, `suspect`, `quarantined`.                                                      |
| `GET /v1/asks`                                 | `read`   | Asks raised with `wb ask`; query `status` (default `all`), `sandboxId`, `limit`.                                                       |
| `POST /v1/asks/:askId/answer`                  | `answer` | Answer an ask. Body: `answer`.                                                                                                         |
| `GET /v1/whoami`                               | any key  | The calling key: `id`, `scopes`, `binding`, `source` (`config` or `store`), `expiresAt`.                                               |
| `POST /v1/keys`                                | `admin`  | Mint a stored key (201). Body: `name` and `scopes` (required), `labels`, `sandboxIds`, `ttlSeconds`. The token is in this answer only. |
| `GET /v1/keys`                                 | `admin`  | Stored keys with `lastUsedAt` and `revokedAt`; never a token or its digest.                                                            |
| `DELETE /v1/keys/:keyId`                       | `admin`  | Revoke a stored key; it stops working on the next request. Answers the revoked key.                                                    |

`...` stands for `/v1/sandboxes/:id`. Every mutating route is written to the audit log, and so is
every WebSocket that opens (`api.session.attach`, `api.events.stream`).

## Sessions without a WebSocket

A session started with `POST /v1/sandboxes/:id/sessions` keeps running whether or not anyone is
attached, so a client with only HTTP can drive a build:

```sh
S=http://127.0.0.1:8790/v1/sandboxes/$ID
AUTH="Authorization: Bearer $WORKBOX_TOKEN"
SID=$(curl -s -H "$AUTH" -d '{"argv":["sh","-c","make test"]}' $S/sessions | jq -r .sessionId)
curl -s -H "$AUTH" -d '{"timeoutMs":300000}' $S/sessions/$SID/wait
curl -s -H "$AUTH" "$S/sessions/$SID/output?encoding=text"
```

`wait` answers as soon as the session exits, at once if it already has, and with `exited: null`
when the timeout passes first; call it again to keep waiting.

`output` returns `{sessionId, chunks: [{seq, stream, data}], nextSeq, gap, truncated, exited}`.
Chunks are whole: they come from `fromSeq` (default 0) until the next one would pass `maxBytes`
(default 1 MiB, at most 4 MiB), and at least one comes when any is retained. `stream` is
`stdout`, `stderr` or `pty`. `data` is base64, or UTF-8 text with `encoding=text`. Read again from
`nextSeq` while `truncated` is true; `truncated` is also set when a chunk lost its start to the
session's spool limit. `gap` is `{requested, available}` when output before `available` has
already been dropped from the spool. Once `exited` is set, every byte of output is in the spool.

A sandbox started by an older runner without this route answers `output` with 501
`E_UNSUPPORTED`; recreate the sandbox to use it.

## Raw files

`GET .../files/raw?path=` sends the file's bytes with `content-length` from its size; the server
reads it from the sandbox in 4 MiB pieces as it sends. If the file shrinks while it is read, the
connection is cut short of that length.

`PUT .../files/raw?path=` takes the file's bytes as the request body, with or without a
`content-length`, and writes them into the sandbox in 4 MiB pieces as they arrive: the first
replaces the file, the rest append. A body over the server's `maxUploadBytes` is a 413 `E_LIMIT`,
refused from `content-length` before any byte is read or as soon as the stream passes the cap.
On any failure the partly written file is removed. The answer is `{path, bytes}`.

```sh
curl -s -H "$AUTH" -T build.tar.gz "$S/files/raw?path=/workspace/build.tar.gz&mkdirs=1"
curl -s -H "$AUTH" -o report.html "$S/files/raw?path=/workspace/report.html"
```

## Events

Every sandbox has one log of events, numbered by a `seq` shared across the fleet. An event is

```json
{
  "seq": 42,
  "sandboxId": "01...",
  "type": "session.exited",
  "source": "host",
  "payload": { "sessionId": "...", "name": "build", "code": 0, "signal": null },
  "causation": null,
  "at": 1761700000000
}
```

`source` is `host` for events the engine records (`sandbox.created`, `sandbox.state`,
`sandbox.health`, `session.started`, `session.exited`, `exec.finished`, `ask.raised`,
`ask.answered`, `checkpoint.created`, `artifact.added`) and `wb` for `wb event emit` inside the
box.

Both REST routes answer `{"events": [...], "nextSeq": N}` in `seq` order. Pass `nextSeq` back as
`afterSeq` for the next page; it is the last returned `seq`, or `afterSeq` when nothing came back.

| Query       | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `afterSeq`  | Events with a greater `seq` (default 0).                                                   |
| `limit`     | At most this many (default 100, at most 1000).                                             |
| `types`     | Comma-separated; each an exact type, or `prefix.*` for every type starting with `prefix.`. |
| `sandboxId` | `GET /v1/events` only: one sandbox.                                                        |
| `waitMs`    | Long-poll, 0 to 60000. With nothing after `afterSeq` yet, wait this long for a new match.  |

With `waitMs`, the request answers as soon as a matching event is logged, or with an empty
`events` when the time is up, the client goes away or the server shuts down. A script can loop on
`GET /v1/events?afterSeq=N&types=session.exited&waitMs=30000` and learn of each exit within
moments, without polling in a tight loop.

The two WebSocket routes push the same events. With `afterSeq` they first replay the stored
events after it, then send new ones as they are logged; without it they send only new ones. Each
event arrives once, in `seq` order, with nothing lost at the switch. The frames are:

- `{"type": "event", "event": {...}}`, one per event.
- `{"type": "live", "seq": N}`, once, when the stream turns live: every matching event up to `N`
  has been sent and later ones follow as they are logged.
- `{"type": "error", "code", "message"}` before the server closes the stream with 1011.

A client that reads too slowly is dropped once 1 MiB (the default) is waiting to be sent to it. Shutdown closes
the streams with 1001. To resume after either, reconnect with `afterSeq` set to the last `seq`
received, or to the `live` frame's `N` when that is greater. The SDK's `events()` does this.

## Webhooks

A webhook is an endpoint that gets a signed `POST` for every event it matches; see
[the guide](../guides/webhooks.md) for the request format, signature checks and retries.

| Route                                                       | Scope   | Purpose                                                                                                                          |
| ----------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/webhooks`                                         | `admin` | Register a webhook (201). Body: `url` (required), `types`, `sandboxId`, `labels`, `description`. The `secret` is in this answer. |
| `GET /v1/webhooks`                                          | `read`  | `{webhooks: [...]}`, in creation order, without secrets.                                                                         |
| `GET /v1/webhooks/:webhookId`                               | `read`  | One webhook.                                                                                                                     |
| `PATCH /v1/webhooks/:webhookId`                             | `admin` | Change it. Body: `url`, `types`, `description`, `enabled`; enabling clears `disabledReason`.                                     |
| `DELETE /v1/webhooks/:webhookId`                            | `admin` | Delete it and its deliveries. Answers the deleted webhook.                                                                       |
| `POST /v1/webhooks/:webhookId/rotate-secret`                | `admin` | Replace the signing secret; the new `secret` is in this answer. Later attempts, retries included, use it.                        |
| `POST /v1/webhooks/:webhookId/test`                         | `admin` | Queue one `webhook.test` delivery (202), outside the event log: its `seq` and `sandboxId` are null.                              |
| `GET /v1/webhooks/:webhookId/deliveries`                    | `read`  | Deliveries, newest first; query `status` (`pending`, `delivered`, `failed`), `limit`, `cursor`.                                  |
| `POST /v1/webhooks/:webhookId/deliveries/:deliveryId/retry` | `admin` | Send a delivery again now (202), whatever its state.                                                                             |

- `url` must be `https:` without credentials, at most 2048 characters, and its host must resolve
  only to public addresses; otherwise the request is 400 `E_INVALID_PARAMS`. The engine
  configuration's `webhooks.allowHttp` and `webhooks.allowPrivate` relax this
  ([Configuration](configuration.md#webhooks)).
- `types` holds up to 64 event types or `prefix.*` patterns; none means every type. `sandboxId`
  must name a sandbox the caller sees (404 otherwise). `labels` keeps events of sandboxes that
  carry every label.
- A webhook row is `{id, url, types, sandboxId, labels, description, enabled, disabledReason,
ownerKey, binding, lastSeq, createdAt, updatedAt}`. `ownerKey` is the key that created it and
  `binding` a copy of that key's binding, which limits the events it receives. `lastSeq` is the
  event it has queued deliveries up to; a new webhook starts at the newest event.
- A delivery row is `{id, webhookId, eventSeq, event, status, attempts, nextAt, lastStatus,
lastError, createdAt, deliveredAt}`. `id` is the `webhook-id` header; `event` is the event as it
  was when the delivery was queued; `lastError` holds at most 4 KiB of the last failed answer.
- The secret is returned by create and rotate only, and never written to logs or the audit log.

## Scopes

`read`, `exec`, `admin` and `answer`. A key holds a set of them; a request needs the one in the
table, and `admin` stands for all four. `GET /v1/whoami` takes any valid key. `WORKBOX_TOKEN`
defines one key with all four. Keys are configured as described in
[Configuration](configuration.md#serve-config-file) or stored with `POST /v1/keys` or
`workbox key create`.

## Stored keys and bound access

A stored key lives in the server's database, which keeps only the SHA-256 digest of its token.
The token is `wbk_` followed by 43 base64url characters (32 random bytes). It is returned once,
when the key is made, and cannot be shown again; the redactor removes anything of that shape from
logs and the audit log. A key made with `ttlSeconds` stops working when that time has passed. A
revoked key stops working on the next request.

`labels` and `sandboxIds` bind a key to some sandboxes. A bound key sees a sandbox when its id is
in `sandboxIds`, or when the sandbox carries every one of the `labels` with the same value. Keys
from the serve config file and `WORKBOX_TOKEN` are never bound.

For a bound key:

- `GET /v1/sandboxes` and `GET /v1/asks` list only the sandboxes it sees and their asks.
- `GET /v1/events` and `GET /v1/events/ws` carry only the events of the sandboxes it sees, both
  stored and live; a long-poll is not woken by the others.
- Every route with `:id`, including the session WebSocket, answers a sandbox it does not see
  exactly as one that does not exist: 404 `E_NOT_FOUND`. Answering an ask of such a sandbox is
  404 as well.
- `POST /v1/sandboxes` puts the key's labels on the new sandbox. A body label with another value
  is 403. A key bound only by `sandboxIds` cannot create sandboxes (403). An `idempotencyKey`
  already used by a sandbox the key does not see is 409, and `fromCheckpoint` must name a
  checkpoint of a sandbox it sees.
- The fleet routes `GET /metrics`, `POST /v1/reconcile` and the `/v1/keys` routes are 403.
- The `/v1/webhooks` routes show and change only the webhooks the key created; any other answers
  404 like a missing one. A webhook it creates receives only events of the sandboxes it sees.

## Errors

Failures return `{"error": {"code", "message", "details"?, "requestId"}}` with the status below.
The 5xx message of an error without a code is `internal error`.

| Code                              | Status                                   |
| --------------------------------- | ---------------------------------------- |
| `E_INVALID_PARAMS`, `E_PARSE`     | 400                                      |
| `E_DENIED`                        | 403 (401 for a missing or invalid token) |
| `E_NOT_FOUND`, `E_UNKNOWN_METHOD` | 404                                      |
| `E_CONFLICT`, `E_STATE`, `E_BUSY` | 409                                      |
| `E_LINE_TOO_LONG`                 | 413                                      |
| `E_GAP`                           | 416                                      |
| `E_LIMIT`                         | 429                                      |
| `E_QUARANTINED`                   | 423                                      |
| `E_UNSUPPORTED`                   | 501                                      |
| `E_UNAVAILABLE`, `E_CLOSED`       | 503                                      |
| `E_TIMEOUT`                       | 504                                      |
| `E_CANCELLED`                     | 499                                      |
| `E_INTERNAL`                      | 500                                      |

A route that exists with the wrong method is 405 (`E_INVALID_PARAMS`); an unknown path is 404.
The SDK raises `WorkboxApiError` for each of these.
