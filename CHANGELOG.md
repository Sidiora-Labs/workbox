# Changelog

All notable changes to this project are recorded here, generated from git history.
There are no tags yet, so every change is listed under Unreleased. A group is the wave of the
spec task a commit carries (`[spec:workbox/<wave>.<n>]`), or the kind of change when it carries none.

## [Unreleased]

### Foundation (wave 0)

- Host doctor and cgroup v2 manager with real-process confinement tests (task workbox/0.4) (52968a9)
- Core foundation: config, logger, redactor, SQLite store, hash-chained audit, state machine (task workbox/0.3) (a71914b)
- Add the 1:1 test gate, coverage thresholds and strict lint; split protocol tests by layer (task workbox/0.5) (1ffa346)
- Add the protocol package: NDJSON peer, envelopes, validator, method catalogue (task workbox/0.2) (e6c78ad)
- Scaffold the Workbox monorepo and write the feature spec (task workbox/0.1) (1a64bcb)

### Sandbox lifecycle (wave 1)

- Drive real sandboxes from the operator CLI and rediscover them after the manager dies (task workbox/1.6) (b7b1f3b)
- Run wb inside a real sandbox and fix its signal exit, help and socket leaks (task workbox/1.5) (f0f744d)
- Qualify durable sessions and exec on a bare host (task workbox/1.4) (4954108)
- Launch chain, in-box runner and supervisor handshake: a real sandbox boots to READY (task workbox/1.3) (781dc68)
- Runtime install: checksummed Node 22 plus protocol, runner and wb under /opt/workbox (task workbox/1.2) (aff19c7)
- Rootfs build: Docker export, uid shift with setuid preservation, content digest (task workbox/1.1) (c9929ef)

### Isolation, broker and presets (wave 2)

- Install toolchain presets with pinned, digested manifests mirrored to the host store (task workbox/2.4) (9fc280b)
- Guard every netns spawn against the host namespace and bind the sandbox proxies to a host-only dummy link (task workbox/2.1) (74973b5)
- Mark tasks 2.3 and 2.5 done on the merged master (task workbox/2.3) (task workbox/2.5) (dc1962a)
- Qualify the broker inside real sandboxes and close the cross-sandbox artifact read (task workbox/2.3) (8377772)
- Give PTY sessions a real window-size resize and make workbox shell interactive (task workbox/2.5) (774f5ac)
- Deny the Docker default syscall set with EPERM in every sandbox and detach the launcher (task workbox/2.2) (1be58f0)

### Harness surfaces (wave 3)

- Serve exactly four sandbox tools over stdio MCP, checked against their schemas and driven through a real server (task workbox/3.3) (c46fff7)
- Drive the CLI against a remote server and serve from a scoped-key config file (task workbox/3.4) (541da92)
- Give the SDK every server route, safe retries and streaming sessions, tested against the real server (task workbox/3.2) (309aeaf)
- Serve the REST and WebSocket API over a real engine with scoped keys, schemas and the browser guard (task workbox/3.1) (c438ba4)

### Deployment, documentation and measurement (wave 4)

- Rewrite the docs against the qualified code and gate them on a generated wb reference and resolving links (task workbox/4.2) (7fbcbad)
- Ship a launch-chain-safe systemd unit, privileged server image, idempotent installer and a deploy check that runs doctor (task workbox/4.1) (ee2be9d)
- Cover the full sandbox lifecycle through the SDK and record 20-way density with runner RSS per sandbox (task workbox/4.3) (9f43775)

### Planning

- Point task touches at the files the commands actually live in (286ffbb)
- Record the wave-1 coverage finding: functions at 86.68 against the 90 floor (e1d9f5e)
- Plan: fold tryboxi references into hardening and expansions (f7d3008)
- Import the owner's 2026-10-27 implementation pass for waves 1-4, unqualified (87274f8)

### Hardening

- Lock runtime and rootfs installs across processes, route the last stray deletes through removeUnder and rotate live launch logs (0229b53)
- Refuse lease digests as tokens and redact runner session output across chunks (e6c8b72)
- Add the H14 removeUnder choke point for host deletes, cap launch.log and fix wb attach on exited sessions (4390726)
- Harden the store and audit log for H6 and H10: hashed lease tokens, locked appends, torn-line repair (5f4f23e)
- Harden the secret redactor for H6: short values, encoded forms, split chunks, one-pass matching (150244c)
- Close the H4 and H11 gaps in config, logging, schema, NDJSON and exec capture (807eae8)

### Fixes

- Restore egress and allowlist networking on reconcile and report its loss in health (3332f42)
- Fix the deploy bugs the Blaxel test exposed (6821e9c)
- Make the server, SDK and MCP verify globs recursive; close the wave-1 coverage finding (b41dc63)

### Changes

- Move the default sandbox uid base to 300000 and refuse a rootfs shifted for another base (6efbcdd)
- Mount the box's /tmp and /dev/shm sticky and world-writable (4858ed1)

### Tests

- Prove the web, rust, go, system and agents presets install for real in a sandbox (28ded97)
- Cover the wave-1 CLI, runner, rootfs and redact functions the coverage floor flagged (446800c)
