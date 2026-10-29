# REST and WebSocket API

Served by `workbox serve` (default `http://127.0.0.1:8790`) on `node:http`. The routes, scopes and
body schemas below are `SCOPE_MATRIX` in `packages/server/src/auth.js` and `BODY_SCHEMAS` in
`packages/server/src/server.js`. The [SDK](../guides/sdk.md) covers every route; the table in
[the provider mapping](../hyperfide-provider.md) shows how they line up with Hyperfide's contract.

## Requests

- Authenticate with `Authorization: Bearer <token>`. A WebSocket upgrade also accepts
  `?token=<token>`; see the [stated limit](../security.md#stated-limits).
- A request carrying `Origin` or `Sec-Fetch-Site`, or addressed to a `Host` other than
  `localhost`, `127.0.0.1`, `::1` or a configured `serverNames` entry, is refused with 403 before
  authentication.
- Bodies are JSON, capped at 8 MiB (the protocol's frame limit) and validated against the route's
  schema; a violation is a 400 naming the first offending path. The raw file upload is the
  exception: its body is the file's bytes, capped by `maxUploadBytes` (default 1 GiB).
- Send `x-request-id` (letters, digits, `.`, `_`, `-`, up to 128) to choose the request id; otherwise
  one is generated. It is echoed in the `x-request-id` header and in errors.

## Routes

| Route                                          | Scope    | Purpose                                                                                                                            |
| ---------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                 | none     | Liveness.                                                                                                                          |
| `GET /readyz`                                  | none     | Readiness; 503 while the server shuts down.                                                                                        |
| `GET /metrics`                                 | `read`   | Prometheus text.                                                                                                                   |
| `GET /v1/sandboxes`                            | `read`   | List; query `cursor`, `limit`, `includeDeleted=1`.                                                                                 |
| `POST /v1/sandboxes`                           | `admin`  | Create (201). Body: `name`, `rootfs`, `runtime`, `profile`, `labels`, `idempotencyKey`, `secretRefs`, `fromCheckpoint`.            |
| `GET /v1/sandboxes/:id`                        | `read`   | Inspect.                                                                                                                           |
| `DELETE /v1/sandboxes/:id`                     | `admin`  | Destroy.                                                                                                                           |
| `POST /v1/sandboxes/:id/drain`                 | `admin`  | Stop new work. Body: `reason`.                                                                                                     |
| `POST /v1/sandboxes/:id/exec`                  | `exec`   | Run to completion. Body: `argv` (required), `cwd`, `env`, `input`, `name`, `uid`, `gid`, `timeoutMs`, `graceMs`, `maxOutputBytes`. |
| `GET /v1/sandboxes/:id/files`                  | `read`   | Query `path`; `list=1` lists a directory, `stat=1` stats the path, otherwise reads (`offset`, `length`).                           |
| `PUT /v1/sandboxes/:id/files`                  | `exec`   | Write. Body: `path`, `data` (base64), `append`, `mode`, `mkdirs`.                                                                  |
| `DELETE /v1/sandboxes/:id/files`               | `exec`   | Remove the file or empty directory at query `path`; `recursive=1` removes a tree.                                                  |
| `POST /v1/sandboxes/:id/files/mkdir`           | `exec`   | Create a directory. Body: `path` (required), `parents` (default true; false answers 404 when the parent is missing), `mode`.       |
| `GET /v1/sandboxes/:id/files/raw`              | `read`   | The bytes of the file at query `path` as `application/octet-stream`, streamed, of any size.                                        |
| `PUT /v1/sandboxes/:id/files/raw`              | `exec`   | Replace the file at query `path` with the request body, streamed in; `mode` (octal, e.g. `644`), `mkdirs=1`. See below.            |
| `GET /v1/sandboxes/:id/sessions`               | `read`   | List sessions.                                                                                                                     |
| `POST /v1/sandboxes/:id/sessions`              | `exec`   | Start a durable session (201).                                                                                                     |
| `GET /v1/sandboxes/:id/sessions/:sessionId`    | `read`   | One session with `exited` (`{code, signal, at}` or null).                                                                          |
| `DELETE /v1/sandboxes/:id/sessions/:sessionId` | `exec`   | Forget an exited session and its output; 409 `E_STATE` while it runs.                                                              |
| `GET .../sessions/:sessionId/output`           | `read`   | Retained output without attaching; query `fromSeq`, `maxBytes`, `encoding`. See below.                                             |
| `POST .../sessions/:sessionId/wait`            | `read`   | Wait for the exit. Body: `timeoutMs` (default 30000, at most 300000). Returns `{sessionId, exited}`; `exited` is null on timeout.  |
| `POST .../sessions/:sessionId/input`           | `exec`   | Write to stdin. Body: `data` (base64) or `text` (UTF-8), `eof` to close it.                                                        |
| `POST .../sessions/:sessionId/signal`          | `exec`   | Signal the session's process group. Body: `signal` (e.g. `SIGTERM`).                                                               |
| `POST .../sessions/:sessionId/stop`            | `exec`   | SIGTERM, then SIGKILL after `graceMs`; returns the exit.                                                                           |
| `POST .../sessions/:sessionId/resize`          | `exec`   | Resize a PTY session. Body: `rows`, `cols`. A session without a PTY is 501.                                                        |
| `GET /v1/sandboxes/:id/sessions/:sessionId/ws` | `exec`   | WebSocket attach: output, input, resize and signal. A plain GET is 426.                                                            |
| `GET /v1/sandboxes/:id/evidence`               | `read`   | Evidence envelopes recorded by `wb run`; query `cursor`, `limit`.                                                                  |
| `GET /v1/sandboxes/:id/artifacts`              | `read`   | Artifacts; query `cursor`, `limit`.                                                                                                |
| `GET /v1/sandboxes/:id/artifacts/:sha256`      | `read`   | The artifact's bytes, streamed; 404 unless this sandbox holds that digest.                                                         |
| `GET /v1/sandboxes/:id/checkpoints`            | `read`   | List checkpoints.                                                                                                                  |
| `POST /v1/sandboxes/:id/checkpoints`           | `admin`  | Create a checkpoint (201).                                                                                                         |
| `GET /v1/sandboxes/:id/events`                 | `read`   | Events after `afterSeq`, up to `limit`. Paged polling, not a stream.                                                               |
| `POST /v1/reconcile`                           | `admin`  | Reconcile against the host; lists `attached`, `absent`, `suspect`, `quarantined`.                                                  |
| `GET /v1/asks`                                 | `read`   | Asks raised with `wb ask`; query `status` (default `all`), `sandboxId`, `limit`.                                                   |
| `POST /v1/asks/:askId/answer`                  | `answer` | Answer an ask. Body: `answer`.                                                                                                     |

`...` stands for `/v1/sandboxes/:id`. Every mutating route is written to the audit log.

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

## Scopes

`read`, `exec`, `admin` and `answer`. A key holds a set of them; a request needs the one in the
table. `WORKBOX_TOKEN` defines one key with all four. Keys are configured as described in
[Configuration](configuration.md#serve-config-file).

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
