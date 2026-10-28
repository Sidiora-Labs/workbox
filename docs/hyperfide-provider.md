# Hyperfide provider mapping

The server/manager operations map to Hyperfide's provider contract as follows. Each Hyperfide operation is served by the named HTTP route and manager method.

| Hyperfide operation | HTTP | Manager / store behaviour |
|---|---|---|
| `capabilities` | `GET /healthz`, `GET /readyz`, `GET /metrics` | Liveness, readiness, Prometheus metrics. |
| `prepare` | CLI: `workbox rootfs build`, `workbox runtime install` | Rootfs (uid-shifted, digest manifest) and runtime (checksummed Node + packages, manifest) are prepared on the host before any sandbox launches. |
| `ensureSandbox` | `POST /v1/sandboxes` | Create with optional `idempotencyKey`: same key + same profile returns the existing sandbox; same key + different profile is a conflict (409), never a silent substitution. Drives REQUESTED → PROVISIONING → BOOTSTRAPPING → READY. |
| `inspect` | `GET /v1/sandboxes/:id` | Desired state, observed health and `lastObservedAt` returned as separate fields. |
| `inventory` | `GET /v1/sandboxes?cursor=&limit=` | Cursor pagination with a `complete` flag. |
| `bootstrap` | (launch handshake) | `boot.json` carries a single-use nonce through the runtime directory; the first authenticated host connection consumes it; `runner.go` releases sessions only after network policy is installed and self-checks pass. |
| `startSupervisor` | `POST /v1/sandboxes/:id/sessions` | Starts a durable session (argv/cwd/env/uid/name/pty) owned by the in-box runner. |
| `attach` / `listSessions` / `signal` | WS `/v1/sandboxes/:id/sessions/:sessionId/ws`, `GET /v1/sandboxes/:id/sessions` | Attach replays retained output from a sequence (explicit gap when evicted) then streams live; input/resize/signal/stop map to the same runner methods. |
| `exec` | `POST /v1/sandboxes/:id/exec` | Run-to-completion with timeout, bounded capture and explicit truncation. |
| `captureBase` / `restoreBase` | `POST/GET /v1/sandboxes/:id/checkpoints` (+ host-side restore) | Tar of the upper layer plus an envelope with the archive SHA-256; restore verifies the digest, rejects unsafe members, and extracts into a target upper. |
| `destroy` | `DELETE /v1/sandboxes/:id` | `cgroup.kill`, wait for emptiness, remove upper/work/run, record `DELETED` only after the cgroup directory is gone; otherwise the row stays `DELETING` with the reason. |
| `drain` | `POST /v1/sandboxes/:id/drain` | Transitions READY → DRAINING (no new work) before destroy. |
| `reconcile` | `POST /v1/reconcile` | Rediscover from store + cgroup, reconnect runner sockets, list sessions losslessly; empty cgroup ⇒ `ABSENT`, never an implicit relaunch. Returns attached/absent/suspect/quarantined sets. |

Auth scopes line up with the operations that mutate: reads need `read`, execution needs `exec`, lifecycle/checkpoints need `admin`, answering human asks needs `answer`.
