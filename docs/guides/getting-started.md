# Getting started

This guide takes a Linux host from a fresh checkout to a command running in a sandbox.

## Prerequisites

- A Linux host with cgroup v2 and user namespaces, and root access. Sandboxes are launched by a
  root daemon; see [project status](../project-status.md#supported-host).
- Node 22.13 or later and pnpm.
- Docker, only to build the base rootfs.

## 1. Install dependencies

From the repository root:

```sh
pnpm install
alias workbox='node packages/cli/src/main.js'
```

`workbox` is the `bin` of `@workbox/cli`; the alias runs it from the checkout.

## 2. Prepare the host

As root:

```sh
sh deploy/install.sh
workbox doctor
```

`deploy/install.sh` is idempotent. It creates the Workbox root (`/var/lib/workbox`) and
`/etc/workbox`, adds the subordinate uid and gid range to `/etc/subuid` and `/etc/subgid`, and
creates the `workbox` cgroup parent. `--dry-run` prints every change it would make without making
any. `workbox doctor` reports every prerequisite as pass or fail with a remedy and exits 4 until the
host is ready. Fix every failure before going on. Both are described in
[Operations](../operations.md#install).

## 3. Build the rootfs and install the runtime

```sh
workbox rootfs build minimal
workbox runtime install
```

The first builds the shared read-only base rootfs (needs Docker). The second installs Node and the
in-box packages once on the host; each sandbox gets them bind-mounted read-only at `/opt/workbox`.

## 4. Serve

```sh
export WORKBOX_TOKEN=$(openssl rand -hex 24)
workbox serve &
```

`serve` listens on `127.0.0.1:8790` by default and treats `WORKBOX_TOKEN` as one key with every
scope. Drive sandboxes through the server: it, not a short-lived CLI process, owns each sandbox's
network proxy.

## 5. Run something

```sh
S='--server http://127.0.0.1:8790'
workbox sandbox create --name demo $S          # prints the sandbox row; note its id
workbox sandbox exec <id> $S -- sh -c 'wb status; wb run -- echo hello'
workbox sandbox rm <id> $S
```

`wb` is the command an agent uses inside the box. `wb tools` lists every subcommand and each one
takes `--help`; the full table is the [wb reference](../wb.md).

## Next

- [Use the SDK](sdk.md) or [the MCP server](mcp.md) to drive sandboxes from a program or an agent.
- [Deploy the server](deploy.md) to keep it running.
- [Operations](../operations.md) for configuration, observation and recovery.
