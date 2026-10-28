# Changelog

All notable changes to Workbox are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Sandboxes built from bubblewrap, a range-mapped user namespace and cgroup v2 limits, on a
  private overlay of a shared read-only rootfs.
- Rootfs builds from a Dockerfile, with uid shifting and a content digest, and a checksummed Node
  runtime mounted read-only into every sandbox.
- The in-box runner with durable sessions, PTY sessions and output replay.
- The `wb` command for agents: status, sessions, evidence, asks, brokered secrets, events, leases,
  checkpoints, artifacts, network policy and toolchain presets.
- Network modes `none`, `egress` and `allowlist`, with a per-sandbox proxy and an nftables ruleset
  inside each sandbox.
- A seccomp filter on x86_64, a fixed capability set and `no_new_privs` for every sandbox process.
- A REST and WebSocket API with scoped keys, request schemas, Prometheus metrics and an audit log.
- The JavaScript SDK, the stdio MCP server and the `workbox` operator CLI.
- Reconcile after a daemon restart, including the network of `egress` and `allowlist` sandboxes.
- `workbox doctor`, an idempotent host installer, a systemd unit and a server container image.
- Interactive shells against a remote server with `workbox sandbox shell --server`.
- An `agents` rootfs with Claude Code and Codex set up to run unattended, `@anthropic` and
  `@openai` allowlist host sets, and SDK helpers for agent sandboxes and sessions.
- `workbox agent` to run Claude Code or Codex in a sandbox, interactively, for one task or
  detached, and `workbox sandbox attach` to follow a session.
- The MCP tools `agent_run` and `agent_output` to hand a task to an agent in a sandbox.

### Security

- Host-side deletes are confined to the Workbox root.
- Lease tokens are stored hashed, and the audit log is hash-chained with torn-line repair.
- Secret values are redacted from output, logs and the audit log, including encoded forms and
  values split across output chunks.
- The proxy checks every resolved address against blocked ranges and the host's own addresses.
- The API refuses browser-originated requests and unknown `Host` names.
- Network setup refuses to run in the host's network namespace.
