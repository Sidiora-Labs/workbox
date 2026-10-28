# Architecture

Workbox is a pnpm monorepo of eight plain-JavaScript packages (Node ≥ 22.13, ESM, JSDoc).

| Package | Role |
|---|---|
| `protocol` | NDJSON framing, envelopes, error codes, hand-written validators, symmetric `Peer`. Zero dependencies; runs everywhere. |
| `core` | The engine: config, SQLite store (WAL), hash-chained audit, cgroups, rootfs/runtime builders, launch chain, slirp/nft/proxy, seccomp, sandbox state machine, `Supervisor`, `Manager`, host broker. |
| `runner` | In-box supervisor (PID 2 under bwrap). Unix socket at `/run/workbox/runner.sock`; durable pipe/PTY sessions with an 8 MiB ring spool; `fs.*` handlers; relays `broker.*` to the host control peer. Zero dependencies beyond `protocol`. |
| `wb` | The agent CLI inside the box: status, tools, session, run (evidence), ask, secret, event, lease, checkpoint, artifact, net, preset. Generated help from one registry. |
| `server` | REST + WebSocket harness surface on `node:http`: scoped Bearer keys, request ids, audit on mutation, Prometheus metrics, health/readiness, cursor inventory, ask answering, session streaming. |
| `sdk` | `WorkboxClient` + `Sandbox` handle covering every route; retry-with-jitter on idempotent calls; sessions as async iterators. |
| `mcp` | stdio MCP server exposing exactly `sandbox_create`, `sandbox_list`, `sandbox_exec`, `sandbox_destroy`. |
| `cli` | Operator CLI: doctor, rootfs, runtime, sandbox lifecycle/exec/shell/events, audit verify, `serve`; local engine or remote (`--server`/`--token`). |

## Launch chain

`sh` (joins the sandbox cgroup) → `unshare --user --mount --map-users/--map-groups` → `sh` (mounts the overlay inside the user namespace) → `bwrap` (namespaces, binds, 14 capabilities, optional `--seccomp 3`) → `setpriv` (no_new_privs, bounding set) → `/opt/workbox/bin/init.sh` → Node runner.

The host supervisor then, in order:

1. Connects to the runner socket and presents the per-boot host token (its hash was in `boot.json`, deleted by the runner after read; the token itself lives only in a host-only file).
2. Consumes the single-use boot nonce (replay quarantines the sandbox).
3. Runs `beforeGo`: attaches slirp4netns and installs nftables, resolves proxy env.
4. Sends `runner.go`; the runner's self-checks (uid/gid map, caps, NoNewPrivs, mount denied, seccomp filter mode) gate the transition to `READY`.

## Broker flow

`wb` talks only to the runner. `broker.*` calls are relayed runner → host control peer, where the broker validates (protocol schema), checks policy (secret refs, ask kinds, artifact digests), writes the store/CAS and appends an audit record. `broker.secret.resolve` is never relayed from a local peer: only the runner itself resolves refs, injecting values into one child's env.

## State

Desired state (`REQUESTED → PROVISIONING → BOOTSTRAPPING → READY → DRAINING → DELETING → DELETED`, plus `QUARANTINED`) and observed health (`HEALTHY/SUSPECT/UNKNOWN/ABSENT`) are separate fields. The `Manager` reconciles on start from the store plus cgroup: live sandboxes reattach losslessly, empty-cgroup sandboxes are observed `ABSENT` and never relaunched.
