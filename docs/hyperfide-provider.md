# Hyperfide provider mapping

Hyperfide drives sandbox providers through one adapter contract, defined in
`services/hyperfide/src/providers/contract.ts` of the Hyperfide repository; the Railway
(`providers/railway/`) and Blaxel (`providers/blaxel/`) providers implement it. The contract's
`PROVIDER_METHODS` are twelve operations: `capabilities`, `prepare`, `create`, `list`, `observe`,
`attach`, `execute`, `inspect`, `stop`, `transfer`, `lifetime` and `destroy`.

Workbox does not ship a Hyperfide adapter. This page maps each operation to the Workbox endpoint
or command an adapter would call, and says where Workbox falls short. "Gap" means Workbox has no
endpoint for the operation; "partial" means an endpoint exists but does not carry everything the
contract's parameters or result require. Paths are relative to `workbox serve`; scopes are from
`SCOPE_MATRIX` in `packages/server/src/auth.js`.

## Operations

| Operation      | Workbox                                                                          | Status  |
| -------------- | -------------------------------------------------------------------------------- | ------- |
| `capabilities` | none                                                                             | gap     |
| `prepare`      | CLI `workbox rootfs build <name>` and `workbox runtime install` (local only)     | partial |
| `create`       | `POST /v1/sandboxes` (admin)                                                     | partial |
| `list`         | `GET /v1/sandboxes?cursor=&limit=` (read)                                        | partial |
| `observe`      | `GET /v1/sandboxes/:id` (read)                                                   | mapped  |
| `attach`       | WebSocket `GET /v1/sandboxes/:id/sessions/:sessionId/ws` (exec)                  | partial |
| `execute`      | `POST /v1/sandboxes/:id/exec` (exec) or `POST /v1/sandboxes/:id/sessions` (exec) | partial |
| `inspect`      | `GET /v1/sandboxes/:id/sessions` (read)                                          | partial |
| `stop`         | `signal` message on the session WebSocket (exec)                                 | partial |
| `transfer`     | `PUT /v1/sandboxes/:id/files` (exec), `GET /v1/sandboxes/:id/files?path=` (read) | partial |
| `lifetime`     | none                                                                             | gap     |
| `destroy`      | `DELETE /v1/sandboxes/:id` (admin)                                               | mapped  |

### capabilities

Gap. No endpoint returns a capability profile (scope, SDK pin, preparation digest, OS and the
per-capability support, availability and basis). `GET /healthz`, `GET /readyz` and `GET /metrics`
report liveness, readiness and counters only, and `workbox doctor --json` reports host
prerequisites. An adapter would have to build the profile itself. Against the contract's
`CAPABILITY_NAMES`, Workbox has: `create`, `list`, `observe`, `attach`, `execute`, `inspect`,
`stop`, `transfer` and `destroy` (as partially mapped above); `stdin` (session input over the
WebSocket, `input` on exec); `disk_snapshot` (checkpoints of the upper layer); and
`network_isolated` (network mode `none`). It has no `memory_snapshot`, `network_private`,
`public_ingress`, `persistent_storage` (the upper layer is deleted with the sandbox) or
`shared_storage`, and no `lifetime`.

### prepare

Partial. Preparation is a local operator step, not an API call: `workbox rootfs build <name>`
builds `rootfs/<name>/Dockerfile` into a uid-shifted rootfs with a content digest in its
manifest, and `workbox runtime install` installs the checksummed runtime. The contract's
`image_reference` (an arbitrary image) and `recipe_digest` have no counterpart: the recipe is the
Dockerfile in the repository, and the manifest digest is the preparation digest an adapter would
report. A sandbox selects a prepared rootfs and runtime by name (`rootfs`, `runtime` on create).

### create

Partial. `POST /v1/sandboxes` with `{name?, rootfs?, runtime?, profile?, labels?, idempotencyKey?,
secretRefs?, fromCheckpoint?}`. The same `idempotencyKey` with the same profile returns the
existing sandbox; with a different profile it is a 409 conflict. The call returns 201 only once
the sandbox is `READY` (the contract's `RUNNING`), never at `CREATING`, and a launch failure
leaves a `QUARANTINED` row. Mapping the parameters:

- `resources.cpu_millis` and `resources.memory_bytes` map to `profile.limits.cpuMillis` and
  `profile.limits.memoryBytes`; `disk_bytes` and `persistent_volume_bytes` have no counterpart.
- `network: 'ISOLATED'` maps to `profile.network.mode: 'none'`. There is no `PRIVATE` network;
  `egress` and `allowlist` reach the public internet.
- `stdin_required` needs no setting: every session accepts input.

### list

Partial. `GET /v1/sandboxes?cursor=&limit=` returns `{items, cursor, complete}`; `cursor` is null
on the last page. There is no `has_more`, `snapshot_id` or `observed_at`; consistency is
best-effort (each page is a separate read). Deleted sandboxes are listed only with
`includeDeleted=1`.

### observe

Mapped. `GET /v1/sandboxes/:id` returns desired state (`desired`), `health` and `lastObservedAt`
as separate fields. Health uses the contract's own values (`HEALTHY`, `SUSPECT`, `UNKNOWN`,
`ABSENT`). Desired state maps to `provider_state` as: `REQUESTED`, `PROVISIONING`,
`BOOTSTRAPPING` → `CREATING`; `READY`, `DRAINING` → `RUNNING`; `DELETING` → `DESTROYING`;
`DELETED` → `DESTROYED`; `QUARANTINED` → `FAILED`.

### attach

Partial. A session id is the `process_ref`. The session WebSocket replays the retained output and
then streams live events (`session.output` with `seq`, `session.exit`). The server always attaches
from sequence 0, so a `resume_cursor` cannot be passed; a client resumes by skipping events with
`seq` at or below its cursor, and output evicted from the 8 MiB ring is reported as a gap.

### execute

Partial. Non-durable execution maps to `POST /v1/sandboxes/:id/exec` (`argv`, `cwd`, `env`,
`input`, `timeoutMs`, `maxOutputBytes`), which returns `exitCode`, `signal`, `stdout`, `stderr`,
`truncated`, `timedOut` and `durationMs`. Durable execution (`durable: true`) maps to
`POST /v1/sandboxes/:id/sessions`, which returns a `sessionId` at start. `env_refs`
(`{ENV: "secret-ref:REF"}`) can be expressed only on sessions, as `secretRefs: ["REF=ENV"]`, and
only for references granted at create. Gaps: the exec result carries no output byte count or
SHA-256 (the contract requires a digest for complete output); exec takes no secret references;
there is no separate `wait_timeout_ms`.

### inspect

Partial. `GET /v1/sandboxes/:id/sessions` lists every session of the sandbox with its exit, when
it has one; there is no single-session route, so an adapter filters by `process_ref`. Output
completeness and digest are not reported.

### stop

Partial. A `{"type": "signal", "signal": "SIGTERM"}` or `"SIGKILL"` message on the session
WebSocket signals the session; termination is confirmed by the `session.exit` event that follows,
which carries the exit code. There is no REST route for stopping a session, and the runner's
TERM-then-KILL `session.stop` is not exposed over the API. Draining a whole sandbox is
`POST /v1/sandboxes/:id/drain`, which the contract does not have.

### transfer

Partial. Upload maps to `PUT /v1/sandboxes/:id/files` with `{path, data (base64), append?, mode?,
mkdirs?}`; download to `GET /v1/sandboxes/:id/files?path=&offset=&length=`. A read returns at
most 4 MiB and a write is bounded by the 8 MiB request body, so larger files take several calls
(`append` on upload, `offset` on download). The files API does not take or verify an
`artifact_digest`; an adapter must hash on its side. Artifacts produced by `wb artifact put` and
`wb run` can be listed (`GET /v1/sandboxes/:id/artifacts`) but not downloaded over the API.

### lifetime

Gap. Workbox sandboxes have no idle expiry: they run until destroyed, which is the behaviour of
`NO_IDLE_EXPIRY`. `BOUNDED` has no counterpart. Each sandbox has a lease that the agent can
renew from inside the box (`wb lease`), but there is no API for it and an expired lease stops
nothing.

### destroy

Mapped. `DELETE /v1/sandboxes/:id` kills the cgroup, waits for it to empty, removes the sandbox
directories and returns the row in `DELETED`, which is the contract's `deletion: CONFIRMED`. When
absence cannot be confirmed the call fails and the row stays `DELETING` with the reason. The
contract's `reason` parameter is not taken by the route.

## Workbox operations without a contract counterpart

`POST /v1/sandboxes/:id/drain`, `POST /v1/reconcile` (rediscover sandboxes after a daemon
restart), checkpoints (`GET`/`POST /v1/sandboxes/:id/checkpoints`, restore through
`fromCheckpoint` on create), evidence, events, asks (`GET /v1/asks`,
`POST /v1/asks/:askId/answer`) and file listing.

## Errors

REST errors are `{error: {code, message, details?, requestId}}` with the HTTP status from
`httpStatusFor` in `packages/core/src/errors.js`. A suggested mapping onto the contract's
`ErrorCode`: 401 → `AUTHENTICATION`; 403 `E_DENIED` → `AUTHORIZATION`; 404 `E_NOT_FOUND` →
`NOT_FOUND`; 409 `E_CONFLICT`, `E_STATE`, `E_BUSY` → `CONFLICT`; 400 `E_INVALID_PARAMS` and 413 →
`INVALID_REQUEST`; 503 `E_UNAVAILABLE` → `UNAVAILABLE`; 504 `E_TIMEOUT` → `TIMEOUT`; 501
`E_UNSUPPORTED` → `UNSUPPORTED`; anything else → `INTERNAL`. 429 `E_LIMIT` means a capacity or
size limit, not a request rate: Workbox does no rate limiting, so it is `UNAVAILABLE` for
capacity, never `RATE_LIMIT`.
