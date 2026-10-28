# Workbox

A production sandbox for AI agents whose primary interface is the shell.

Each sandbox is a namespaced, capability-limited, cgroup-bounded process tree on a private writable overlay of a shared read-only rootfs. Inside it runs a small supervisor and the `wb` toolkit, so an agent discovers and uses everything through commands and `--help` rather than through fixed tool schemas. The host exposes lifecycle and exec over REST, WebSocket, a JS SDK, an MCP server and an operator CLI.

## Quick start

```sh
sudo sh deploy/install.sh
workbox doctor
workbox rootfs build minimal
workbox runtime install
WORKBOX_TOKEN=$(openssl rand -hex 24) workbox serve --port 8790
# second shell:
workbox sandbox create --name demo
workbox sandbox exec <id> -- sh -c 'wb status; wb preset install python; wb run -- python3 -c "print(1+1)"'
workbox sandbox rm <id>
```

Inside the box, `wb tools` lists every agent subcommand; each accepts `--help` and `--json`. See [docs/wb.md](docs/wb.md).

## Surfaces

- Operator CLI: `workbox` (local engine or `--server URL --token T`)
- REST/WebSocket: `workbox serve`; scoped Bearer keys; `GET /metrics`, `/healthz`, `/readyz`
- SDK: `@workbox/sdk` (`WorkboxClient`, `Sandbox`)
- MCP (stdio): exactly `sandbox_create`, `sandbox_list`, `sandbox_exec`, `sandbox_destroy`

## Documentation

- [Architecture](docs/architecture.md)
- [Security model and limits](docs/security.md)
- [wb reference (generated)](docs/wb.md)
- [Hyperfide provider mapping](docs/hyperfide-provider.md)
- [Operations runbook](docs/operations.md)
- [Measurements](docs/measurements.md)

The single source of truth for scope and acceptance criteria is [`spec/workbox/spec.kvx`](spec/workbox/spec.kvx).

## Development gates

```sh
node scripts/check-tests.mjs   # 1:1 src→unit mapping, integration/e2e presence
pnpm lint
pnpm fmt:check
pnpm test                      # unit + integration + e2e (integration needs a capable host)
node docs/check.mjs
bash deploy/check.sh
```
