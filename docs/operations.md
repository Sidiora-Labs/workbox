# Operations

Procedures for running Workbox on one Linux host. `workbox` below is the operator CLI,
`packages/cli/src/main.js` (the `workbox` bin of `@workbox/cli`); from a checkout run it as
`node packages/cli/src/main.js`. Everything here runs as root.

## Install

1. Run `sh deploy/install.sh`. It creates the Workbox root (`/var/lib/workbox`, or
   `WORKBOX_ROOT`; mode 0710 with the uid base as its group, so a sandbox's mapped root can reach
   its overlay layers and no other host user can enter; the daemon restores this mode before every
   launch) and `/etc/workbox` (mode 0700), adds `root:300000:65536` to `/etc/subuid` and
   `/etc/subgid`, and creates the `workbox` cgroup parent with the cpu, memory and pids
   controllers delegated. It changes no sysctl: the daemon runs as root, so AppArmor's
   unprivileged user namespace restriction does not apply to it. It is safe to run
   again.
2. Run `workbox doctor` (or `workbox doctor --json`). It reports every host prerequisite as pass
   or fail with a remedy: privileges, kernel, bubblewrap, unshare, the tools the launch chain and
   network need (including `/dev/net/tun` and the kernel's dummy link type), `xz` for runtime
   installs, user namespaces, cgroup v2 controllers, overlayfs inside a user namespace mounted
   under the Workbox root itself (which must not be on overlayfs), Docker for rootfs builds, and
   whether a rootfs and a runtime are installed. It exits 0 on a ready host and 4 otherwise. Fix
   every failure before creating sandboxes.
3. `workbox rootfs build minimal` builds the base rootfs (needs Docker). `workbox rootfs build
agents` builds the rootfs with Claude Code and Codex
   ([guide](guides/agents.md)). `workbox rootfs list` shows installed ones with their digests.
4. `workbox runtime install` installs Node 22 and the in-box packages (`--node-version v`,
   `--tarball file` for an offline install). `workbox runtime list` shows them.

## Run the server

```sh
WORKBOX_TOKEN=$(openssl rand -hex 24) workbox serve --host 127.0.0.1 --port 8790
```

- `workbox serve [--config file] [--port n] [--host h] [--tls-cert f --tls-key f]` serves the
  REST and WebSocket API on the local engine until SIGTERM or SIGINT, then closes gracefully. The
  address comes from the flags, then `WORKBOX_PORT`, then the config file, then `127.0.0.1:8790`.
- With a certificate and key it serves HTTPS and WSS, and the startup line shows an `https://`
  address. Listening on an address other than loopback without TLS prints a warning on stderr.
- Keys come from the config file and the environment. `WORKBOX_TOKEN` defines one key with every
  scope; otherwise `WORKBOX_API_KEYS` may hold a JSON array of keys.
- The config file holds `keys` (each `{"id", "tokenSha256", "scopes"}`), `host`, `port`,
  `serverNames` and `tls` (`{"certFile", "keyFile"}`). Scopes are `read`, `exec`, `admin` and
  `answer`. Unknown keys, bad types and unusable keys refuse to start. `serverNames` lists the
  `Host` names accepted besides `localhost`, `127.0.0.1` and `::1`; add the public name clients
  use. See [Configuration](reference/configuration.md#serve-config-file).
- To rotate a key: add the new key, restart, move clients over, remove the old key, restart.
- `deploy/workbox.service` runs `serve` under systemd with `EnvironmentFile=-/etc/workbox/workbox.env`.
- A client address that fails authentication 20 times within 60 s gets 429 `E_LIMIT` with
  `Retry-After` on every request until those 60 s are over. Behind a reverse proxy every client
  shares the proxy's address.

Drive sandboxes through the server (`--server http://127.0.0.1:8790 --token ...`, the SDK or MCP).
One engine drives a Workbox root at a time: `serve` and the local `workbox sandbox` and `workbox
shell` commands hold `<root>/.engine.lock` while they run, so a local sandbox command next to a
running server exits 4 (`E_BUSY`) and names the holder instead of attaching to the server's
sandboxes. `doctor`, `rootfs`, `runtime` and `audit` take no lock. A holder that died leaves a lock
the next engine breaks. The engine driving a sandbox runs its proxy and slirp4netns, so an
`egress` or `allowlist` sandbox has outside network while an engine drives it: a local
`workbox sandbox create` without `--server` exits right after the sandbox is ready, and the box
is offline until the next engine reconciles it (see
[the stated limits](security.md#stated-limits)).

### Reload the TLS certificate

Send `workbox serve` a SIGHUP after replacing the certificate or key files. It reads both files
again and presents the new certificate on new connections; open connections keep the old one.
If a file is missing or the pair is unusable, it writes the error to stderr and keeps serving the
old certificate. A server without TLS does not handle SIGHUP, so the signal stops it.

Under systemd, signal only the main process, not the helper processes that share its unit:

```sh
systemctl kill --kill-whom=main --signal=HUP workbox
```

An ACME client can run that command as its renewal hook (for certbot, `--deploy-hook`).

## Configuration

`loadConfig` (`packages/core/src/config.js`) applies defaults, then the JSON file named by
`WORKBOX_CONFIG`, then the environment: `WORKBOX_ROOT`, `WORKBOX_SECRETS_FILE`,
`WORKBOX_UID_BASE`, `WORKBOX_UID_COUNT`, `WORKBOX_CGROUP_ROOT`, `WORKBOX_CGROUP_PARENT`,
`WORKBOX_NETWORK_MODE`, `WORKBOX_ROOTFS`, `WORKBOX_RUNTIME`. Unknown keys and out-of-range values
fail closed with a coded error. Defaults: limits of 2 GiB memory, no swap, 2000 millicores and
4096 pids; network mode `egress`; rootfs `minimal`; runtime `current`; spool 8 MiB; stop grace
5 s; lease TTL 300 s; boot timeout 20 s.

Secrets live in `/etc/workbox/secrets.json` (`{"REF": "value"}`, must not be group or world
readable) or in `WORKBOX_SECRET_<REF>` variables of the daemon. They are read when the engine
starts, so restart `workbox serve` after a change. Values shorter than 8 characters are refused.
Grant references to a sandbox at create time with `secretRefs`.

## Observe

- `GET /metrics` (read scope): `workbox_http_requests_total{route,method,status}`,
  `workbox_ws_connections_total`, `workbox_ws_dropped_total`, `workbox_sandboxes{state}`.
- `GET /healthz` is liveness; `GET /readyz` fails with 503 while the server shuts down.
- Logs are structured JSON lines with a component tag; registered secret values are redacted.
- First debugging steps: `workbox sandbox inspect <id>` (desired state, `stateReason`, health,
  `lastObservedAt`, sessions), `workbox sandbox events <id>` (events; locally also the state
  transitions), and `wb status` inside the box. `wb net policy` shows the effective network
  mode; `wb net test <host> <port>` probes a target. Proxy decisions are in the audit log as `net.allow` and `net.deny`.

## Reconcile after a restart

Sandboxes are detached from the daemon and keep running when it stops. `workbox serve`
reconciles at start, the local CLI before every `sandbox` and `shell` command, and
`POST /v1/reconcile` (admin) on demand. The result lists `attached`, `absent`, `suspect` and
`quarantined` ids:

- `attached`: processes are still in the cgroup; the control channel is reconnected, the
  sessions are listed from the runner and the sandbox's network is back.
- `suspect`: the sandbox is alive but not whole: its control channel did not reconnect, or its
  network could not be restored.
- `absent`: the cgroup is empty. The sandbox is observed `ABSENT` and never relaunched; destroy it.
- `quarantined`: the runner did not prove the same boot (wrong boot id or nonce replay).

Reconcile restores the network of every `egress` and `allowlist` sandbox it attaches: the proxy
listens again on the address and port the sandbox's sessions were given, a new slirp4netns
attaches to its namespace (unless the old one still runs), and the ruleset is reinstalled. Both
come from `net.json` in the sandbox's directory, which the daemon writes at launch and which
keeps the box on the policy it was launched with even if the config changed. Health is `HEALTHY` only while the control channel is up and,
for `egress` and `allowlist`, while the proxy listens and the sandbox's tap device exists, so a
sandbox whose slirp4netns died turns `SUSPECT` at the next health poll.

## Quarantine and stuck boots

- A sandbox stuck in `PROVISIONING` or `BOOTSTRAPPING`, or `QUARANTINED` after a launch failure:
  read `<root>/sandboxes/<id>/launch.log` (rotated to `launch.log.1` past 1 MiB) and the
  `stateReason` from `workbox sandbox inspect <id>`. Re-run `workbox doctor`.
- `QUARANTINED` is never retried automatically. Inspect it, then destroy it.

## Recover from a failed destroy

A destroy that cannot confirm absence leaves the row in `DELETING` with
`destroy incomplete: <reason>` in `stateReason`, and the API returns the error.

1. `workbox sandbox inspect <id>` and read `stateReason`.
2. If the cgroup would not empty, list what is left in
   `/sys/fs/cgroup/workbox/<id>/cgroup.procs` and find why those processes survive
   `cgroup.kill` (for example a process stuck in uninterruptible sleep).
3. If host mounts still reference the sandbox, find them in `/proc/self/mountinfo` under
   `<root>/sandboxes/<id>` and unmount them.
4. Run `workbox sandbox rm <id>` again. Destroy resumes from `DELETING` and records `DELETED` only
   once the cgroup is gone, the directories are removed and no mount references them.

## Back up and restore

The durable state is the store, the audit log, the artifact store and the checkpoints:
`<root>/workbox.db` with its `-wal` and `-shm` files, `<root>/audit/`, `<root>/artifacts/` and
`<root>/checkpoints/`. Rootfs and runtime directories can be rebuilt from their recipes.

1. Stop `workbox serve` and make sure no other `workbox` process is running, so nothing writes
   the store or the audit log. Running sandboxes are not affected.
2. Copy the files above together, keeping the `-wal` file with the database.
3. Run `workbox audit verify` on the copy (`WORKBOX_ROOT=<copy>`). It prints `{ok, entries,
brokenAt}`; check `ok`, because the command exits 0 either way.

To restore, put the copy in an empty Workbox root, run `workbox audit verify`, then start
`workbox serve`. Its reconcile marks every sandbox that is not running on this host `ABSENT`;
destroy those rows and recreate what is needed with `fromCheckpoint`. There is no HA in v1.

## Remove the proxy link

The proxies' dummy link `workbox0` (198.18.0.1/32) stays on the host after the last sandbox is
destroyed. Remove it with `ip link del workbox0` when no sandbox with networking is running; the
next sandbox recreates it.
