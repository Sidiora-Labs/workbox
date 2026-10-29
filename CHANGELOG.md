# Changelog

All notable changes to Workbox are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- An event log per sandbox: the host records sandbox state and health, session starts and exits,
  exec results, asks, checkpoints and artifacts, beside the events agents emit with
  `wb event emit`. Read it with `GET /v1/events`, `GET /v1/sandboxes/:id/events` and
  `workbox events`, filtered by type, and long-poll it with `waitMs`.
- Event streams over WebSocket (`/v1/events/ws` and `/v1/sandboxes/:id/events/ws`) that replay
  the stored events after `afterSeq` and then follow new ones, and `client.events()` in the SDK,
  which reconnects and resumes where it stopped.
- Webhooks: signed `POST` deliveries of matching events in the Standard Webhooks format, kept
  and retried across restarts, managed through `/v1/webhooks` and `workbox webhook`, and checked
  on the receiving side with the SDK's `verifyWebhook`.
- Stored API keys with an optional lifetime, bound to sandbox labels or ids, managed through
  `/v1/keys` and `workbox key`, and `GET /v1/whoami` to show the calling key.
- Session and file control over plain HTTP: one session's state, its output, wait, input,
  signal, stop and remove; streamed raw upload and download of files of any size; directory
  creation and removal; artifact download; and `workbox sandbox run`, `logs`, `wait`, `kill` and
  `cp`.
- HTTPS and WSS from `workbox serve` when it is given a certificate, reloaded on SIGHUP.
- `GET /v1/openapi.json`, an OpenAPI 3.1 description of every route, also kept in the repository
  as `docs/reference/openapi.json`.
- Guides for webhooks and for giving an agent on another machine access through the API.

### Security

- Repeated failed authentication slows a client down: after 20 failures within 60 s, its address
  gets 429 `E_LIMIT` with `Retry-After` until the 60 s are over.
- Stored keys are kept only as SHA-256 digests. A token is shown once and removed from logs and
  the audit log, and a revoked or expired key fails on its next request.
- A key bound to some sandboxes gets 404 for every other sandbox, WebSockets included, as if it
  did not exist, and 403 on the fleet routes; sandboxes it creates carry its labels.
- Webhook endpoints must use HTTPS and resolve only to public addresses, checked when they are
  registered and before every attempt; the request goes to the checked address and redirects are
  not followed. Signing secrets are never logged or listed.
- `workbox serve` warns when it listens beyond loopback without TLS.

## [0.1.0-alpha.1] - 2026-10-28

First pre-release.

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
