# Workbox

A sandbox for AI agents whose primary interface is the shell.

Each sandbox is a namespaced, capability-limited, cgroup-bounded process tree on a private
writable overlay of a shared read-only rootfs, launched with bubblewrap inside a range-mapped user
namespace. Inside it run a small supervisor (the runner) and the `wb` toolkit, so an agent
discovers everything it can do through commands and `--help` rather than fixed tool schemas. The
host exposes lifecycle and exec over REST and WebSocket, a JavaScript SDK, an MCP server and an
operator CLI. It runs on a single Linux host with cgroup v2; Docker is needed only to build the
rootfs.

## Quick start

As root, from a checkout with `pnpm install` done (`workbox` is `packages/cli/src/main.js`):

```sh
alias workbox='node packages/cli/src/main.js'
sh deploy/install.sh
workbox doctor
workbox rootfs build minimal
workbox runtime install
export WORKBOX_TOKEN=$(openssl rand -hex 24)
workbox serve &
S='--server http://127.0.0.1:8790'
workbox sandbox create --name demo $S          # prints the sandbox; note its id
workbox sandbox exec <id> $S -- sh -c 'wb status; wb run -- echo hello'
workbox sandbox rm <id> $S
```

Sandbox commands go through the server so that it, not the short-lived CLI process, owns each
sandbox's network proxy. Inside the box, `wb tools` lists every agent subcommand; see the
[wb reference](docs/wb.md).

## Surfaces

- Operator CLI `workbox`: doctor, rootfs, runtime, sandbox, shell, serve, audit verify; local
  engine or `--server URL --token T`.
- REST and WebSocket: `workbox serve`, scoped bearer keys, `GET /metrics`, `/healthz`, `/readyz`.
- SDK: `@workbox/sdk` (`WorkboxClient`, `Sandbox`).
- MCP (stdio, `workbox-mcp`): exactly `sandbox_create`, `sandbox_list`, `sandbox_exec`,
  `sandbox_destroy`.

## Documentation

Start at the [documentation index](docs/README.md).

- [Why Workbox?](docs/why-workbox.md)
- [Project status and compatibility](docs/project-status.md)
- [Getting started](docs/guides/getting-started.md) and the [guides](docs/guides/README.md)
- [Architecture](docs/architecture.md)
- [Security model and its limits](docs/security.md)
- [Operations](docs/operations.md)
- [Reference](docs/reference/README.md): [CLI](docs/reference/cli.md), [REST and WebSocket API](docs/reference/rest-api.md), [configuration](docs/reference/configuration.md), [wb reference (generated)](docs/wb.md)
- [Hyperfide provider mapping](docs/hyperfide-provider.md)
- [Verification](docs/verification.md)
- [Measurements](docs/measurements.md)
- [FAQ](docs/faq.md)

Scope, decisions and acceptance criteria are in [`spec/workbox/spec.kvx`](spec/workbox/spec.kvx).

## Project status

Version `0.1.0-dev`: implemented and covered by the local gates, not a production release. It
supports one Linux host with cgroup v2, driven by a root daemon, with no HA and no TLS. The full
matrix and the known limits are in [project status](docs/project-status.md).

## Security

Sandboxes share the host kernel and are isolated by namespaces, cgroup v2 limits, dropped
capabilities and a seccomp filter; this is not a hypervisor boundary. What is enforced and what is
not is in [the security model](docs/security.md).

## Development gates

```sh
node scripts/check-tests.mjs   # 1:1 src -> unit test mapping, integration and e2e presence
pnpm lint
pnpm fmt:check
pnpm test                      # unit, integration and e2e; integration needs a capable host
pnpm test:coverage             # lines 90, branches 80, functions 90
node docs/check.mjs            # docs/wb.md current, every doc link and anchor resolves, every page indexed
bash deploy/check.sh
```

`node docs/gen-wb.mjs` regenerates `docs/wb.md` after a change to the wb command table.
