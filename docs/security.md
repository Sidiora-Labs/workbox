# Security model — with its stated limits

## What is enforced

- **Isolation**: bubblewrap in a range-mapped user namespace (inner 0..65535 → subordinate range, default base 200000), pid/net/ipc/uts/mount/cgroup namespaces, exactly the 14-capability default profile as effective/permitted/bounding, `no_new_privs`, private overlay upper per sandbox over a shared read-only rootfs.
- **Resource bounds**: cgroup v2 `memory.max`, `memory.swap.max`, `cpu.max`, `pids.max` written before any sandbox process runs; destroy uses `cgroup.kill` and waits for emptiness.
- **Seccomp (x86_64)**: classic BPF validates the architecture, denies the x32 ABI, returns `EPERM` for mount, umount2, pivot_root, setns, unshare, keyctl, add_key, request_key, kexec_load, open_by_handle_at, ptrace, bpf, perf_event_open, userfaultfd; everything else is allowed. The runner asserts `Seccomp: 2` in `/proc/self/status` before the sandbox is declared ready.
- **Network**: modes `none`, `egress`, `allowlist`. Egress denies RFC1918, link-local, multicast, CGNAT and the gateway (except proxy + DNS). Allowlist drops everything except the proxy and DNS; the host proxy enforces per-sandbox host allowlists on CONNECT and absolute-URI requests, answering 403 and auditing denials. nftables is installed from the host before the payload starts and before `CAP_NET_ADMIN` is dropped.
- **Control channel**: the host presents a per-boot token (hash compared in constant time) over `runner.hello`; the boot nonce is single-use and replay quarantines. Local (in-box) peers cannot call `runner.go`/`runner.shutdown` or `broker.secret.resolve`.
- **Secrets**: values live only in the host provider's memory (0600 JSON file or `WORKBOX_SECRET_*` env). They are injected by the runner into one child's environment. `wb secret list` shows references only; out-of-policy refs are refused; values are never written to the store, audit log or evidence.
- **Artifact boundary**: the agent sends only name/size/digest. The host opens the outbox file with `O_NOFOLLOW`, requires a regular file owned by the mapped uid range, verifies the SHA-256 while streaming into the content-addressed store (size cap enforced during streaming), then unlinks.
- **API**: scoped Bearer keys (`read`, `exec`, `admin`, `answer`) stored as SHA-256 digests and compared in constant time; 401/403; body-size caps; every mutation audited; WebSocket auth happens before upgrade.

## Stated limits (deliberate v1 trade-offs)

- **Shared subordinate range (d7)**: all sandboxes map to the same host uid range, so host files are not owner-distinguishable between sandboxes. Per-sandbox idmapped ranges are a later hardening task. Host-side sandbox directories and file permissions are therefore part of the boundary.
- **Proxy-only domain enforcement (d11)**: domain allowlists bind only proxy-aware clients; non-proxy traffic in allowlist mode is dropped, but in egress mode raw-IP public destinations are allowed by design.
- **ptrace**: "ptrace of non-descendants" is not expressible in plain seccomp; v1 denies `ptrace` outright.
- **arm64**: the seccomp program is x86_64 only; `buildSeccompProgram({arch})` refuses other arches and the supervisor only supplies a filter on x64.
- **PTY**: implemented over `script(1)` instead of a native `node-pty` binding, keeping the runner dependency-free. Resize records the size and delivers `SIGWINCH`; there is no direct winsize ioctl.
- **Single host**: no HA, no live migration, no TLS in v1 (run the server on loopback or a trusted network, or front it with a TLS-terminating proxy).
- **Redaction is defence in depth**: the invariant is that secret values are only injected into child envs. The log redactor scrubs registered values but cannot catch every encoding or split.
