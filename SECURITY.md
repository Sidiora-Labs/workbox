# Security Policy

Workbox runs untrusted agent code on a host where it holds root: it launches bubblewrap in user
namespaces, writes cgroups, installs nftables rules and serves a REST and WebSocket API. The
threat model, what is enforced and the known limits are in [docs/security.md](docs/security.md).

## Supported versions

Workbox is in pre-release. Security fixes land on `main` and in the next release.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting for this repository (the
Security tab, then Report a vulnerability).

Please include:

- A description of the issue and its impact
- Steps to reproduce, ideally a minimal proof of concept
- The revision you tested (`git rev-parse HEAD`) and the host: kernel, bubblewrap version, cgroup
  v2 controllers, and the output of `workbox doctor --json`
- Whether the issue needs root inside the box, an API key, or neither

## Scope

In scope:

- **Sandbox escape**: any path from inside a sandbox to the host, such as a capability, seccomp
  or `no_new_privs` bypass, writing outside the sandbox overlay, reaching another sandbox's files,
  sockets or artifacts, or surviving `destroy`.
- **Host network**: any code path that changes the host's network namespace or firewall, or that
  lets a sandbox reach the host-only proxy link or host loopback services.
- **Network policy bypass**: reaching an address the sandbox's policy blocks.
- **Resource limits**: exceeding `memory.max`, `pids.max` or `cpu.max`, or escaping the sandbox
  cgroup.
- **API**: authentication or scope bypass, the browser guard (Origin, Sec-Fetch-Site, Host), path
  traversal in artifacts or checkpoints, or a lease token recoverable from the store.
- **Secrets**: a brokered secret reaching a log, the audit log, an event or an artifact in a form
  the redactor should catch.
- **Audit log**: undetected tampering by anyone without root on the host.
- **Host deletes**: a host-side delete that follows a link out of the sandbox root.

Out of scope:

- The [known limits](docs/security.md#stated-limits), such as the shared subordinate uid range,
  hostname allowlists applying only to proxy-aware clients, and secrets being readable inside the
  box once injected
- Actions of operators and API clients holding admin keys, who are trusted
- Reports from automated scanners without a demonstrated impact

## Running Workbox securely

- Run `workbox doctor` and fix every failure before creating sandboxes.
- Keep the server on loopback (the default) or a trusted network. It has no TLS; put a
  TLS-terminating proxy in front of it on any other network.
- Give each API key only the scopes its client needs.
- Keep the secrets file (default `/etc/workbox/secrets.json`) readable by root only; Workbox
  refuses it otherwise.
- Back up the audit directory off the host if you need tamper evidence against the host's root.

## Disclosure

Please keep details private until a fix is on `main`. We credit reporters in the changelog
unless they prefer otherwise.
