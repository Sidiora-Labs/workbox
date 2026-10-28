# Agent guide

Instructions for coding agents working in this repository. Humans should start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); the rules here are the same ones,
stated for an agent.

## What this is

Workbox is a sandbox for AI agents whose primary interface is the shell: bubblewrap inside a
range-mapped user namespace, cgroup v2 limits, a private overlay over a shared read-only rootfs,
and REST/WebSocket, SDK, MCP and CLI surfaces on top. Plain JavaScript, Node 22 ESM, JSDoc for
types, `node --test`. No TypeScript, no bundler, no transpile step.

## Layout

| Path                | Holds                                                                 |
| ------------------- | --------------------------------------------------------------------- |
| `packages/protocol` | NDJSON peer, envelopes, validator, method catalogue (no runtime deps) |
| `packages/core`     | Sandbox engine: launch chain, cgroups, rootfs, runtime, store, broker |
| `packages/runner`   | In-box supervisor (no runtime deps)                                   |
| `packages/wb`       | The in-box `wb` toolkit (no runtime deps)                             |
| `packages/server`   | REST and WebSocket server                                             |
| `packages/sdk`      | `@workbox/sdk`                                                        |
| `packages/mcp`      | `workbox-mcp`, exactly four tools                                     |
| `packages/cli`      | The `workbox` operator CLI                                            |
| `rootfs/`           | Base rootfs build inputs                                              |
| `deploy/`           | `install.sh`, the systemd unit, the server image, `check.sh`          |
| `docs/`             | Architecture, security, operations, measurements, generated `wb.md`   |
| `spec/`             | `spec/workflow.kvx` and the feature spec `spec/workbox/spec.kvx`      |
| `test/e2e/`         | End-to-end flows through the SDK against a real server                |

`spec/workflow.kvx` is the source of truth for how work is done here, and `spec/workbox/spec.kvx`
for what is built: requirements, decisions, and the task list in dependency waves.

## Commands

Run `make help` for the full list. The ones that matter:

```sh
pnpm install --frozen-lockfile
make check               # lint, fmt-check, check-tests, docs-check
make unit-unprivileged   # the unit tests that run as an ordinary user
make unit                # every unit test; some need root
make test                # pnpm test: unit, integration and e2e; needs a capable Linux host
bash deploy/check.sh     # deployment assets and host doctor
```

Integration and e2e tests launch real sandboxes. They need root, bubblewrap, cgroup v2 with the
controllers delegated, and, for rootfs builds, Docker. Run them only on a host prepared with
`sh deploy/install.sh`.

## Rules

- Tests run real code paths on real host primitives. Do not add fakes, mocks or stubs to make a
  test pass; a green test driven by a fake is not done.
- Every module `packages/<p>/src/<path>.js` has a unit test at
  `packages/<p>/test/unit/<path>.test.js`. `node scripts/check-tests.mjs` enforces the mapping.
  Coverage floors are lines 90, branches 80, functions 90.
- Keep protocol, runner and wb free of runtime dependencies: they run inside the box from the
  mounted runtime.
- Eslint strict rules and prettier must pass. JSDoc on every export. Errors carry stable codes; no
  silent catches.
- Follow the existing style. Add no comments or documentation beyond what the change needs.
- After changing the `wb` command table, run `node docs/gen-wb.mjs`; `node docs/check.mjs` fails
  on a stale `docs/wb.md` or a broken link.
- Keep to the task. No neighbouring fixes, speculative refactors or cleanup in the same change.
- Never mark work done that did not meet its acceptance criteria; report an honest partial.
- Code that creates network namespaces or nftables rules must not touch the host's network
  namespace or its firewall. See [docs/security.md](docs/security.md).
- Commit messages describe the real change and the gate that passed. Do not use `--no-verify`.
