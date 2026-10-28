# Security model and its limits

This page states what Workbox enforces, where in the code it is enforced, and what it does not
enforce. The limits section is part of the model: treat anything listed there as outside the
boundary.

The threat model is an agent with root inside its sandbox that runs arbitrary code. The boundary
protects the host, other sandboxes, the shared rootfs and the host's network from it. Operators
and API clients holding admin keys are trusted.

## What is enforced

### Process isolation

- The launch chain (see [architecture](architecture.md#launch-chain)) puts every sandbox in a
  user namespace that maps inner uids and gids 0..65535 onto the subordinate range (default base
  200000, 65536 ids), plus private mount, pid, net, ipc, uts and cgroup namespaces.
- Every sandbox process carries exactly 14 capabilities as its effective, permitted and bounding
  sets: chown, dac_override, fowner, fsetid, kill, setgid, setuid, setpcap, net_bind_service,
  net_raw, sys_chroot, mknod, audit_write, setfcap. bwrap drops all others
  (`--cap-drop ALL --cap-add ...`), then `init.sh` runs `setpriv --no-new-privs` with the same
  bounding set, so setuid binaries and file capabilities cannot raise privilege (d10). `sudo`
  does not work for non-root uids in the box.
- The writable filesystem is a private overlay: the shared read-only rootfs below, the sandbox's
  `upper` directory on top. The overlay is mounted inside the launch user and mount namespace
  (d9), so it never appears in the host mount table. Destroy refuses to record `DELETED` while
  any host mount still references the sandbox directory.
- The runtime (Node, protocol, runner, wb) is bind-mounted read-only at `/opt/workbox` (d12).
- Before a sandbox becomes `READY`, the runner reports self-checks (uid map, capability sets,
  `NoNewPrivs`, that `mount(2)` fails, and the seccomp mode) and the host compares them with what
  it launched. A mismatch moves the sandbox to `QUARANTINED`.

### Resource bounds

- cgroup v2 `memory.max`, `memory.swap.max`, `cpu.max` and `pids.max` are written to the sandbox
  cgroup before the launch script joins it, so every sandbox process is bounded from its first
  instruction. Defaults: 2 GiB memory, no swap, 2000 millicores, 4096 pids.
- Destroy writes `cgroup.kill`, waits for `cgroup.procs` to empty and removes the cgroup.
- Every host-side delete goes through one function, `removeUnder` in
  `packages/core/src/host/safefs.js`. It resolves symlinks on the deepest existing ancestor and
  refuses the root itself or any path outside it (H14).

### Seccomp

- On x86_64 hosts the supervisor passes a classic BPF program to `bwrap --seccomp`
  (`packages/core/src/host/seccomp.js`). It returns `EPERM` for any architecture other than
  x86_64, for the x32 ABI, and for 50 syscalls: the 14 named in req 1.6 (mount, umount2,
  pivot_root, setns, unshare, keyctl, add_key, request_key, kexec_load, open_by_handle_at,
  ptrace, bpf, perf_event_open, userfaultfd), the rest of the Docker default profile's
  unconditionally blocked set that exists on x86_64, the three io_uring calls and the new mount
  API. Every other syscall is allowed.
- The runner reports `Seccomp: 2` from `/proc/self/status` before the sandbox is declared ready.

### Control channel between host and runner

- Each boot has a boot id, a single-use boot nonce and a host token. `boot.json` in the run
  directory carries the nonce and only the SHA-256 of the host token; the runner deletes the file
  after reading it. The token itself lives in `<root>/sandboxes/<id>/host-token` (mode 0600),
  which is not mounted into the box.
- A peer that says hello as `host` must present the token; the runner compares digests in
  constant time and accepts one control channel at a time. The nonce is handed out once; the host
  records its consumption in the store, and a second presentation of a nonce quarantines the
  sandbox.
- In-box peers (wb and anything else that opens the socket) cannot call `runner.go` or
  `runner.shutdown`, and cannot call `broker.secret.resolve`: only the runner itself resolves
  secret references, over the control channel. Every other `broker.*` call from an in-box peer is
  relayed to the host, where it is validated against the protocol schema, policy-checked and
  audited.

### Network

- Modes are `none`, `egress` (the default) and `allowlist`. With networking enabled the host
  installs an nftables ruleset in the sandbox network namespace through `nsenter` before
  `runner.go`, in every mode. The box has no `CAP_NET_ADMIN`, so it cannot change the rules.
- The ruleset only creates and replaces its own `table inet workbox`. Output and input default to
  drop; loopback is accepted; IPv6 is dropped in every mode.
- `none`: no slirp4netns is attached, so the box has only loopback.
- `egress`: DNS to the slirp resolver (10.0.2.3, port 53), the sandbox's own proxy port, and then
  public IPv4. The always-blocked ranges (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
  192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, 255.255.255.255), the slirp gateway and every
  IPv4 address of the host are dropped.
- `allowlist`: DNS and the sandbox's own proxy port only; everything else is dropped.
- slirp4netns runs with `--disable-host-loopback`, so the host's loopback services are not
  reachable through the gateway.
- The proxies listen on a host-only dummy link, `workbox0`, with address 198.18.0.1/32 (the
  Manager's `proxyHost` option overrides it), never on a public interface. Each sandbox gets its
  own proxy on its own port, and its ruleset admits only that port, so one sandbox cannot reach
  another sandbox's proxy or policy. The proxy also refuses connections whose source is not a
  local address.
- The proxy resolves every name on the host, checks every answer against the always-blocked
  ranges (IPv4 and IPv6, IPv4-mapped addresses unmapped first) and the host's own addresses, and
  connects to the address it checked, with no second lookup (H13). It denies `localhost`,
  `*.localhost`, `*.local` and `*.internal` by name. In allowlist mode hostname entries (with an
  optional `*.` prefix) apply to ports 80 and 443 plus any ports the profile declares, and raw IP
  targets are allowed only through CIDR entries. Denials answer 403; every decision is appended
  to the audit log as `net.allow` or `net.deny`.

### The host-namespace guard

An earlier test run flushed the host's firewall rules by running nft in the wrong namespace. The
code now makes that impossible to do by mistake (`packages/core/src/host/netns.js`):

- Every `nsenter`, `nft` and `slirp4netns` spawn goes through `spawnGuarded`. Immediately before
  spawning it reads `/proc/<pid>/ns/net` and refuses with `E_DENIED` when that namespace is the
  host's (`/proc/1/ns/net`), this process's own, or unreadable. A refusal throws before anything
  is spawned.
- `netnsPid` finds the sandbox process to target by walking at most four levels down the launch
  pid's tree, skipping processes in the host or own namespace, and refuses pid 1 outright.
- `guardedSpawnCount()` counts every spawn the guard lets through. The unit tests use it as a
  tripwire: refusing the host and own namespaces must leave the count unchanged. A unit test also
  asserts that the rendered ruleset never contains `flush ruleset` for any mode.
- The only host-namespace network change Workbox makes is creating `workbox0` and putting its
  /32 address on it; it never edits the host firewall.

### Secrets

- Values come from the host only: a JSON file (default `/etc/workbox/secrets.json`, refused when
  group or world readable) or `WORKBOX_SECRET_<REF>` environment variables of the daemon. They
  are held in the daemon's memory and never written to the store, the audit log, evidence or the
  sandbox filesystem.
- A sandbox may resolve only the references granted at create time (`secretRefs`). Out-of-policy
  references are refused.
- `wb secret exec <ref>... -- <cmd>` asks the runner to start the command; the runner resolves
  the references over the control channel and injects the values into that one child's
  environment. `wb secret list` shows references only.
- Every value must be at least 8 characters. A shorter value is refused when it is loaded, so it
  is never registered, injected or left unredacted.
- The invariant is injection-only. Redaction is defence in depth on top of it: the redactor
  (`packages/protocol/src/redact.js`) scrubs every registered value from session output, the
  audit log and logs, matching in one pass the raw value, its JSON-escaped form, base64 (standard
  and URL-safe, padded and unpadded, and the stable middle of the value at each byte alignment
  inside a longer base64 string, such as a Basic-auth header), hex in both cases and
  percent-encoding. The runner's output redaction keeps a tail across chunks, so a value split
  across two output chunks is still caught.

### Leases

- One lease per sandbox, issued at create with a TTL (default 300 s). The token is stored only as
  its SHA-256; the store accepts the plaintext token and refuses the stored digest presented as a
  token.
- `wb lease renew` carries no token: the sandbox's own broker channel is the credential, and wb
  never holds the plaintext.

### Artifacts and checkpoints

- The agent sends only a name, size and digest. The host opens the outbox file with `O_NOFOLLOW`,
  requires a regular file owned by the mapped uid range, verifies the size (default cap 256 MiB,
  enforced while streaming) and SHA-256 while copying into the content-addressed store, then
  unlinks the outbox copy.
- Checkpoint restore verifies the archive's SHA-256 against the stored checkpoint record, then
  lists the archive and refuses any absolute member name, any name containing `..` or a NUL, and
  archives of more than a million entries, before extracting into the target upper directory.
  The listing check is by name only; member types (devices, hard links) are not inspected.

### API

- Bearer keys carry scopes `read`, `exec`, `admin` and `answer`; `admin` implies all of them.
  Keys are configured as `tokenSha256` (or a plaintext `token`, hashed at load) and compared in
  constant time over the digest. The scope each route needs is `SCOPE_MATRIX` in
  `packages/server/src/auth.js`.
- Any request carrying `Origin` or `Sec-Fetch-Site`, or a `Host` other than `localhost`,
  `127.0.0.1`, `::1` or a configured server name, is refused with 403 before authentication
  (H15, against CSRF and DNS rebinding).
- Bodies are capped at the protocol frame size (8 MiB, 413 above it) and validated against the
  route schema (400 with field paths). Every non-GET request is appended to the audit log with
  its outcome, including refused ones.
- WebSocket upgrades are authenticated and scope-checked before the 101 response.

### Audit

- Host actions are appended to NDJSON files under `<root>/audit`, each line carrying the SHA-256
  of the previous one. Writers in different processes serialise on a lockfile; a final line torn
  by a crash is truncated on the next open and the repair is itself audited. `workbox audit
verify` checks the chain.

## Stated limits

- **Shared subordinate range (d7).** Every sandbox maps onto the same host uid range. On the host,
  files of different sandboxes are not distinguishable by owner, and inner root of one sandbox has
  the same host uid as inner root of every other. Separation between sandboxes on the host side
  rests on the per-sandbox directories and mount namespaces, not on uids. Per-sandbox ranges
  through idmapped mounts are a later hardening task.
- **Domain enforcement only through the proxy (d11).** Hostname allowlists bind only clients that
  honour `HTTP_PROXY`/`HTTPS_PROXY`. In allowlist mode other traffic is dropped by nftables; in
  egress mode direct connections to public IPv4 addresses are allowed by design and never pass
  the proxy's name or address checks.
- **ptrace is denied outright.** Req 1.6 asks for "ptrace of non-descendants"; plain seccomp
  cannot express that, so `ptrace(2)` fails with `EPERM` for every target, and debuggers and
  `strace` do not work in the box.
- **Seccomp does not filter by argument.** `clone` and `clone3` are allowed with any flags and
  `personality` with any persona; the Docker profile's argument filters for these are not
  reproduced. Namespace creation through `clone` is bounded by the capability set and the
  kernel's user-namespace limits, not by the filter. `unshare(2)` and `setns(2)` are denied.
- **x86_64 only.** `buildSeccompProgram` refuses other architectures and the supervisor supplies
  no filter when the host is not x64, so on other hosts sandboxes run without seccomp.
- **Secrets are visible inside the box once injected.** A value injected into a child's
  environment can be read through `/proc/<pid>/environ` by any process in the box running under
  the same uid, and sessions run as inner root by default. Grant a reference only to a sandbox
  whose every process may see it.
- **Redaction is not a guarantee.** Values shorter than 8 characters are refused rather than
  redacted. Forms other than those listed above (compressed, encrypted, reversed, interleaved
  with other bytes, encoded twice) are not recognised.
- **Proxy and slirp live in the managing process.** The per-sandbox proxy listener and the
  slirp4netns child belong to the process that launched the sandbox (`workbox serve`, or a local
  `workbox sandbox create`). When that process exits they stop; reconcile reattaches the control
  channel but does not restart them, so a reattached `egress` or `allowlist` sandbox has no
  outside network until it is recreated. The nftables rules stay in place, so this fails closed.
- **`workbox0` persists.** The dummy link and its address stay on the host after the last sandbox
  is gone.
- **PTY through script(1).** PTY sessions use util-linux `script(1)` instead of a native
  `node-pty` binding, which keeps the runner dependency-free. Resize runs coreutils
  `stty -F <slave> rows R cols C`, which sets the window size with `TIOCSWINSZ`; the kernel then
  delivers `SIGWINCH`. A rootfs without `script` and `stty` has no PTY sessions.
- **Events are paged polling.** `GET /v1/sandboxes/:id/events` returns pages after `afterSeq`;
  there is no push stream for events. Only session output is streamed, over WebSocket.
- **The server is plain `node:http`.** It does not use Fastify (task 3.1's original wording); the
  routes, scopes, schema validation and audit behave as specified without a framework.
- **WebSocket token in the query.** Besides the `Authorization` header, an upgrade accepts
  `?token=`. A query-string token can end up in the logs of anything between client and server.
- **Lease expiry does not stop a sandbox.** An expired lease is reported; nothing is killed.
- **Audit integrity is tamper-evidence, not tamper-proofing.** Anyone with root on the host can
  rewrite the whole chain consistently. Back up the audit directory off the host if that matters.
- **Single host, no TLS.** There is no HA, no live migration and no TLS in v1. Bind the server to
  loopback (the default) or a trusted network, or put a TLS-terminating proxy in front and list
  its name in `serverNames`.
