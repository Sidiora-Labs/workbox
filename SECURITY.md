# Security Policy

Workbox runs arbitrary agent code in sandboxes on a host where it holds root: it launches
bubblewrap in user namespaces, writes cgroups, installs nftables rules and exposes a REST and
WebSocket API. Each of those is an attack surface, and we treat reports against them seriously.
The threat model, what is enforced and where, and the limits that are outside the boundary are in
[docs/security.md](docs/security.md).

## Supported versions

There is no tagged release yet; the version in `package.json` is `0.1.0-dev`.

| Version            | Supported        |
| ------------------ | ---------------- |
| Latest `master`    | Yes, best effort |
| Any tagged release | None exists yet  |

Security fixes land on `master`. Once releases are tagged, only the latest one will be supported.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting for this repository (the
Security tab, then Report a vulnerability). Do not attach secrets or a working exploit against a
third party's host.

Include as much of the following as you can:

- A description of the issue and its impact
- Steps to reproduce, ideally with a minimal proof of concept
- The revision you tested (`git rev-parse HEAD`) and the host: kernel, bubblewrap version, cgroup
  v2 controllers, and the output of `workbox doctor --json`
- Whether the issue needs root inside the box, a scoped API key, or neither
- Any suggested fix

## What counts as a vulnerability here

Reports we especially want:

- **Sandbox escape.** Any path from inside a sandbox to the host: capability or seccomp bypass,
  `no_new_privs` bypass, writing outside the sandbox overlay, reaching another sandbox's files,
  sockets or artifacts, or surviving `destroy`.
- **Host namespace and firewall.** Any code path that changes the host's network namespace or its
  nftables rules, or that lets a box reach the host-only proxy link or loopback services.
- **Egress policy bypass.** Reaching an address the policy blocks, other than the stated
  proxy-only limits for hostname allowlists.
- **Resource bound bypass.** Exceeding `memory.max`, `pids.max` or `cpu.max`, or escaping the
  sandbox cgroup.
- **Control plane.** Authentication or scope bypass on the REST and WebSocket API, the browser
  guard (Origin, Sec-Fetch-Site, Host), path traversal in artifacts or checkpoints, and a lease
  token recoverable from the store.
- **Secrets.** A brokered secret that reaches a log, the audit chain, an event or an artifact
  unredacted in a form the redactor documents it handles.
- **Audit chain.** Undetected tampering by anyone without root on the host.
- **Host deletes.** A host-side delete that follows a link out of the sandbox root.

Out of scope:

- The limits listed under "Stated limits" in [docs/security.md](docs/security.md), such as the
  shared subordinate uid range, proxy-only hostname enforcement, secrets being readable inside the
  box once injected, and tamper-evidence rather than tamper-proofing of the audit chain
- Actions of operators and API clients holding admin keys, who are trusted
- Denial of service against your own host by creating sandboxes without limits you chose
- Reports from automated scanners with no demonstrated impact

## Operating notes relevant to security

- Run `workbox doctor` and fix every failure before creating sandboxes.
- Bind the server to loopback, the default, or a trusted network. There is no TLS in v1; put a
  TLS-terminating proxy in front if the network is not trusted.
- Scope API keys to the operations a client needs. Keep the secrets file (default `/etc/workbox/secrets.json`) unreadable by group and world; it is refused otherwise.
- Back up the audit directory off the host if tamper-evidence against a host root matters.

## Disclosure

We follow coordinated disclosure. We ask reporters to hold public details until a fix is available
on `master` or a reasonable time has passed after the report, and we will credit you in the
changelog unless you prefer otherwise. This project does not promise a response time or a bounty.
