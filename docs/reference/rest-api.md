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
  schema; a violation is a 400 naming the first offending path.
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
| `GET /v1/sandboxes/:id/files`                  | `read`   | Query `path`; `list=1` lists a directory, otherwise reads (`offset`, `length`).                                                    |
| `PUT /v1/sandboxes/:id/files`                  | `exec`   | Write. Body: `path`, `data` (base64), `append`, `mode`, `mkdirs`.                                                                  |
| `GET /v1/sandboxes/:id/sessions`               | `read`   | List sessions.                                                                                                                     |
| `POST /v1/sandboxes/:id/sessions`              | `exec`   | Start a durable session (201).                                                                                                     |
| `GET /v1/sandboxes/:id/sessions/:sessionId/ws` | `exec`   | WebSocket attach: output, input, resize and signal. A plain GET is 426.                                                            |
| `GET /v1/sandboxes/:id/evidence`               | `read`   | Evidence envelopes recorded by `wb run`; query `cursor`, `limit`.                                                                  |
| `GET /v1/sandboxes/:id/artifacts`              | `read`   | Artifacts; query `cursor`, `limit`.                                                                                                |
| `GET /v1/sandboxes/:id/checkpoints`            | `read`   | List checkpoints.                                                                                                                  |
| `POST /v1/sandboxes/:id/checkpoints`           | `admin`  | Create a checkpoint (201).                                                                                                         |
| `GET /v1/sandboxes/:id/events`                 | `read`   | Events after `afterSeq`, up to `limit`. Paged polling, not a stream.                                                               |
| `POST /v1/reconcile`                           | `admin`  | Reconcile against the host; lists `attached`, `absent`, `suspect`, `quarantined`.                                                  |
| `GET /v1/asks`                                 | `read`   | Asks raised with `wb ask`; query `status` (default `all`), `sandboxId`, `limit`.                                                   |
| `POST /v1/asks/:askId/answer`                  | `answer` | Answer an ask. Body: `answer`.                                                                                                     |

Every mutating route is written to the audit log.

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
