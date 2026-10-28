# Project status and compatibility

This page separates what is implemented from what is claimed about deployments. It is not a
certification statement. The version is `0.1.0-dev`; nothing here is a production release.

## Implementation status

| Surface                                                   | Status                   | Where to read more                                    |
| --------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| Sandbox isolation (bubblewrap, user namespace, cgroup v2) | Implemented              | [Security model](security.md#process-isolation)       |
| Seccomp filter                                            | Implemented, x86_64 only | [Stated limits](security.md#stated-limits)            |
| Network modes `none`, `egress`, `allowlist`               | Implemented              | [Security model](security.md#network)                 |
| Runner with durable sessions                              | Implemented              | [Architecture](architecture.md#runner-protocol)       |
| `wb` toolkit                                              | Implemented              | [wb reference](wb.md)                                 |
| REST and WebSocket server                                 | Implemented              | [REST API](reference/rest-api.md)                     |
| SDK (`@workbox/sdk`)                                      | Implemented              | [SDK guide](guides/sdk.md)                            |
| MCP server (`workbox-mcp`)                                | Implemented              | [MCP guide](guides/mcp.md)                            |
| Operator CLI (`workbox`)                                  | Implemented              | [CLI reference](reference/cli.md)                     |
| Reconcile after a restart                                 | Implemented              | [Operations](operations.md#reconcile-after-a-restart) |
| Hash-chained audit log with `workbox audit verify`        | Implemented              | [Security model](security.md#audit)                   |
| Hyperfide provider adapter                                | Not shipped              | [Provider mapping](hyperfide-provider.md)             |
| TLS, high availability, live migration                    | Not in v1                | [Stated limits](security.md#stated-limits)            |

Scope, decisions and acceptance criteria are recorded in [`spec/workbox/spec.kvx`](../spec/workbox/spec.kvx).

## Supported host

| Requirement  | Value                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------- |
| OS           | Linux with cgroup v2 and user namespaces; the daemon runs as root                             |
| Node         | 22.13 or later (`engines` in the root `package.json`)                                         |
| Package tool | pnpm (`packageManager` is `pnpm@12.8.1`)                                                      |
| Docker       | Only to build a rootfs (`workbox rootfs build`)                                               |
| CPU          | x86_64 for the seccomp filter; other architectures run sandboxes without seccomp              |
| Host tools   | bubblewrap, util-linux, slirp4netns, nftables, uidmap, iproute2; `workbox doctor` checks them |

macOS and Windows are not supported hosts. `workbox doctor` is the authority for a given machine:
it reports every prerequisite as pass or fail with a remedy.

## Known limits

The complete list, with the reasoning for each, is [Stated limits](security.md#stated-limits). The
ones that most often decide adoption:

- All sandboxes share one subordinate uid range, so separation on the host rests on per-sandbox
  directories and mount namespaces, not on uids.
- Hostname allowlists bind only proxy-aware clients.
- Sandboxes share the host kernel.
- One engine drives a Workbox root at a time.
- Events are paged by polling; only session output is streamed.
