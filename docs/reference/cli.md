# Operator CLI

`workbox` is the `bin` of `@workbox/cli` (`packages/cli/src/main.js`); from a checkout run
`node packages/cli/src/main.js`. `workbox --help` prints the text this page mirrors; `workbox
--version` (or `workbox version`) prints `workbox <version>`.

Sandbox commands use the local engine by default, or a remote server with `--server URL --token T`
(the token defaults to `WORKBOX_TOKEN`). `--server` and `--token` may appear anywhere before a
`--`. Results are printed as JSON (indented; compact with `--json`), except `doctor`, which prints
a report.

| Command                                                                                                                                              | What it does                                                                                                                                      | Local only |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `workbox doctor [--json]`                                                                                                                            | Check every host prerequisite, with a remedy for each failure. Always checks the local host.                                                      | yes        |
| `workbox rootfs build [name]`                                                                                                                        | Build a rootfs (default `minimal`); needs Docker.                                                                                                 | yes        |
| `workbox rootfs list`                                                                                                                                | List installed rootfs with their digests.                                                                                                         | yes        |
| `workbox runtime install [--node-version v] [--tarball f]`                                                                                           | Install the Node runtime and in-box packages; `--tarball` installs offline.                                                                       | yes        |
| `workbox runtime list`                                                                                                                               | List installed runtimes.                                                                                                                          | yes        |
| `workbox sandbox create [--name n] [--rootfs r] [--runtime r] [--network mode] [--idempotency-key k]`                                                | Create a sandbox and print its row. `--network` is `none`, `egress` or `allowlist`.                                                               | no         |
| `workbox sandbox ls`                                                                                                                                 | List sandboxes (`list` also works).                                                                                                               | no         |
| `workbox sandbox inspect <id>`                                                                                                                       | Desired state, `stateReason`, health, `lastObservedAt` and sessions.                                                                              | no         |
| `workbox sandbox exec <id> -- <cmd...>`                                                                                                              | Run a command to completion.                                                                                                                      | no         |
| `workbox sandbox shell <id>` or `workbox shell <id>`                                                                                                 | Interactive PTY shell (`/bin/bash -l`), locally or through `--server`. Without a terminal on stdin, the session starts detached and is described. | no         |
| `workbox sandbox attach <id> <sessionId>`                                                                                                            | Replay a session from its start and follow it to its exit.                                                                                        | no         |
| `workbox sandbox run <id> [--name n] [--wait] -- <cmd...>`                                                                                           | Start a background session (no PTY) and print `{sessionId}`. With `--wait`, wait for it, print its output and exit with its code.                 | no         |
| `workbox sandbox logs <id> <sessionId>`                                                                                                              | Print a session's retained output: stderr to stderr, the rest to stdout.                                                                          | no         |
| `workbox sandbox wait <id> <sessionId> [--timeout ms]`                                                                                               | Wait for a session to exit, print `{sessionId, exited, exitCode}` and exit with its code; past `--timeout`, exit 5.                               | no         |
| `workbox sandbox kill <id> <sessionId> [--signal NAME]`                                                                                              | Signal a session's process group (default `SIGTERM`; `KILL` and `SIGKILL` both work).                                                             | no         |
| `workbox sandbox cp <src> <dest>`                                                                                                                    | Copy one file into or out of a sandbox, of any size; one side is `<id>:<path>`. See below.                                                        | no         |
| `workbox sandbox drain <id>`                                                                                                                         | Move the sandbox to DRAINING: stop new work; processes keep running until destroy.                                                                | no         |
| `workbox sandbox rm <id>`                                                                                                                            | Destroy the sandbox (`destroy` also works).                                                                                                       | no         |
| `workbox sandbox events <id>`                                                                                                                        | Events; locally also the state transitions.                                                                                                       | no         |
| `workbox events [--sandbox id] [--type t]... [--after seq] [--follow]`                                                                               | Events of every sandbox, one JSON object per line. `--follow` prints new ones as they are logged until SIGINT or SIGTERM.                         | no         |
| `workbox agent <claude\|codex> [<sandbox-id>] [-p TEXT] [--name n] [--network mode] [--allow h]... [--secret REF[=ENV]]... [--no-secret] [--detach]` | Run Claude Code or Codex in a sandbox of the `agents` rootfs: interactive, one task with `-p`, or detached. See [the guide](../guides/agents.md). | no         |
| `workbox key create --name n --scope s [--scope s]... [--label k=v]... [--sandbox id]... [--ttl 30d\|12h\|3600s]`                                    | Mint a stored API key and print it with its token, which is shown only this once. `--label` and `--sandbox` bind it; `--ttl` makes it expire.     | no         |
| `workbox key ls`                                                                                                                                     | List stored keys (`list` also works), without tokens.                                                                                             | no         |
| `workbox key rm <keyId>`                                                                                                                             | Revoke a stored key (`revoke` also works); it stops working on the next request.                                                                  | no         |
| `workbox webhook add <url> [--type t]... [--sandbox id] [--label k=v]... [--description d]`                                                          | Register a webhook and print it with its signing secret, which is shown only this once. Without `--type` it gets every event.                     | no         |
| `workbox webhook ls`                                                                                                                                 | List webhooks (`list` also works), without secrets.                                                                                               | no         |
| `workbox webhook rm <webhookId>`                                                                                                                     | Delete a webhook and its deliveries (`delete` also works).                                                                                        | no         |
| `workbox webhook test <webhookId>`                                                                                                                   | Queue a `webhook.test` delivery.                                                                                                                  | no         |
| `workbox webhook rotate <webhookId>`                                                                                                                 | Replace the signing secret and print the new one, shown only this once.                                                                           | no         |
| `workbox webhook deliveries <webhookId> [--status s] [--limit n]`                                                                                    | List deliveries, newest first, with their attempts and last answer.                                                                               | no         |
| `workbox serve [--config file] [--port n] [--host h] [--tls-cert f --tls-key f]`                                                                     | Serve the REST and WebSocket API on the local engine until SIGTERM or SIGINT; HTTPS and WSS with a certificate.                                   | yes        |
| `workbox audit verify`                                                                                                                               | Verify the audit hash chain; prints `{ok, entries, brokenAt}`.                                                                                    | yes        |

`sandbox cp` streams the file in 4 MiB pieces. A sandbox path that ends in `/`, or a local
destination that is a directory, takes the source's file name. An upload keeps the local file's
permission bits; a download that fails leaves no partial file. A local path that contains `:`
before any `/` reads as a sandbox path: write it as `./name:x`.

`serve` takes no `--server`. The listen address comes from the flags, then `WORKBOX_PORT`, then the
config file, then `127.0.0.1:8790`; see [Configuration](configuration.md#serve-config-file). With
`--tls-cert` and `--tls-key` (or `tls` in the config file) it serves HTTPS and WSS, and SIGHUP
reloads the certificate. Listening on an address other than loopback without TLS prints a warning
on stderr.

`events` prints the stored events after `--after` (default 0) and exits. `--type` takes an exact
type or `prefix.*` and repeats; `--sandbox` keeps one sandbox. With `--follow` it prints the
stored events after `--after` when it is given, then each new event as it is logged. Locally it
follows through the engine, so it needs the root to itself, like `sandbox exec`; with `--server`
it streams over the events WebSocket and reconnects after a drop without losing or repeating an
event.

The `key` commands work on the local store, even while `workbox serve` runs on the same root, or
through `--server` with an unbound `admin` key. A running server sees a key minted or revoked
locally on its next request. What a bound key may see is described in
[the REST reference](rest-api.md#stored-keys-and-bound-access).

The `webhook` commands work the same way: on the local store, where the webhooks they add belong
to `cli`, or through `--server`, where they belong to the key used. `serve` delivers to every
webhook; a running server picks up a webhook or test delivery added locally within a few
seconds. See [the webhooks guide](../guides/webhooks.md).

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

`sandbox exec`, `shell`, `agent`, `sandbox attach`, `sandbox run --wait` and `sandbox wait` exit with the wrapped command's own non-zero exit code when it has one (128 plus the signal number for a session a signal ended).
`audit verify` exits 0 whether or not the chain verifies; read `ok`.
