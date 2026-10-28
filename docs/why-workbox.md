# Why Workbox?

Workbox gives an AI agent a persistent, isolated Linux environment that it controls entirely
through commands.

## The idea

Most agent sandboxes expose a fixed set of tool schemas. Workbox exposes a shell. Inside each
sandbox runs a small supervisor (the runner) and the `wb` toolkit, so the agent discovers what it
can do with `wb tools` and `--help` instead of being handed a schema per capability. What the box
cannot do alone, `wb` asks the host to do: raise a question to a human, inject a brokered secret
into a child process, record evidence for a command, create a checkpoint, store an artifact, or
read the network policy. See the [wb reference](wb.md).

The host side stays small. Lifecycle and exec are the only operations a harness needs, and the MCP
server mirrors exactly those: `sandbox_create`, `sandbox_list`, `sandbox_exec`, `sandbox_destroy`.

## What each sandbox is

A namespaced, capability-limited, cgroup-bounded process tree on a private writable overlay of a
shared read-only rootfs, launched with bubblewrap inside a range-mapped user namespace. Isolation
is built from Linux primitives on one host; no hypervisor and no container runtime are needed to
run sandboxes. Docker is used only to build the base rootfs. The details and their limits are in
the [security model](security.md) and the [architecture](architecture.md).

## What it is not

- Not a multi-host scheduler. It runs on one Linux host with cgroup v2 and has no HA, live
  migration or TLS in v1.
- Not a hypervisor boundary. Sandboxes share the host kernel; the [stated
  limits](security.md#stated-limits) list what that means.
- Not a model runtime. It runs the commands an agent issues; it does not call models.
- Not a framework. The packages are plain JavaScript (Node 22.13 or later, ESM, JSDoc types); there
  is no build step.

## Where it fits

Workbox is shaped to the operations Hyperfide's sandbox provider contract expects. It ships no
Hyperfide adapter; the [provider mapping](hyperfide-provider.md) says which endpoint covers each
operation and where it falls short. It is usable on its own through the
[operator CLI](reference/cli.md), the [REST and WebSocket API](reference/rest-api.md), the
[SDK](guides/sdk.md) or the [MCP server](guides/mcp.md).
