# Agent guide

Instructions for coding agents working in this repository. People should start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## What this is

Workbox is a sandbox for AI agents whose primary interface is the shell: bubblewrap inside a
range-mapped user namespace, cgroup v2 limits, a private overlay over a shared read-only rootfs,
and REST/WebSocket, SDK, MCP and CLI interfaces on top. Plain JavaScript, Node 22 ESM, JSDoc for
types, `node --test`. No TypeScript, no bundler, no build step.

## Layout

| Path                | Holds                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `packages/protocol` | NDJSON peer, envelopes, validator, method catalogue (no runtime deps) |
| `packages/core`     | Sandbox engine: launch chain, cgroups, rootfs, runtime, store, broker |
| `packages/runner`   | In-box supervisor (no runtime deps)                                   |
| `packages/wb`       | The in-box `wb` command (no runtime deps)                             |
| `packages/server`   | REST and WebSocket server                                             |
| `packages/sdk`      | `@workbox/sdk`                                                        |
| `packages/mcp`      | `workbox-mcp`, four sandbox tools                                     |
| `packages/cli`      | The `workbox` operator CLI                                            |
| `rootfs/`           | Root filesystem Dockerfiles                                           |
| `deploy/`           | `install.sh`, the systemd unit, the server image, `check.sh`          |
| `docs/`             | User and operator documentation; `wb.md` is generated                 |
| `spec/`             | Design spec and task list                                             |
| `test/e2e/`         | End-to-end tests through the SDK against a real server                |

## Commands

Run `make help` for the full list. The main ones:

```sh
pnpm install --frozen-lockfile
make check               # lint, format check, test layout, docs check
make unit-unprivileged   # unit tests that run as an ordinary user
make unit                # every unit test; some need root
make test                # unit, integration and e2e; needs a prepared Linux host
bash deploy/check.sh     # deployment assets and host doctor
```

Integration and e2e tests start real sandboxes. They need root, bubblewrap, cgroup v2 with the
controllers delegated, and Docker for rootfs builds. Run them only on a host prepared with
`sh deploy/install.sh`.

## Rules

- Tests exercise real code on real host primitives. Do not add fakes, mocks or stubs to make a
  test pass.
- Every module `packages/<p>/src/<path>.js` has a unit test at
  `packages/<p>/test/unit/<path>.test.js`; `node scripts/check-tests.mjs` enforces it. Coverage
  floors are 90% lines, 80% branches and 90% functions.
- Keep protocol, runner and wb free of runtime dependencies: they run inside the box from the
  mounted runtime.
- ESLint and Prettier must pass. JSDoc on every export. Errors carry stable codes; no silent
  catches.
- Follow the existing style, and keep each change to one purpose.
- After changing the `wb` command table, run `node docs/gen-wb.mjs`.
- Code that sets up sandbox networking must never touch the host's network namespace or its
  firewall. See [docs/security.md](docs/security.md#the-host-namespace-guard).
- Commit messages describe the change in a plain sentence. Do not use `--no-verify`.
