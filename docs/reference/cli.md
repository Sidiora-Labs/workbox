# Operator CLI

`workbox` is the `bin` of `@workbox/cli` (`packages/cli/src/main.js`); from a checkout run
`node packages/cli/src/main.js`. `workbox --help` prints the text this page mirrors; `workbox
--version` (or `workbox version`) prints `workbox <version>`.

Sandbox commands use the local engine by default, or a remote server with `--server URL --token T`
(the token defaults to `WORKBOX_TOKEN`). `--server` and `--token` may appear anywhere before a
`--`. Results are printed as JSON (indented; compact with `--json`), except `doctor`, which prints
a report.

| Command                                                                                               | What it does                                                                                                                                      | Local only |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `workbox doctor [--json]`                                                                             | Check every host prerequisite, with a remedy for each failure. Always checks the local host.                                                      | yes        |
| `workbox rootfs build [name]`                                                                         | Build a rootfs (default `minimal`); needs Docker.                                                                                                 | yes        |
| `workbox rootfs list`                                                                                 | List installed rootfs with their digests.                                                                                                         | yes        |
| `workbox runtime install [--node-version v] [--tarball f]`                                            | Install the Node runtime and in-box packages; `--tarball` installs offline.                                                                       | yes        |
| `workbox runtime list`                                                                                | List installed runtimes.                                                                                                                          | yes        |
| `workbox sandbox create [--name n] [--rootfs r] [--runtime r] [--network mode] [--idempotency-key k]` | Create a sandbox and print its row. `--network` is `none`, `egress` or `allowlist`.                                                               | no         |
| `workbox sandbox ls`                                                                                  | List sandboxes (`list` also works).                                                                                                               | no         |
| `workbox sandbox inspect <id>`                                                                        | Desired state, `stateReason`, health, `lastObservedAt` and sessions.                                                                              | no         |
| `workbox sandbox exec <id> -- <cmd...>`                                                               | Run a command to completion.                                                                                                                      | no         |
| `workbox sandbox shell <id>` or `workbox shell <id>`                                                  | Interactive PTY shell (`/bin/bash -l`), locally or through `--server`. Without a terminal on stdin, the session starts detached and is described. | no         |
| `workbox sandbox drain <id>`                                                                          | Move the sandbox to DRAINING: stop new work; processes keep running until destroy.                                                                | no         |
| `workbox sandbox rm <id>`                                                                             | Destroy the sandbox (`destroy` also works).                                                                                                       | no         |
| `workbox sandbox events <id>`                                                                         | Events; locally also the state transitions.                                                                                                       | no         |
| `workbox serve [--config file] [--port n] [--host h]`                                                 | Serve the REST and WebSocket API on the local engine until SIGTERM or SIGINT.                                                                     | yes        |
| `workbox audit verify`                                                                                | Verify the audit hash chain; prints `{ok, entries, brokenAt}`.                                                                                    | yes        |

`serve` takes no `--server`. The listen address comes from the flags, then `WORKBOX_PORT`, then the
config file, then `127.0.0.1:8790`; see [Configuration](configuration.md#serve-config-file).

## One engine per root

`serve` and the local `sandbox` and `shell` commands hold `<root>/.engine.lock` while they run. A
local sandbox command beside a running server exits 4 and names the holder. `doctor`, `rootfs`,
`runtime` and `audit` take no lock. The local `sandbox` and `shell` commands reconcile before
running. See [Operations](../operations.md#run-the-server).

## Exit codes

| Exit | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | success                                                                |
| 1    | internal error                                                         |
| 2    | usage                                                                  |
| 3    | not found                                                              |
| 4    | denied, unavailable or busy; also `doctor` on a host that is not ready |
| 5    | timeout                                                                |

`sandbox exec` and `shell` exit with the wrapped command's own non-zero exit code when it has one.
`audit verify` exits 0 whether or not the chain verifies; read `ok`.
