<div align="center">

# Workbox

<img src="https://supabase.paxeer.app/storage/v1/object/public/json/Untitled%20design.png">


**A sandbox for AI agents whose primary interface is the shell..**


[![badge](https://shieldcn.dev/github/Sidiora-Labs/workbox/license.svg?variant=outline&size=lg&font=geist&logo=github&logoColor=dadee6&height=56&padX=15&iconSize=21&gap=4&labelGap=12)](https://github.com/Sidiora-Labs/hyperfide)
[![badge](https://shieldcn.dev/badge/JAVASCRIPT.svg?variant=outline&size=lg&font=geist&logo=javascript&logoColor=F0DB4F&labelTextColor=1c3e76&height=56&padX=15&iconSize=28&gap=4&labelGap=12)](#)
[![badge](https://shieldcn.dev/badge/SIDIORA%20LABS.svg?variant=outline&size=lg&font=geist&logo=lu%3AGlobe&logoColor=0043e6&labelTextColor=1c3e76&height=56&padX=15&iconSize=21&gap=4&labelGap=12)](https://github.com/org/Sidiora-Labs)
[![badge](https://shieldcn.dev/github/Sidiora-Labs/workbox/ci.svg?variant=outline&size=lg&font=geist&logo=github&logoColor=dadee6&height=56&padX=15&iconSize=21&gap=4&labelGap=12)](https://github.com/Sidiora-Labs/workbox/actions)
</div>


Each sandbox is a Linux process tree isolated with namespaces, cgroup v2 limits, a reduced
capability set and a seccomp filter. It runs on its own writable overlay of a shared read-only
root filesystem. Inside it, a small supervisor (the runner) and the `wb` command let an agent
discover what it can do through `--help` instead of fixed tool schemas. On the host, Workbox
offers a REST and WebSocket API, a JavaScript SDK, an MCP server and an operator CLI.

Workbox runs on a single Linux host with cgroup v2. Docker is needed only to build the root
filesystem.

## Quick start

As root, from a checkout with `pnpm install` done:

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

Run sandbox commands through the server: it keeps each sandbox's network proxy running, which a
short-lived CLI process cannot. Inside a sandbox, `wb tools` lists every command; see the
[wb reference](docs/wb.md).

## Interfaces

- Operator CLI `workbox`: doctor, rootfs, runtime, sandbox, shell, agent, serve, audit verify. It works
  on the local host or against a server with `--server URL --token T`.
- REST and WebSocket API: `workbox serve`, with scoped bearer keys, `GET /metrics`, `/healthz`
  and `/readyz`.
- SDK: `@workbox/sdk` (`WorkboxClient`, `Sandbox`).
- MCP server (stdio, `workbox-mcp`): `sandbox_create`, `sandbox_list`, `sandbox_exec` and
  `sandbox_destroy`, plus `agent_run` and `agent_output` to hand a task to a coding agent in a
  sandbox.

## Coding agents

Claude Code and Codex come preinstalled in the `agents` rootfs:

```sh
workbox rootfs build agents
workbox agent claude $S                          # interactive
workbox agent codex -p "Add a test for parse()" $S
```

The agent gets its API key from the host's secrets file and, by default, can reach only its API,
GitHub and the package registries. See [Run coding agents in a sandbox](docs/guides/agents.md).

## Documentation

Start at the [documentation index](docs/README.md).

- [Why Workbox?](docs/why-workbox.md)
- [Project status](docs/project-status.md)
- [Getting started](docs/guides/getting-started.md) and the other [guides](docs/guides/README.md)
- [Run coding agents in a sandbox](docs/guides/agents.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Operations](docs/operations.md)
- [Reference](docs/reference/README.md): [CLI](docs/reference/cli.md), [REST and WebSocket API](docs/reference/rest-api.md), [configuration](docs/reference/configuration.md), [wb](docs/wb.md)
- [Hyperfide provider mapping](docs/hyperfide-provider.md)
- [Testing](docs/verification.md)
- [Measurements](docs/measurements.md)
- [FAQ](docs/faq.md)

## Project status

Workbox is pre-release (`0.1.0-alpha.1`). It supports one Linux host with cgroup v2 and a root
daemon; there is no high availability. The API is served over TLS when the server is given a
certificate. See [project status](docs/project-status.md).

## Security

Sandboxes share the host kernel. They are isolated by namespaces, cgroup v2 limits, dropped
capabilities and a seccomp filter, not by a hypervisor. The [security model](docs/security.md)
describes what is enforced and its limits. To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Development

```sh
make check                     # lint, format check, test layout, docs check
make unit-unprivileged         # unit tests that run without root
pnpm test                      # unit, integration and e2e; needs a prepared host
pnpm test:coverage             # lines 90, branches 80, functions 90
bash deploy/check.sh           # deployment assets and host doctor
```

After changing the `wb` command table, run `node docs/gen-wb.mjs` to regenerate `docs/wb.md`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md) and the
[changelog](CHANGELOG.md).

## License

Workbox is licensed under the [Apache License, Version 2.0](LICENSE).
