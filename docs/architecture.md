# Architecture

Workbox is a pnpm monorepo of eight plain-JavaScript packages (Node 22.13 or later, ESM, JSDoc
types, `node --test`). Nothing is compiled or bundled.

| Package    | Role                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `protocol` | NDJSON framing with a bounded line length (8 MiB), request/response/event envelopes, error codes, hand-written schema validators, the method catalogue, the shared redactor, and `Peer`, which multiplexes requests both ways. |
| `core`     | The engine: config, SQLite store, hash-chained audit, cgroups, rootfs and runtime builders, the launch chain, netns, nftables and proxy, seccomp, the sandbox state machine, `Supervisor`, `Manager` and the host broker.      |
| `runner`   | The in-box supervisor. Serves `/run/workbox/runner.sock`, owns durable sessions with ring spools, serves `fs.*`, and relays `broker.*` calls from in-box peers to the host.                                                    |
| `wb`       | The agent CLI inside the box. One command table generates `--help`, `wb tools` and [the wb reference](wb.md).                                                                                                                  |
| `server`   | REST and WebSocket API on `node:http`: scoped bearer keys, the browser guard, schemas, request ids, audit of mutations, Prometheus metrics, `/healthz` and `/readyz`.                                                          |
| `sdk`      | `WorkboxClient` and the `Sandbox` handle over every server route, with retries on idempotent calls and sessions as async iterators.                                                                                            |
| `mcp`      | A stdio MCP server with sandbox and agent tools, built on the SDK.                                                                                                                                                             |
| `cli`      | The operator CLI `workbox`, against a local engine or a remote server.                                                                                                                                                         |

`protocol`, `runner` and `wb` have no third-party dependencies; they are what the runtime bundle
ships into every box.

## Host layout

The Workbox root (default `/var/lib/workbox`, `WORKBOX_ROOT`) holds:

| Path                 | Contents                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `workbox.db`         | SQLite store in WAL mode (`-wal` and `-shm` beside it).                                          |
| `audit/`             | Daily `audit-YYYYMMDD.ndjson` files and the writer lockfile.                                     |
| `rootfs/<name>/`     | uid-shifted root filesystems with `manifest.json` and its content digest.                        |
| `runtime/<version>/` | Node 22, protocol, runner and wb with `manifest.json`; `current` names the default.              |
| `sandboxes/<id>/`    | `upper`, `work`, `merged`, `run` (mounted at `/run/workbox`), `etc`, `launch.log`, `host-token`. |
| `artifacts/`         | Content-addressed artifact store.                                                                |
| `checkpoints/`       | Checkpoint archives.                                                                             |

Sandboxes live in the cgroup `/sys/fs/cgroup/workbox/<id>` (`WORKBOX_CGROUP_PARENT` changes the
parent).

## Preparation

- `workbox rootfs build minimal` builds `rootfs/minimal/Dockerfile` (Debian bookworm-slim with
  bash, coreutils, util-linux, procps, ca-certificates, curl, git, less, nano, jq, xz-utils and
  gnupg; toolchains come from `wb preset install`), exports it, shifts every inode's uid and gid
  by the subordinate base while restoring setuid and setgid bits, and writes a manifest with a
  sorted content digest. Identical inputs give the identical digest. Docker is needed only for
  this step.
- `workbox runtime install` verifies a Node 22 tarball against its SHA-256, copies protocol,
  runner and wb beside it, writes the `bin/wb` and `bin/init.sh` wrappers and a manifest.

## Launch chain

`Supervisor.launch` (`packages/core/src/sandbox/supervisor.js`) creates the cgroup with its
limits, prepares the sandbox directories owned by the mapped root, writes `boot.json` and the
host token, compiles the seccomp program, and spawns `packages/core/scripts/launch.sh` detached
from the daemon:

1. `sh launch.sh` writes its own pid into the sandbox cgroup, so every descendant is accounted
   and killable as one unit.
2. `unshare --user --mount --propagation private --map-users --map-groups --setuid 0 --setgid 0`
   enters a range-mapped user namespace with a private mount namespace, as inner root.
3. `sh` mounts the overlay (rootfs read-only below, `upper` on top) at `merged`. bubblewrap 0.9
   has no `--overlay`, so this happens here, inside the user namespace.
4. `bwrap` unshares pid, net, ipc, uts and cgroup, binds `merged` as `/`, the runtime read-only
   at `/opt/workbox` and `run` at `/run/workbox`, mounts `/proc`, `/dev`, and 1777 tmpfs on
   `/tmp` and `/dev/shm`, clears the environment, keeps the 14 capabilities and loads the
   seccomp program from an inherited fd.
5. `/opt/workbox/bin/init.sh` execs `setpriv --no-new-privs --bounding-set=<the same 14>`.
6. `setpriv` execs the Node runner, PID 2 in the sandbox pid namespace.

## Boot handshake

1. The supervisor connects to the runner socket and sends `runner.hello` with role `host` and the
   host token. The runner checks the token's digest, and on first contact hands over the boot
   nonce. The supervisor consumes the nonce in the store; a mismatch or replay quarantines.
2. The sandbox moves to `BOOTSTRAPPING`. The Manager's `beforeGo` hook then, when networking is
   enabled, finds the process inside the sandbox network namespace, starts that sandbox's proxy
   on `workbox0`, attaches slirp4netns (egress and allowlist), and installs the nftables ruleset
   (every mode). The proxy settings become session environment.
3. The supervisor sends `runner.go`. The runner runs its self-checks and returns them; the
   supervisor compares them with the launch and moves the sandbox to `READY`, or to
   `QUARANTINED` with the problems.
4. The supervisor polls cgroup health (`HEALTHY`, `SUSPECT`, `UNKNOWN`, `ABSENT`).

## Runner protocol

One unix socket per sandbox, `/run/workbox/runner.sock`, in the bind-mounted run directory. Both
ends speak NDJSON: requests, responses and events multiplexed by id over one connection, in both
directions (`packages/protocol/src/methods.js` lists every method and its schema).

- The host is the single control peer. It calls `runner.*`, `session.*` and `fs.*`, and serves
  `broker.*`.
- wb, and any other process in the box, connects to the same socket as a local peer. Local peers
  may use `session.*` and `fs.*`; their `broker.*` calls are relayed to the control peer.
  `runner.go`, `runner.shutdown` and `broker.secret.resolve` are refused to them.
- Sessions start from argv, cwd, env, uid and an optional name, optionally under a PTY. Output is
  delivered as `session.output` events with a per-session sequence number and stored in a ring
  spool (8 MiB by default). `session.attach` replays from a sequence and states a gap when the
  sequence has been evicted; `session.exit` carries code and signal. Sessions keep running when
  the host connection drops. Stop sends SIGTERM and escalates to SIGKILL after the grace (5 s by
  default).
- PTY sessions run under util-linux `script(1)`, which keeps the runner free of native
  dependencies; resize uses `stty -F <pty> rows R cols C`. A custom rootfs needs `script` and
  `stty` for PTY sessions.
- `exec` (`packages/core/src/sandbox/exec.js`) is a session run to completion with a timeout and
  bounded capture (1 MiB per stream by default), reporting `truncated` and `timedOut`.

## Broker

`wb` talks only to the runner. A brokered call travels wb → runner → host control peer, where
`registerBrokerHandlers` (`packages/core/src/broker/index.js`) validates it with the protocol
schema, checks policy (secret references, ask kinds, artifact digests), writes the store or the
artifact store and appends an audit record. The broker serves status, evidence, artifacts
(through the outbox in the run directory), asks, secrets, events, leases, checkpoints, network
policy and test, and preset manifests.

## Store and audit

- `packages/core/src/store.js`: `node:sqlite` in WAL mode with migrations, `integrity_check` on
  open and every mutation in a transaction. Tables hold sandboxes, transitions, boots, sessions,
  events, evidence, artifacts, leases (hashed tokens), asks, checkpoints, preset manifests and
  secret policy.
- `packages/core/src/audit.js`: append-only NDJSON with a SHA-256 chain across files, a
  cross-process lockfile, torn-final-line repair, and streaming verification.

The `events` table is one sequenced log of what happens to every sandbox. The Manager records
host events (`source: 'host'`): `sandbox.created`, `sandbox.state`, `sandbox.health` when health
changes, `session.started`, `session.exited`, `exec.finished` (naming only `argv[0]`),
`ask.raised`, `ask.answered`, `checkpoint.created` and `artifact.added`. `wb event emit` appends
`source: 'wb'` events and may not use those prefixes, nor `webhook.` or `key.`. Payloads pass
through the secret redactor, and the Manager emits `'logged'` with each stored row. A session
that exits while no host is attached is recorded when the Manager reattaches. Rows older than
`events.retentionDays` are pruned at start and every hour.

## State

Desired state follows `REQUESTED → PROVISIONING → BOOTSTRAPPING → READY → DRAINING → DELETING →
DELETED`, with `QUARANTINED` as a branch. Observed health is a separate field. Every transition is
stored with a time and reason; an illegal transition is rejected with a code.

- Destroy moves to `DELETING`, stops the network, kills the cgroup, waits for it to empty, removes
  the directories, checks that no host mount references them, and only then records `DELETED`.
  On any failure the row stays `DELETING` with `destroy incomplete: <reason>` in `stateReason`.
- `Manager.reconcile` walks every non-deleted row: a sandbox whose cgroup still has processes is
  reattached (new control connection, its sessions listed from the runner); an empty cgroup is
  observed `ABSENT` and never relaunched. The local CLI reconciles before every `sandbox` and
  `shell` command, `workbox serve` at start, and `POST /v1/reconcile` on demand.

## Surfaces

- **REST and WebSocket** (`workbox serve`, default `127.0.0.1:8790`): sandboxes (create with
  idempotency key and optional `fromCheckpoint`, list with cursor and `complete`, inspect, delete,
  drain), exec, files (read, list, write), sessions (list, start, WebSocket attach with input,
  resize and signal), evidence, artifacts, checkpoints (list, create), events (paged by
  `afterSeq`), asks (list, answer), reconcile, `/metrics`, `/healthz`, `/readyz`. Errors are
  `{error: {code, message, details?, requestId}}`.
- **SDK** (`@workbox/sdk`): `WorkboxClient` and `Sandbox` cover every route; GET, HEAD and DELETE
  are retried with jittered backoff on 5xx and network errors; `attach` returns a
  `SessionStream`; `events()` pages the events route and can follow it by polling.
- **MCP** (`workbox-mcp`, stdio): `sandbox_create`, `sandbox_list`, `sandbox_exec`,
  `sandbox_destroy`, `agent_run` and `agent_output`, over the SDK against `WORKBOX_SERVER`
  (default `http://127.0.0.1:8790`) with `WORKBOX_TOKEN`. Output is bounded to 64 KiB and waits to
  240 s.
- **CLI** (`workbox`): `doctor`, `rootfs`, `runtime`, `sandbox`, `shell`, `agent`, `serve` and
  `audit verify`. Sandbox commands use the local engine, or a server with `--server URL --token
T`. `rootfs`, `runtime` and `audit` are local only.
- **Inside the box**: `wb`, see [the wb reference](wb.md).

The operations Hyperfide's provider contract expects, and how these surfaces cover them, are in
[the provider mapping](hyperfide-provider.md).
