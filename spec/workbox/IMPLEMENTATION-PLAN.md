# Workbox Implementation Plan

Status: plan only — no code in this document is implemented by writing it.
Source of truth: [spec.kvx](/root/workbox/spec/workbox/spec.kvx) (req 1–8, decisions d1–d13, tasks 0.1–4.3)
and [workflow.kvx](/root/workbox/spec/workflow.kvx) (lowest-wave eligible task, real-sandbox tests,
zero deps in protocol/runner/wb, format → verify_cmd → commit per task).
Direction: full spec compliance first, expansions second, robustness throughout.
Backward compatible unless the spec forbids it: protocol v1, store schema v1, existing exports,
config keys and CLI/exit behaviour are only added to, never removed or repurposed.

## 0. Baseline (verified 2026-10-27, this session + prior discovery handoffs)

| Measure | Value |
|---|---|
| Commits | 8 (`1a64bcb..781dc68`) = tasks 0.1–0.5, 1.1–1.3 done |
| Working tree | Dirty: task 1.4 WIP — 8 modified + 9 untracked (runner sessions/spool, core exec, tests) |
| Real packages | protocol (1105 lines, 8 unit + 1 integration), core (config/log/errors/redact/store 971L/audit/host/supervisor 512L), runner (main/runner/checks/log + WIP sessions 308L/spool 83L) |
| Stub packages | `wb`, `cli`, `server`, `sdk`, `mcp` — each `src/index.js` is exactly `export {};` |
| Gates here | `node scripts/check-tests.mjs` PASS (30 modules 1:1, 8 pkgs); `pnpm lint` PASS; `pnpm fmt:check` FAIL (6 `package.json`); `pnpm test` 67/102 pass, 35 fail; coverage 82.02/89.81/78.00 vs 90/80/90 |
| Failures | ~32 environmental (Muse sandbox: unix-socket EPERM, read-only cgroupfs, subordinate-uid chown EINVAL, docker.sock blocked); 3 deterministic in 1.4 WIP (see §1 P0-0) |
| Known hole | Uncommitted `packages/core/src/sandbox/exec.js` is **not** exported from `packages/core/src/index.js` and there is no `Supervisor.exec` wrapper (verified by direct read) |
| Catalogued, unserved | Protocol `methods.js` already defines `fs.*` and all `broker.*`; `runner.js` registers only `runner.*` + `session.*` — no `fs.*`/`broker.*` handlers, no relay to host |
| Empty | `deploy/`, `docs/`, `test/e2e/`, `packages/core/src/broker/` |

Unresolved carried from discovery (kept open, not silently closed):

1. Full `pnpm test` / `test:coverage` / `lint` and a real sandbox boot have not been run on a
   bare host; runtime correctness of committed 1.3 and uncommitted 1.4 is unverified outside
   this sandbox. → Closed by P0-0 acceptance gate, which must run on a bare host.
2. Whether the `exec.js` omission from `core/src/index.js` is intentional pending wiring or an
   oversight is unknown. → Plan treats it as pending wiring (P0-0 exports it); if intentional,
   that step is deleted, nothing else changes.

## 1. Prioritised feature list — spec-required (P0, in dependency order)

Order follows spec waves and `requires` edges. Each item names its spec task and req ACs.
Do not start a wave while a lower-wave eligible task is unfinished (workflow.kvx).

### P0-0 — Stabilise and land task 1.4 (req 3.1–3.4) — first, before any new feature

- Fix the 3 deterministic WIP failures: stale `runner/test/unit/index.test.js` export list
  (missing `RingSpool`/`SessionManager`/`DEFAULT_SPOOL_BYTES`/`DEFAULT_STOP_GRACE_MS`);
  `sessions.test.js:174` bogus `assert.throws` around a successful `remove()`;
  `sessions.test.js:91` chunk-count assumption (`nextSeq>=10` for a 10-line loop — assert on
  concatenated bytes/seq monotonicity, not pipe chunking).
- Export `exec`, `DEFAULT_EXEC_TIMEOUT_MS`, `DEFAULT_MAX_OUTPUT_BYTES` from
  `packages/core/src/index.js`; add a thin `Supervisor.prototype.exec(opts)` delegating to
  `sandbox/exec.js` so server/CLI/SDK never touch the Peer directly.
- Fix the attach replay race before building on it (hardening H7): subscribe first with a seq
  watermark, then replay, dedupe by seq; surface spool `truncated` chunks in the attach reply.
- Land criteria: task 1.4 `verify_cmd` green **on a bare host** (see §5), then commit the WIP
  as one task commit. Nothing in P0-1+ starts on top of an uncommitted 1.4.

### P0-1 — Task 1.5: wb base + broker status/evidence/artifacts/outbox (req 4.1–4.3)

- `wb` framework: subcommand registry generated from one table, `--help` and `--json` on every
  subcommand, stable exit codes (§3 E2), NDJSON client to `/run/workbox/runner.sock`.
- Commands: `wb status|tools|help`, `wb session start|list|attach|input|stop`,
  `wb run -- <cmd>` with the full evidence envelope (argv, cwd, exit, signal, start/end,
  duration, sampled peak RSS, stdout/stderr SHA-256, log artifact ref).
- Host broker base: `broker/status.js`, `broker/evidence.js`, `broker/artifacts.js`,
  `broker/outbox.js` implementing the design contract — agent sends path/size/digest only;
  host opens `O_NOFOLLOW`, requires regular file owned by the mapped range, verifies digest
  while streaming into the content-addressed store, then unlinks (H8 is mandatory here).
- Runner change: relay `broker.*` from local peers to the control peer, and register `fs.*`
  handlers (needed by req 6.1 files and by wb artifact get/put plumbing) with the path
  confinement rules in §3 H2. Relay must authenticate the control channel first (H1).

### P0-2 — Task 1.6: manager, reconcile, operator CLI local mode (req 2.1, 2.3, 2.4, 6.4)

- `core/src/sandbox/manager.js`: create/list/get/destroy/drain, reconcile-on-start
  (rediscover from store + cgroup, reconnect runner socket, list sessions losslessly, empty
  cgroup ⇒ `ABSENT`, never implicit relaunch), event fan-out. `Supervisor` stays per-sandbox;
  manager owns the fleet. Idempotency: same key + different profile ⇒ conflict error, not a
  silent return of the old row (fixes discovery RISK in `store.js:252-285`).
- `cli`: `workbox doctor|rootfs build|list|runtime install|list|sandbox create|ls|inspect|rm|exec|shell|events`
  in local-engine mode; `shell` degrades to a clear `E_UNSUPPORTED` until PTY (P0-7).
- Define the legal transition table, drain semantics, `QUARANTINED` exit, and
  `SUSPECT/UNKNOWN` thresholds as data in `sandbox/state.js` (closes a spec GAP; defaults in §4).

### P0-3 — Task 2.1: network netns + nft + proxy (req 5.1–5.3, 4.6 net)

- `host/netns.js` (slirp4netns lifecycle tied to sandbox), `host/nft.js` (render + install via
  `nsenter` before `runner.go`; egress denies RFC1918/link-local/multicast/gateway except
  proxy+DNS; allowlist drops all but proxy), `host/proxy.js` (CONNECT + absolute-URI,
  per-sandbox allowlist, 403 + audit on deny), `broker/net.js`, `wb net policy|test`.
- Launch change: `--unshare-net` stays; supervisor stops hard-coding `10.0.2.3/10.0.2.100`
  expectations ahead of the implementation and instead consumes netns results; proxy env
  (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`) injected via `runner.go` env.
- Verify from inside: rules unmodifiable in-box (no `CAP_NET_ADMIN` after drop), req 1.5
  (`none` ⇒ loopback only) re-asserted by the network integration test.
- H13 lands here, before the proxy is wired. Nothing calls `createProxy` yet, so the hole is
  latent until this task. The proxy resolves every name on the host, refuses the always-blocked
  ranges and connects to the address it checked. Hostname rules apply only on ports 80/443 plus
  ports the profile declares.

### P0-4 — Task 2.2: seccomp (req 1.6)

- `host/seccomp.js`: classic BPF for x86_64 (arch check, deny x32 ABI, `EPERM` for the Docker
  denylist: mount, umount2, pivot_root, setns, unshare, keyctl, add_key, request_key,
  kexec_load, open_by_handle_at, bpf, perf_event_open, userfaultfd; allow otherwise).
- Wire the existing plumbing: supervisor compiles the program and passes `seccompFd` through
  `launch.js` (`--seccomp <fd>`, already present at `launch.js:213` but never supplied);
  `runner/src/checks.js` must start asserting `seccomp: 2` in `/proc/self/status`
  (today `evaluateChecks` ignores the field).
- Documented limit, stated in code and docs: "ptrace of non-descendants" is not expressible in
  plain seccomp — deny `ptrace` outright in v1 and record the deviation against req 1.6
  wording; arm64 BPF is an expansion (E9), x86_64 only is the spec task text.

### P0-5 — Task 2.3: broker asks/secrets/events/leases/checkpoints/artifacts (req 4.4–4.6, 2.2)

- `core/src/broker/{asks,secrets,events,leases,checkpoints}.js` + `core/src/secrets.js`
  (provider: 0600 JSON file or env; per-sandbox allowed-ref policy in the existing
  `secret_policy` table). `wb ask raise|status|list|wait`, `wb secret exec|list`,
  `wb event emit`, `wb lease status|renew`, `wb checkpoint create|list`,
  `wb artifact put|get|list`.
- Secret invariants are acceptance-tested, not asserted in prose: values injected only into
  the child env by the runner (`broker.secret.resolve` is runner-only, never wb-visible);
  values never in store/audit/spool/evidence/filesystem; out-of-policy ref refused;
  registered values redacted from spool + audit (redactor fixes in H6 land with this task).
- Checkpoints: tar of upper + envelope JSON with digest, list, and restore into a new sandbox
  (restore is in task text although req 4.6 names only create|list — implement restore host-side
  in manager, expose via CLI/server, keep wb at create|list per the req).

### P0-6 — Task 2.4: presets (req 4.7)

- Recipes as data in `wb/src/presets/*.js`: web, python, rust, go, system, agents; each step an
  argv + verify command + version capture. `wb preset list|install` writes
  `/var/lib/workbox-preset/<name>.json` (versions + digests), mirrored via
  `broker.preset.manifest` to the host `presets` table.
- Pin versions in recipe data (spec says "latest stable" for go, "stable" for rust — resolve
  once at install, record the resolved version + digest in the manifest; never re-resolve
  silently on re-install). Install is idempotent: a second install with an identical manifest
  is a no-op success; a failed step leaves a `failed` manifest, not a partial "ok".
- Network host sets as host-side data: `@node`, `@python`, `@go`, `@rust`, `@ubuntu`,
  `@github`, `@docker`, `@browsers`, `@huggingface`. The lists come from tryboxi
  `policy.Presets`, which include the CDNs real installs hit, such as the Playwright and Chrome
  download hosts. An allowlist entry `@name` expands to its set, so `normalizeAllowEntry` gains
  that form. Each toolchain preset names the sets it needs (`web` ⇒ `@node` + `@browsers`).
- `wb preset install` never widens policy from inside the box. In allowlist mode with a needed
  set missing, it fails fast with the network code and names the `@set` the operator must add.

### P0-7 — Task 2.5: PTY sessions + interactive shell (req 3.5)

- `runner/src/pty.js` behind the existing `session.start{pty,rows,cols}` / `session.resize`
  schema (today both throw `E_UNSUPPORTED`); `node-pty` prebuild verified against the rootfs
  glibc and added to the runtime bundle by `host/runtime.js` with a digest in the manifest.
- `workbox shell` (cli) and `wb session attach` get raw-mode + resize forwarding.
- Constraint check at implementation time: `node-pty` is a native dependency inside the box —
  it ships in the mounted runtime, so protocol/runner/wb keep zero *npm* deps (workflow.kvx
  `minimal_deps`); if the prebuild cannot be made reproducible, fall back to a `script(1)`/
  `socat`-free PTY via `util-linux` already in the rootfs and record the trade-off.

### P0-8 — Tasks 3.1–3.4: harness surfaces (req 6.1–6.4)

- 3.1 `server`: Fastify (pinned dep, server package only), JSON-schema validation returning
  400 with field paths (reuse protocol `schema.js` error shape), Bearer scoped keys with
  401/403, request ids, structured JSON logs, audit on every mutation, `/metrics`,
  `/healthz`, `/readyz`, graceful shutdown. Routes: sandbox CRUD + cursor inventory with
  `complete` flag, inspect (desired/health/last-observed separate), drain, reconcile, exec,
  files (over runner `fs.*`), sessions over WebSocket, evidence/artifacts, checkpoints,
  asks list/answer (the only answer path, req 4.4), events stream. The H15 browser-request
  guard runs ahead of auth on every route.
- 3.2 `sdk`: `WorkboxClient` + `Sandbox` handle covering every route; retries with jitter only
  on idempotent calls; `AbortSignal` everywhere; sessions as async iterators.
- 3.3 `mcp`: stdio server exposing exactly `sandbox_create|sandbox_list|sandbox_exec|sandbox_destroy`
  (req 6.4 "and nothing else" — a test asserts the tool list verbatim), bounded output.
- 3.4 `cli` remote mode: `workbox serve`; every sandbox command accepts `--server/--token`
  and routes through the SDK. Local mode (P0-2) remains the default — backward compatible.

### P0-9 — Tasks 4.1–4.3: deploy, docs, measurement (req 7.3–7.5)

- 4.1 `deploy/`: systemd unit (hardening directives compatible with the launch chain),
  server Dockerfile (documented privileged requirement), `install.sh` (Workbox root,
  subordinate ranges, cgroup parent), `deploy/check.sh`; `workbox doctor` CLI command.
- 4.2 `docs/`: architecture, security model **with stated limits** (shared subuid range d7,
  proxy-only domain enforcement d11, ptrace/seccomp note from P0-4), `wb.md` generated from
  `wb tools --json` by `docs/gen-wb.mjs`, Hyperfide provider mapping, operations runbook;
  `docs/check.mjs` fails on stale generated reference or dead link.
- 4.3 `test/e2e/`: SDK-driven flow (create → `wb run` → ask raise/answer → checkpoint →
  restore → destroy), then 20 concurrent sandboxes recording create-to-ready p50/p95 and
  per-sandbox runner RSS into `docs/measurements.md` (recorded values, no invented thresholds;
  the test asserts completion + file written, thresholds stay an owner decision per spec GAP).

## 2. Expansions (P1/P2 — only after the P0 item they extend is green)

| # | Expansion | Extends | Notes |
|---|---|---|---|
| E1 | OpenAPI document generated from route schemas + `Methods` catalogue; `wb tools --json` schema versioned (`schema:1`) | 3.1, 1.5 | Additive; never hand-maintained |
| E2 | Stable exit-code contract for `wb`/`workbox`: 0 ok, 1 internal, 2 usage/`E_INVALID_PARAMS`, 3 not-found, 4 denied/quarantined, 5 timeout; `--help/--version` on every binary incl. runner `main.js` (today `--help` throws) | 1.5, 1.6 | Mapped from protocol `Codes`; documented in `docs/wb.md` |
| E3 | Protocol negotiation: `runner.hello` carries `minProtocol/maxProtocol` instead of exact-match reject; REST under `/v1`; manifest/store schema-version checks on load with refuse-newer (store already refuses newer) | 0.2 base | v1 peers keep working unchanged |
| E4 | Fuzz/property suite (no new deps; seeded PRNG in `test/helpers`): NDJSON chunk splits/oversize, schema validate, envelope, Peer abort/timeout races, config merge, `RingSpool` invariants, `canonicalJSON` round-trip, `digestTree` crafted trees, state-machine transitions | all | Runs in unit layer with fixed seeds; failures print the seed |
| E5 | Observability depth: named Prometheus metrics (sandboxes by state/health, session count, spool dropped bytes, Peer inflight, cgroup usage), request-id propagation host→runner, `workbox audit verify` CLI, audit/log rotation with size caps | 3.1, 1.6 | Metric names documented in `docs/operations.md` |
| E6 | Capacity & quota: max sandboxes/sessions per sandbox/artifacts per sandbox, upper-dir disk quota via project quotas or size accounting, admission rejection with a machine code | 1.6, 2.3 | Closes a spec GAP; defaults in §4, all `0`/`null` = today's unlimited behaviour stays available |
| E7 | GC & retention: artifacts/checkpoints/events retention after `DELETED`, exited-session spool TTL, `workbox gc` dry-run first | 2.3 | Dry-run default; nothing deleted without audit entry |
| E8 | Backup/restore drill: SQLite online backup + audit chain + CAS snapshot, `workbox backup/restore`, restore verified by audit `verify` + store `integrity_check` | 4.1 | Single-host scope stated; no HA claim |
| E9 | arm64 seccomp BPF + compat matrix CI job (kernel/bwrap/slirp/nft/node versions), offline rootfs/runtime install path | 2.2, 4.1 | Doctor reports arch support explicitly |
| E10 | Per-sandbox subordinate ranges via idmapped mounts (spec d7 later-hardening), TLS + key rotation/revocation for the server, webhook ask channel beyond stdout | 1.3 base, 3.1, 2.3 | Each is its own spec task when taken; not bundled into P0 |
| E11 | Run output cleaned up for agents. Strip ANSI (CSI/OSC) codes; collapse carriage-return redraws such as progress bars to their final state; flag binary output (a NUL in the first 8 KiB, or more than 32 invalid UTF-8 sequences); keep the head and tail with a `... N lines omitted (full log: <sha256>, wb artifact get) ...` marker. A single oversized line falls back to byte windows. The cleaned text is a view only: the raw log in the CAS and its digest remain the evidence | 1.5, 3.3 | Pure functions in `protocol/src/output.js`, zero deps. Used in-box by `wb run` and host-side for the mcp bounded output. Port tryboxi `internal/output/clean.go` with the `output_test.go` vectors |
| E12 | Host-observed run context in evidence. `networkBlocked`: proxy deny events for the sandbox inside `[startedAt, endedAt]`, deduped by host. `changedFiles`: entries in the writable overlay layer with mtime ≥ `startedAt`, whiteouts reported as deletions, capped at 500 with a `truncated` flag. The broker fills both at `broker.evidence.record` and rejects values the box supplies for them | 2.1, 1.5 | Every process in the box shares the writable layer, so `changedFiles` means "changed during the run window", not "changed by this command". The host only reads that layer; it never writes it while it is mounted |
| E13 | Resource facts in evidence, read from cgroup files: `oomKilled` (delta of `memory.events` `oom_kill`), `cpuMs` (delta of `cpu.stat` `usage_usec`), `peakMemoryBytes` | 1.5, 1.6 | Cheap. Deltas cover the whole sandbox over the run window. On this host's 6.8 kernel `memory.peak` is the cgroup's lifetime peak (a per-fd reset arrives in 6.12), so a per-command peak needs a per-run child cgroup or falls back to the P0-1 sampled RSS; the evidence records which source was used |
| E14 | Generated `wb` guide for agents. `docs/gen-wb.mjs` renders it from the same registry as `docs/wb.md`: what `wb run` records, exit codes, a blocked host ⇒ `wb ask raise --kind permission`, secrets never printed. It is shown in-box by `wb help agent` and written into a harness by `workbox agent-rules install claude\|codex\|cursor` as a skill file, an `AGENTS.md` block or a rule file, backing up any existing file first | 3.x, 4.2 | Template: tryboxi `agent-rules/sandbox.md` and `cmd/sandboxctl/mcp.go`. The content covers `wb` commands, not MCP tools, per the CLI-native thesis |
| E15 | Secrets as placeholders. **Needs an owner decision before work.** The box only ever sees a random per-sandbox placeholder for each secret. For the hosts bound to a secret, the host proxy decrypts TLS with a per-host leaf certificate signed by a host-local CA and swaps placeholders in request headers for the real value, including inside Basic-auth base64. It refuses placeholders sent to any other host or over cleartext HTTP, forces `Accept-Encoding: identity` and scrubs echoed values from responses. Git tokens are added only for allowed `owner/repo`, and `git-receive-pack` ref updates are checked against allowed push-branch globs (read-only by default). Requests carrying a stored value into the box (exec argv/env/stdin, files written in) are rejected | 2.3, 2.1 | Additive to req 4.5: a per-secret mode, `env` (today's injection, the default) or `proxy`. Costs: Node has no X.509 creation API (`X509Certificate` only parses), so this needs a pinned core-only dependency or host `openssl`; the CA must be trusted in-box through a read-only mount plus `SSL_CERT_FILE`/`NODE_EXTRA_CA_CERTS`/`REQUESTS_CA_BUNDLE`/`GIT_SSL_CAINFO`; clients that pin certificates break; the proxy decrypts agent traffic for bound hosts, which `docs/security.md` must state. Builds on H13 and the H12 per-sandbox proxy credential. Port tryboxi `internal/network/egress/{egress,intercept,ca}.go` and `internal/secrets` with their test vectors |
| E16 | Repo sync with diff, apply, pull and undo. **Needs a new spec req and an owner decision.** One-way delta sync from the host repo into the box: a manifest of size, mtime and sha256; candidates from `git ls-files -c -o --exclude-standard`; never sync `.env*`, `*.pem`, `*.key`, `id_*`, `.npmrc`, `.aws`, `.ssh`; the copied `.git/config` loses its `credential`/`include`/`includeIf` sections, `extraheader`/`helper`/`askpass` keys and URL credentials. `diff` compares against the synced base. `apply` does a per-file 3-way merge with `git merge-file -p` on temp files and never touches the host index, commits, checks out, resets or cleans. `pull` copies changed files and refuses a host file changed since the last sync unless forced. Every host write is preceded by a backup artifact that `undo` restores. Absolute paths, `..`, escaping symlinks and anything under `.git/` are rejected | 1.6, 2.3 | Writes into the box go through the runner (`fs.*` or an in-box tar extract), never as host writes into a mounted writable layer, because overlayfs forbids changing layers under a live mount. All host deletes go through H14. Overlaps Hyperfide's own repo handling, so confirm the provider contract needs it before adding the req. Port tryboxi `internal/workspace/{sync,apply}.go` with the `workspace_test.go` vectors |

### External reference: tryboxi

[tryboxi](https://github.com/karthikponna/tryboxi) is an MIT-licensed Go microVM sandbox daemon,
read at `5fdcee5` on 2026-10-28. Its isolation backend, vsock guest agent and MCP-first interface
do not apply here; the pieces below do. Ported logic is rewritten in JS, carries the Go test
vectors as JS fixtures, and keeps the MIT notice in a root `NOTICE` file from the first derived
commit. Its Linux backend is only unit-tested (its real VMs run on macOS), so none of it counts
as proven on Linux.

| tryboxi source | Workbox item |
|---|---|
| `internal/network/policy` + `policy_test.go` | H13; `@` host sets in P0-6 |
| `internal/output/clean.go` + `output_test.go` | E11 |
| `internal/service/exec.go` (`network_blocked`, `changed_files`, exit fields) | E12, E13 |
| `agent-rules/sandbox.md`, `cmd/sandboxctl/mcp.go` | E14 |
| `internal/network/egress/{egress,intercept,ca}.go` + tests, `internal/secrets` | E15 |
| `internal/workspace/{sync,apply}.go` + `workspace_test.go` | E16 |
| `internal/safefs` + `safefs_test.go` | H14 |
| `internal/api/middleware` | H15 |

## 3. Hardening list

Timing is the point: H1–H3 and H13 land **before** the surface that would expose them (broker
relay, files API, REST, the proxy). The rest ride with the task that touches the file. Every H item gets a
negative test asserting the failure mode, per req 8 — a fix without its attack test is not done.

| # | Hardening | Where (verified) | Lands with |
|---|---|---|---|
| H1 | Authenticate the control channel. Today `runner.hello{role:'host'}` is client-asserted: first caller gets the boot nonce + control (`runner.js:215-238`); any in-box root process can race the host. Fix: `SO_PEERCRED` uid check + per-boot host token passed out-of-band (fd or host-only 0700 dir), or split host socket from the local wb socket with method scoping (local peers: no `runner.go/shutdown`, no `broker.secret.resolve`, session ops scoped). Nonce replay ⇒ `QUARANTINED` (req 2.2) already; keep single-use | `runner/src/runner.js`, `core/src/sandbox/supervisor.js` | P0-0/P0-1, before broker relay |
| H2 | Path traversal: `NAME_RE` accepts `..` in cgroup/rootfs/runtime/config (`cgroup.js:11`, `rootfs.js:13`, `runtime.js:20`, `config.js:141-154`); `sandboxDirs(id)` unvalidated and `removeDirs` `rm -rf`s the join (`launch.js:59-70,286-288`). Fix: reject `.`/`..`/leading `-`/empty components everywhere + realpath-prefix assertion (resolved path stays under parent) in `sandboxDirs`/`dir`/`childPath`/`remove`; same confinement for new `fs.*` handlers (no `..`, symlink-resolved root check, `O_NOFOLLOW` on final component where required) | `core/src/host/{cgroup,rootfs,runtime,launch}.js`, `core/src/config.js`, new runner `fs` code | P0-0 (launch/store ids), P0-1 (`fs.*`) |
| H3 | Shell/option injection: overlay `-o` split on `,`/`:` in WB_LOWER/UPPER/WORK (`core/scripts/launch.sh:14`); doctor `sh -c` interpolates `TMPDIR`-derived path unquoted (`doctor.js` overlayProbe); `resolv.conf`/`hosts`/`hostname` written from unsanitised nameservers/hostname (`launch.js:96-106`). Fix: reject `, : \` and control chars in workbox-root-derived paths at config validation; pass probe paths via argv/env, never string-interpolated `sh -c`; validate hostname/nameserver as data at the launch layer, not only in supervisor | `core/scripts/launch.sh`, `host/{doctor,launch}.js`, `config.js` | P0-0 |
| H4 | Prototype pollution + unbounded recursion: `config.merge()` assigns `__proto__` from JSON patches (`config.js:184-190`); same pattern in `redact.js:56-65`, `log.js:32`; schema/redact/`canonicalJSON`/tree walks recurse without depth caps. Fix: skip `__proto__`/`constructor`/`prototype` keys in merge/redact/log-assign (fail-closed: drop, never pass through), depth cap (e.g. 64) + node-count cap in validators and tree walks, strict unknown-key rejection in config (typos fail closed, not open) | `core/src/{config,redact,log,audit}.js`, `protocol/src/schema.js`, `host/rootfs.js` | P0-0/P0-2 |
| H5 | Validate everything inbound at trust boundaries: apply the defined-but-unused `Events` schemas in Peer dispatch (`methods.js:293-332`); validate `session.output` (`stream` enum, base64 strictness) before `exec.js` consumes it (`exec.js:67-75`); schema-validate store profile/env/limits host-side (`supervisor.js:155-165`); bound `v.any()` payloads (evidence envelope, event payload, preset manifest, ask answer — `methods.js:163,242,285,331`) by depth/bytes before they reach SQLite; validate rootfs/runtime manifests (schema + digest) on `get()`/`require` before launch (`rootfs.js:55-82`, `runtime.js:62-99`) | `protocol/src/{peer,methods}.js`, `core/src/sandbox/{exec,supervisor}.js`, `host/{rootfs,runtime}.js` | P0-0 (exec/events), P0-1 (broker payloads) |
| H6 | Secrets & crypto hygiene: constant-time compare (`timingSafeEqual`) for boot-nonce hash and lease token, store lease/secret tokens hashed at rest (`store.js:477-488,744-758`); redactor: values <6 chars currently leak, encoded (base64/hex/URL) and chunk-split forms unredacted, `split/join` is O(secrets×text) (`redact.js:5,19-48`). Fix: hash-at-rest + timing-safe compare; redactor keeps a rolling tail across chunks and also registers base64/hex encodings of each value; document that redaction is defence-in-depth, the invariant is injection-only (P0-5) | `core/src/{store,redact}.js`, `host/launch.js` (`hashNonce`) | P0-5 (redact), P0-2 (store tokens) |
| H7 | Concurrency/resource caps: Peer pre-aborted `AbortSignal` hangs forever (`peer.js:89-120`); no caps on pending/inflight/connections/handlers; `timeoutMs:0` disables timeout; runner sessions/spools/subscribers unbounded (each spool up to 64 MiB — cgroup OOM kills the runner itself); attach replay race silently loses chunks (`sessions.js:168-198`); spool oversize-chunk truncation invisible to attach (`spool.js:45-64`); signal PID-reuse race (`sessions.js:241-286`). Fix: check `signal.aborted` before registering, cap peers/sessions/subscribers/inflight with `E_BUSY` on excess, hello + idle timeouts, exited-session TTL eviction, subscribe-then-replay with seq watermark, surface `truncated`, re-check `child.exitCode` before group kill | `protocol/src/peer.js`, `runner/src/{sessions,spool,runner}.js` | P0-0 |
| H8 | Host-boundary file handling: outbox handoff is the prime agent→host-root crossing (design: `O_NOFOLLOW` + mapped-owner + digest-while-streaming + unlink — implement exactly that, size cap enforced while streaming, not after); tar extraction as root needs explicit guards (first-pass listing rejecting absolute/`..`/device/hardlink-escape entries, `--no-absolute-filenames`, byte/inode caps) in `rootfs.js:191-210` and `runtime.js:340-349`; `copyPackage` must not follow symlinks into the runtime mounted in every box (`runtime.js:295-319`); staging via `mkdtemp` inside the target dir + per-name lockfile + fsync-dir after rename (kills the `${target}.tmp` TOCTOU) | new `core/src/broker/outbox.js`, `host/{rootfs,runtime}.js` | P0-1 (outbox), next touch of rootfs/runtime |
| H9 | Download trust: `nodeVersion` interpolated unvalidated into URL + cache filename; fetch has no timeout/size cap/redirect policy; SHASUMS same-origin as tarball (`runtime.js:107-124,250-269`). Fix: `nodeVersion` must match `/^[0-9]+\.[0-9]+\.[0-9]+$/`, HTTPS-only redirects to the same allowlist, timeout + max-bytes, and a repo-pinned expected hash per supported Node version (SHASUMS kept as a second check, not the root of trust); cap `_docker` stdout/stderr buffering with kill-on-overflow (`rootfs.js:160-184`) | `host/{runtime,rootfs}.js` | Next touch; before 4.1 install script |
| H10 | Durability: audit append has no lock/fsync — two writers fork the chain, a torn last line makes the daemon unstartable, verify reads whole files into memory (`audit.js:52-151`); `launch.log` grows forever and is read whole (`launch.js:243,271-279`); store `JSON.parse` on row reads crashes all callers on one corrupt row, several list calls unbounded (`store.js`). Fix: single `O_APPEND` write + fsync policy, cross-process lockfile, tolerate/repair torn final line on open (truncate to last good line, audit the repair), streaming verify, launch-log rotation + byte-capped tail reads, defensive row parse ⇒ `E_INTERNAL` with row id, paginated lists, `integrity_check` on open | `core/src/{audit,store}.js`, `host/launch.js` | P0-2 (manager is the second writer) |
| H11 | Bounded config + encodings: config has minima only — `memoryBytes`/`pids`/`spoolBytes` can be 2^53 (`config.js:128-161`); NDJSON decodes with lossy UTF-8 (`ndjson.js:61`) and schema string `max` counts UTF-16 units not bytes (`schema.js:96`); `Capture` splits multibyte chars at the byte cap (`exec.js:30-45`); doctor `cgroupCheck` mutates host cgroups and can leak a probe cgroup (no `finally`). Fix: maxima mirroring cgroup/kernel limits, byte-length accounting in schema strings, fatal UTF-8 on the control channel (`TextDecoder{ fatal:true }`) with session *payload* bytes remaining base64 (already the case), UTF-8-boundary-aware capture truncation, doctor probe cgroup cleanup in `finally` + `--json` read-only mode documented | `core/src/{config}.js`, `host/doctor.js`, `sandbox/exec.js`, `protocol/src/{ndjson,schema}.js` | P0-0/P0-2 |
| H12 | Forward-looking (design-stage, no code yet — cheap now, expensive later): proxy must not trust source IP alone per sandbox (per-sandbox proxy credential issued at `runner.go`, rotated per boot); WS auth before upgrade + heartbeat + backpressure (drop slow consumers, never grow unbounded sends — same rule as Peer `_send`); scoped-key least-privilege matrix written down before 3.1 routes multiply; sandbox/run/outbox dirs tightened from 0755 toward 0710 with group = daemon (shared subuid range d7 makes host-dir perms the only cross-sandbox file barrier on the host side) | `host/{proxy,launch}.js`, `server/`, docs | P0-3, P0-8 design notes |
| H13 | Proxy SSRF. In `egress`, the default mode (`config.js:16`), nft accepts the proxy port before the private-range drops (`nft.js:64-73`). The proxy then allows every target (`proxy.js:54`) and connects by name (`proxy.js:79`, `proxy.js:114`) without checking the resolved address. So `curl -x http://10.0.2.2:8080 http://169.254.169.254/`, or a CONNECT to `127.0.0.1:<port>`, reaches cloud metadata or host loopback services. In `allowlist`, an allowed `*.domain` whose DNS answers a private address does the same. Fix: resolve on the host; unmap IPv4-mapped IPv6, then refuse the always-blocked ranges (0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4, 240/4, 255.255.255.255/32, ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, ::ffff:0:0/96); connect to the checked address with no second lookup; deny `localhost`, `*.localhost`, `*.local` and `*.internal` by name; apply hostname rules only on 80/443 plus declared ports; allow raw-IP targets only through CIDR allow entries. nft also gets an explicit IPv6 drop: its `ip daddr` rules match IPv4 only, so in egress IPv6 falls through to `accept`, which is harmless today only because slirp4netns runs without IPv6 | `core/src/host/{proxy,nft}.js` | P0-3 (2.1), before `createProxy` gets its first caller |
| H14 | A single choke point for deletes, complementing H2: H2 validates names, H14 bounds where deletes can land. Every host-side delete (`launch.js` `removeDirs`, checkpoint and artifact GC, a future E16 undo) goes through one `removeUnder(root, path)`. It resolves symlinks on the deepest existing ancestor, refuses the root itself and anything outside it, and is the only module allowed to call `fs.rm`/`rmSync`, which an eslint `no-restricted-properties` rule enforces everywhere else. Port tryboxi `internal/safefs` with `safefs_test.go` | ＋ `core/src/host/safefs.js`, `host/launch.js`, broker GC | P0-2 (the manager's destroy is the main deleter) |
| H15 | Browser-originated requests to the local API. A page in the operator's browser can POST to `127.0.0.1:<port>` (CSRF) or reach the API through DNS rebinding. Fix: reject any request that carries `Origin` or `Sec-Fetch-Site` with 403 before auth runs, and accept `Host` only for `localhost`, `127.0.0.1`, `::1` and configured server names | `server/src/{server,auth}.js` | P0-8 (3.1) |

## 4. Spec gaps — proposed defaults (owner-confirmable, all backward-compatible)

The spec leaves these open (discovery GAP list). The plan proceeds on these defaults; each is a
config key or a documented constant, so an owner override is a data change, not a redesign.
Anything marked † contradicts nothing in the spec but should be confirmed before its task starts.

- Numeric defaults: keep existing `config.js` DEFAULTS (memory 2 GiB, swap 0, CPU 2000 ms,
  pids 4096, spool 8 MiB, stop grace 5 s, lease TTL 300 s, boot timeout 20 s) and add maxima
  per H11. Exec: timeout 60 s, capture 1 MiB/stream (already in `exec.js`).
- Create-sandbox input: `{ idempotencyKey?, rootfs?, runtime?, limits?, network:{mode,allow[]},
  env?, labels?, secretRefs? }`, unknown fields rejected 400; allowlist entries are hostnames
  with optional `*.` prefix, lower-cased, IDNA rejected in v1 †.
- Drain: stop accepting new sessions, wait for live sessions up to the drain timeout, then stop
  escalates; `QUARANTINED` exits only via destroy or operator `inspect` + explicit reset to
  `DELETING` †. Health: poll 2 s, 3 misses ⇒ `SUSPECT`, 10 ⇒ `UNKNOWN`, empty cgroup ⇒ `ABSENT`.
- Lease expiry action: emit event + mark `SUSPECT`; never auto-kill in v1 † (kill-on-expiry is E10-class).
- Asks: per-kind answer schemas (question=string, decision=one of options, permission=bool,
  secret=ref name only — never a value through the ask channel); ask TTL from `timeoutMs`,
  expiry ⇒ `expired`, `wait` returns exit 5 per E2.
- Secret ref→env mapping: ref `FOO` ⇒ env `FOO`; explicit `REF=ENVNAME` form allowed in policy.
- Files API: paths absolute in-box, symlink-resolved confinement to the sandbox root view is
  the runner's job (it is already in-box — confinement means "no host paths", which the mount
  ns gives) + 4 MiB per `fs.read/write` chunk (already in schema), writes atomic via temp+rename.
- Events/evidence/artifacts: retained after `DELETED` until GC (E7); sizes bounded by H5.
- Auth scopes: `read`, `exec`, `admin` (mutations), `answer` (asks) †; keys in a 0600 config
  file, stored hashed; TLS is E10 (v1 documented as trusted-network/loopback).
- Error/JSON envelopes: REST errors `{ error:{ code, message, details?, requestId } }`;
  `wb --json` prints exactly one JSON value on stdout, diagnostics on stderr, exit codes per E2.

## 5. File-by-file change plan

Legend: ✎ modify, ＋ create, — leave alone. Every ＋/✎ source file implies its 1:1 unit test at
`test/unit/<same path>.test.js` (req 8.1, `scripts/check-tests.mjs`); test files are listed in
§6, not repeated per row. JSDoc on every new export, strict eslint set unchanged.

### Root / tooling

- ✎ `package.json` — add `fmt` coverage for new dirs only; scripts unchanged otherwise.
  Fix the 6 prettier-failing `packages/*/package.json` (run `pnpm fmt`) in P0-0.
- ＋ `NOTICE` — the MIT notice for tryboxi-derived code, added with the first derived commit
  (H13 at the latest).
- ＋ `.github/workflows/ci.yml` (P0-9/E9) — gates exist only as local scripts today; CI runs
  `check:tests`, `lint`, `fmt:check`, unit tests unprivileged, and a privileged bare-host job
  for integration/e2e. This is what makes req 8's "gate that cannot be skipped" true.
- ✎ `scripts/check-tests.mjs` — keep behaviour; add its own negative test (§6). Note the
  req 8.1 vs d13 path wording drift (`packages/<p>/test/unit` vs `test/unit/<same path>`) —
  the script already implements the former; no change.
- ✎ `eslint.config.js` — add a JSDoc-presence rule for exports if achievable without a plugin
  dependency in devDeps only; otherwise enforce via a small check in `check-tests.mjs`
  (today req 8.4's JSDoc clause is unenforced by any gate).
- — `spec/workbox/spec.kvx` is the task driver: flip `status` per task via the hyperfide
  workflow, never hand-edit generated `design.md`/`requirements.md`/`tasks.md`.

### `packages/protocol` (zero deps, runs in-box)

- ✎ `src/peer.js` — H5/H7: pre-abort fix, inflight/pending caps, validate inbound events
  against `Events`, non-serialisable handler result ⇒ `E_INTERNAL` reply instead of hang,
  bounded `_send` queue for slow consumers.
- ✎ `src/ndjson.js` — H11: fatal UTF-8 decode option for the control channel.
- ✎ `src/schema.js` — H4/H11: depth/node caps, byte-length string maxima.
- ✎ `src/methods.js` — bound the four `v.any()` payloads (H5); add optional
  `minProtocol/maxProtocol` to `runner.hello` only with E3 (additive, v1 peers unaffected);
  add `broker.checkpoint.restore` only if restore is ever exposed to wb (plan: host-side, so no).
- ✎ `src/errors.js`, `src/envelope.js`, `src/ids.js`, `src/index.js` — errors gain optional
  `retryable` + `requestId` fields (additive); rest unchanged.
- ＋ `src/output.js` (E11) — ANSI strip, CR collapse, binary detection, head+tail truncation;
  pure functions, zero deps.

### `packages/core`

- ✎ `src/index.js` — P0-0: export `exec` + constants from `sandbox/exec.js`; then per task:
  manager, broker modules, secrets, `host/{netns,proxy,nft,seccomp}`.
- ✎ `src/config.js` — H2/H3/H4/H11: name validation, `__proto__` drop in `merge`, unknown-key
  rejection, maxima; new keys only as additive groups (`server`, `proxy`, `quota`, `retention`)
  with defaults preserving current behaviour.
- ✎ `src/store.js` — H6/H10: hashed tokens + timing-safe compare, defensive row parse,
  paginated lists, `integrity_check` on open, idempotency-conflict error (P0-2). Schema
  changes, if any, go through the existing migration mechanism as version 2 with a v1→v2
  migration test; tables for all P0 features already exist (asks/leases/checkpoints/presets/
  secret_policy/artifacts/evidence) — no new tables planned.
- ✎ `src/audit.js` — H10: lockfile, fsync policy, torn-line repair, streaming verify;
  `canonicalJSON` depth cap + reject BigInt/circular with a coded error (H4).
- ✎ `src/log.js`, `src/redact.js`, `src/errors.js` — H4 (`__proto__` drop), H6 (chunk-tail +
  encoded-form redaction), error `retryable/requestId` passthrough.
- ＋ `src/secrets.js` (P0-5) — provider (0600 JSON/env), policy check, ref→env mapping;
  values held in memory only, never logged.
- ✎ `src/host/launch.js` + `scripts/launch.sh` — H2/H3/H10/H12: id validation, path-char
  rejection, resolv/hosts data validation, launch-log cap/rotation, dir perms 0710;
  `seccompFd` plumbing already present — supervisor starts supplying it in P0-4.
- ✎ `src/host/cgroup.js` — H2 name fix; `pidAlive`/kill-fallback PID-reuse guard (verify
  `/proc/<pid>/cgroup` membership before any per-pid signal).
- ✎ `src/host/doctor.js` — H3/H11: no `sh -c` interpolation, probe-cgroup `finally` cleanup,
  new probes as features land (slirp4netns/nft already probed; add seccomp-BPF compile check,
  node-pty load check in P0-7).
- ✎ `src/host/rootfs.js`, `src/host/runtime.js` — H2/H5/H8/H9: name fix, manifest
  schema+digest verification on load, tar guards, `mkdtemp` staging + lockfile, pinned Node
  hashes, bounded docker output; runtime gains the `node-pty` bundle entry in P0-7 and stops
  copying symlinked files (H8).
- ＋ `src/host/netns.js`, `src/host/nft.js`, `src/host/proxy.js` (P0-3). H13's resolved-address
  check, port rules and IPv6 drop land in `proxy.js`/`nft.js`; the `@` host sets go in a data
  module next to `proxy.js` with P0-6. ＋ `src/host/seccomp.js` (P0-4).
- ＋ `src/host/safefs.js` (H14) — `removeUnder(root, path)`, the only caller of `fs.rm`.
- ✎ `src/sandbox/state.js` — P0-2: transition table + drain/quarantine edges as data (§4).
- ✎ `src/sandbox/supervisor.js` — H1 token presentation, H5 store-profile validation,
  `exec()` wrapper (P0-0), netns/nft/proxy hooks replacing the hard-coded `10.0.2.x`
  assumption (P0-3), `seccompFd` supply (P0-4), health-write only on change (kills the 2 s
  unconditional UPDATE), `beforeGo/afterStop` hooks kept as the integration seam.
- ✎ `src/sandbox/exec.js` — H5/H11: validate opts (`timeoutMs/maxOutputBytes/graceMs` ranges),
  `AbortSignal` support, UTF-8-boundary-safe truncation, strict stream/base64 checks.
- ＋ `src/sandbox/manager.js` (P0-2) — fleet lifecycle + reconcile + event fan-out.
- ＋ `src/broker/{index,status,evidence,artifacts,outbox}.js` (P0-1),
  `src/broker/{asks,secrets,events,leases,checkpoints,presets,net}.js` (P0-3/P0-5/P0-6) —
  one module per broker family, each: validate (protocol schema) → policy → store/CAS →
  audit. `broker/index.js` wires them onto the supervisor control peer.

### `packages/runner` (zero deps, in-box)

- ✎ `src/runner.js` — H1: peer-cred/token auth + method scoping per role; register `fs.*`
  (P0-1) and the `broker.*` relay to the control peer (P0-1, with per-method timeout and
  control-absent ⇒ coded error, never a hang); connection caps + hello/idle timeouts (H7);
  `readBootFile` result schema-checked.
- ✎ `src/sessions.js`, `src/spool.js` — H7 attach race + truncation surfacing + caps + TTL;
  secret-env injection path completed with P0-5 (`secretEnv` accepted only from the control
  peer's `session.start`, never from a local peer — enforcement point for req 4.5).
- ＋ `src/fs.js` (P0-1) — `fs.read/write/list/stat/mkdir/remove` with H2 confinement, atomic
  write, byte-range reads per the existing schema.
- ＋ `src/pty.js` (P0-7) — PTY spawn/resize behind the `SessionManager` interface;
  `session.resize` stops throwing `E_UNSUPPORTED` for PTY sessions, keeps it for pipe sessions.
- ✎ `src/checks.js` — assert seccomp mode (P0-4) and network mode evidence (P0-3) in
  `evaluateChecks`; failures feed the existing quarantine path.
- ✎ `src/main.js` — E2: `--help/--version`; exit codes aligned with the contract.

### `packages/wb` (zero deps, in-box; today `export {};`, `bin/wb` execs a missing `src/main.js`)

- ＋ `src/main.js` — argv dispatch, E2 exit codes, `--help/--version`, `--json` plumbing.
- ＋ `src/client.js` — NDJSON Peer client to the runner socket; `broker.*` via relay;
  per-call timeouts; socket-absent ⇒ coded error + exit 4.
- ＋ `src/registry.js` — single command table (name, summary, usage, run) that generates
  `--help`, `wb tools`, `wb tools --json`, and feeds `docs/gen-wb.mjs`. One source, no drift.
- ＋ `src/commands/{status,tools,session,run}.js` (P0-1); `net.js` (P0-3);
  `{ask,secret,event,lease,checkpoint,artifact}.js` (P0-5); `preset.js` (P0-6).
- ＋ `src/run-evidence.js` — `wb run` streaming, peak-RSS sampling, digesting, outbox hand-off.
- ＋ `src/presets/{web,python,rust,go,system,agents,index}.js` (P0-6) — recipes as data.
- ✎ `src/index.js` — exports registry/client for tests and docs generation; ✎ `bin/wb` unchanged
  (it already points at `src/main.js`).
- ✎ `package.json` — add `bin: { wb: ./bin/wb }` and `@workbox/protocol: workspace:*`.

### `packages/cli` (today stub, no bin)

- ＋ `src/main.js`, `src/registry.js` (same table pattern as wb), `src/local.js` (local engine
  over `@workbox/core`), `src/remote.js` (P0-8/3.4, over `@workbox/sdk`).
- ＋ `src/commands/{doctor,rootfs,runtime,sandbox,exec,shell,events,serve,audit}.js`
  (P0-2 local; `serve` + remote routing in 3.4; `audit verify` with E5).
- ✎ `package.json` — `bin: { workbox: ./src/main.js }`, deps `@workbox/core`, later `@workbox/sdk`.

### `packages/server`, `packages/sdk`, `packages/mcp` (today stubs)

- server ＋ `src/{server,auth,routes/{sandboxes,exec,files,sessions,evidence,artifacts,checkpoints,asks,events},ws,metrics}.js`;
  one route module per family so the 1:1 test map stays honest; Fastify pinned in
  `packages/server/package.json` only. Auth (H12): hashed scoped keys, 401/403, WS auth
  pre-upgrade, body-size limits mirroring protocol caps. H15's browser-request guard sits in
  `server.js` ahead of `auth.js`.
- sdk ＋ `src/{client,sandbox,errors,retry}.js` — `fetch`/`WebSocket` globals only (already in
  the eslint globals list), no deps beyond Node ≥22.13 built-ins.
- mcp ＋ `src/{server,tools}.js` — stdio JSON-RPC; depends on `@workbox/sdk` only; tool list
  is a frozen constant test-asserted against req 6.4.

### `rootfs/`, `deploy/`, `docs/`, `test/e2e/`

- — `rootfs/minimal/Dockerfile` unchanged except preset-dir/profile already present.
- ＋ `deploy/{workbox.service,Dockerfile.server,install.sh,check.sh}` (P0-9/4.1).
- ＋ `docs/{architecture,security,wb,hyperfide-provider,operations,measurements}.md`,
  `docs/gen-wb.mjs`, `docs/check.mjs` (P0-9/4.2–4.3).
- ＋ `test/e2e/{lifecycle,ask-checkpoint,density}.test.js` (P0-9/4.3) — note: root `pnpm test`
  already globs `test/e2e/*.test.js`, and `check-tests.mjs` starts requiring e2e the moment
  `server` stops being a stub, so a first e2e lands **with** task 3.1, not at 4.3.

## 6. Test plan

Rules that apply to every item (req 8, d13, workflow.kvx):

- Unit: one `test/unit/<same path>.test.js` per source module, same commit. Index tests must
  assert more than export-name presence once a package is real (today's index tests have one
  assertion each) — at minimum, re-export identity against the owning module.
- Integration: ≥1 per real package, real processes/sockets/files/sandboxes, never fakes
  (existing `PassThrough` peers and `fakeClock` in unit tests are the only sanctioned doubles).
- E2E: under `test/e2e/` from task 3.1 on (gate already wired).
- Negative tests are first-class: every H item and every spec "SHALL be refused/never" clause
  gets a test that attempts the forbidden thing and asserts the coded failure.
- Timing: no new wall-clock-chunk assumptions (the 1.4 `nextSeq>=10` lesson) — poll on
  observable state with a deadline, assert on bytes/sequences/state, not on chunk counts.
- Environment honesty: integration/e2e require a bare host (root, bwrap, cgroup v2 delegated,
  docker for rootfs, nft + slirp4netns for net). In a restricted sandbox they must be reported
  as *not run*, never reclassified as pass. Unit + protocol tests must pass everywhere.

Per-item tests (additions beyond the 1:1 unit floor):

| Item | Integration / e2e tests | Key negatives |
|---|---|---|
| P0-0 (1.4) | `core/test/integration/sessions.test.js` (exists as WIP): ordering, replay, gap after 8 MiB overflow, survive host disconnect/reconnect, TERM→KILL escalation, exec timeout, in-box OOM (`oom_kill>=1`), pid-limit proof deferred from 1.3 | attach during flood loses nothing (H7); oversize chunk ⇒ `truncated` visible; pre-aborted Peer request rejects, never hangs; `..`/absolute sandbox id rejected (H2); `__proto__` config patch harmless (H4) |
| P0-1 (1.5) | `core/test/integration/wb.test.js` inside a real sandbox: `wb status/tools` (+`--json`), `wb session *`, `wb run` evidence fields, digest-verified artifact in CAS, `fs.*` round-trip via supervisor | forged digest/size rejected; symlink in outbox rejected (`O_NOFOLLOW`); outbox file owned outside mapped range rejected; local peer calling `runner.go`/`broker.secret.resolve` ⇒ `E_DENIED` (H1); `fs.write` with `..`/absolute-host path rejected (H2) |
| P0-2 (1.6) | `cli/test/integration/cli.test.js`: create via CLI, kill manager process, restart, rediscovered with sessions intact, destroy ⇒ `DELETED`; empty-cgroup sandbox ⇒ `ABSENT`, not relaunched | duplicate idempotency key + different profile ⇒ conflict; illegal transition ⇒ machine code; second nonce presentation ⇒ refused + `QUARANTINED`; audit chain verifies across the restart (H10) |
| P0-3 (2.1) | `core/test/integration/network.test.js`: none/egress/allowlist against a host listener + the proxy; DNS works in egress; `wb net policy|test` | RFC1918 + gateway denied in egress; non-proxy traffic dropped in allowlist; CONNECT to unlisted host ⇒ 403 + audit event; `nft` rules unmodifiable from inside; sandbox A cannot use sandbox B's proxy credential (H12); in egress, `127.0.0.1`, `169.254.169.254` and `[::ffff:127.0.0.1]` through the proxy ⇒ 403 + audit, as is an allowlisted name whose DNS answer (from a real test resolver) is `10.0.0.1` (H13); hostname rule on an undeclared port ⇒ denied; IPv6 packet dropped |
| P0-4 (2.2) | `core/test/integration/seccomp.test.js`: each denylisted syscall ⇒ `EPERM` in a real sandbox; ordinary toolchain ops (fork/exec/chown/setuid/socket/epoll) unaffected; `/proc/self/status` shows filter mode 2 | x32 ABI syscall ⇒ killed/`EPERM` per program; sandbox booted without the fd fails checks and quarantines (no silent unfiltered boot) |
| P0-5 (2.3) | `core/test/integration/broker.test.js`: ask raise→answer→`wait` wakes; secret exec sees the value, `env` outside does not; lease renew extends deadline; checkpoint→restore into new sandbox reproduces files; artifact put/get/list | out-of-policy ref refused; secret value greps clean across store DB, audit files, spool replay and sandbox fs; answer via wb (not host API) impossible; expired ask/lease behaviours; checkpoint of a running writer either quiesces or is refused with a code — never a silent torn tar |
| P0-6 (2.4) | `core/test/integration/presets.test.js`: install `python` with egress; manifest at `/var/lib/workbox-preset/python.json` + host mirror; `python3`/`uv` run | unknown preset ⇒ coded error; re-install is a no-op with identical manifest; a step failure records `failed`, not `ok`; preset install in `none` network fails fast with the network code; allowlist profile without the preset's host set ⇒ fast failure naming the missing `@set`; an in-box install never changes the stored policy |
| P0-7 (2.5) | `core/test/integration/pty.test.js`: `isatty` true in-box, resize propagates (`stty size`), `workbox shell` scripted round-trip | resize on a pipe session ⇒ `E_UNSUPPORTED`; PTY session stop still escalates TERM→KILL |
| P0-8 (3.1–3.4) | server tests vs a real engine (auth 401/403, schema 400 with field paths, lifecycle, exec, WS session, ask answer); sdk tests cover every route vs that server; mcp spawns and runs exec in a real sandbox; `cli/test/integration/remote.test.js` serve + remote create/exec/rm; first `test/e2e/lifecycle.test.js` | MCP tool list equals exactly the four names; scoped key with `read` cannot exec/destroy; oversize body ⇒ 413/400 not OOM; WS without token rejected pre-upgrade; SDK retry never duplicates a non-idempotent create (idempotency key asserted); request with `Origin` or `Sec-Fetch-Site` ⇒ 403, `Host: evil.example` ⇒ 403 (H15) |
| P0-9 (4.1–4.3) | `bash deploy/check.sh`; `node docs/check.mjs`; `test/e2e/{ask-checkpoint,density}.test.js`: full flow + 20 concurrent sandboxes writing p50/p95 + RSS to `docs/measurements.md` | `docs/check.mjs` fails on a deliberately staled `wb.md` (self-test); install script is idempotent on re-run |
| Gates | `scripts/check-tests.mjs` negative self-test (temp tree missing a unit test ⇒ exit 1); JSDoc-on-exports enforcement test; `fmt:check` back to green and kept there by CI | coverage floor is the spec's 90/80/90 — depressed-coverage files today (`exec.js` 32%, `supervisor.js` 36%, `runner.js` 46%, `cgroup.js` 55% lines in-sandbox) must reach it via bare-host integration, not by lowering thresholds |
| E4 fuzz | seeded property tests in unit layer (NDJSON, schema, envelope, Peer races, spool invariants, `canonicalJSON`, config merge, `digestTree`, state machine) | a fuzz failure prints its seed and minimised input; seeds are then pinned as regression cases |
| H14 | unit vectors ported from tryboxi `safefs_test.go`; destroy of a real sandbox removes only its own dirs | symlink pointing outside the root ⇒ refused; the root itself ⇒ refused; an `fs.rm` call outside `safefs.js` fails lint |
| E11–E14 | unit vectors ported from tryboxi `output_test.go`; `core/test/integration/wb.test.js` gains: progress-bar output collapses, a binary log is flagged, `networkBlocked` lists a denied host, `changedFiles` lists a file the run wrote, `oomKilled` is true after an in-box OOM; `node docs/check.mjs` fails on a stale agent guide | box-supplied `networkBlocked`/`changedFiles`/`oomKilled` in the envelope ⇒ rejected; truncation never alters the CAS digest; `agent-rules install` over an existing file leaves a backup |
| E15/E16 (if taken) | ported `intercept_test.go`/`egress_test.go`/`workspace_test.go` vectors; a real TLS round-trip through the proxy to a local HTTPS server with a bound secret; sync → edit in the box → apply → undo on a real git repo | placeholder sent to an unbound host or over cleartext ⇒ refused + audit; echoed secret scrubbed; a stored value in exec argv ⇒ rejected; apply with `..`, an escaping symlink or a `.git/` path ⇒ rejected; pull over a host file changed since sync ⇒ refused without force |

Concurrency/isolation test gap to close in P0-2: two live sandboxes simultaneously — separate
uppers, separate cgroups, killing one leaves the other `READY` (no such test exists today).

## 7. Acceptance criteria — exact commands

Global gate (must pass at the end of **every** task commit, on a bare host for integration):

```bash
pnpm install --frozen-lockfile
node scripts/check-tests.mjs
pnpm lint
pnpm fmt:check
pnpm test:coverage   # 90 lines / 80 branches / 90 functions over packages/*/src
```

Per item (spec `verify_cmd` verbatim where one exists; run from `/root/workbox` as root on a
host passing `workbox doctor`):

| Item | Command | Pass condition |
|---|---|---|
| P0-0 (1.4) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/sessions.test.js` and `node --test 'packages/runner/test/unit/*.test.js' 'packages/core/test/unit/sandbox/*.test.js'` | exit 0; the 3 deterministic failures gone; `exec` importable from `@workbox/core`; closes unresolved #1 for 1.3+1.4 and #2 (export landed) |
| P0-1 (1.5) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/wb.test.js` | exit 0; `wb tools --json` lists status/tools/help/session/run; evidence row + CAS artifact present with matching SHA-256 |
| P0-2 (1.6) | `node scripts/check-tests.mjs && node --test packages/cli/test/integration/cli.test.js` | exit 0 incl. kill/restart/reconcile and the two-sandbox isolation test |
| P0-3 (2.1) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/network.test.js` | exit 0 across none/egress/allowlist incl. all §6 negatives |
| P0-4 (2.2) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/seccomp.test.js` | exit 0; every denylisted syscall `EPERM`; `Seccomp: 2` in-box |
| P0-5 (2.3) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/broker.test.js` | exit 0; secret-value grep across DB/audit/spool/fs returns nothing |
| P0-6 (2.4) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/presets.test.js` | exit 0; manifest in-box and in host store agree byte-for-byte on versions+digests |
| P0-7 (2.5) | `node scripts/check-tests.mjs && node --test packages/core/test/integration/pty.test.js` | exit 0; `isatty` + resize proven |
| P0-8 (3.1) | `node scripts/check-tests.mjs && node --test 'packages/server/test/**/*.test.js'` | exit 0 (spec says `packages/server/test/*.test.js`; plan uses the same `test/unit|integration` layout as every other package, so the glob is `**` — flag for a spec-wording sync, behaviour is stricter) |
| P0-8 (3.2) | `node scripts/check-tests.mjs && node --test 'packages/sdk/test/**/*.test.js'` | exit 0; every server route exercised through the SDK |
| P0-8 (3.3) | `node scripts/check-tests.mjs && node --test 'packages/mcp/test/**/*.test.js'` | exit 0; tool list exactly `sandbox_create,sandbox_list,sandbox_exec,sandbox_destroy` |
| P0-8 (3.4) | `node scripts/check-tests.mjs && node --test packages/cli/test/integration/remote.test.js` | exit 0; local-mode CLI tests from P0-2 still pass unchanged (backward compat) |
| P0-9 (4.1) | `bash deploy/check.sh` | exit 0; unit + Dockerfile validated; `workbox doctor` every probe pass/fail with a remedy |
| P0-9 (4.2) | `node docs/check.mjs` | exit 0; generated `docs/wb.md` current; all links resolve |
| P0-9 (4.3) | `node scripts/check-tests.mjs && node --test 'test/e2e/*.test.js'` | exit 0; `docs/measurements.md` rewritten with measured p50/p95 + RSS from the run (values recorded, not asserted) |
| Final | `pnpm test` (check-tests + all packages + e2e), then `git status --short` | exit 0 on a bare host; tree clean except intended task commits; spec task statuses flipped only for tasks whose row above passed |

Definition of done for the whole plan: every req AC in spec.kvx 1.1–8.4 is either proven by a
named test above or explicitly listed as a documented deviation (today the only planned
deviation is the req 1.6 ptrace wording, §P0-4). Expansions E1–E16 are done only when their
own tests join the same gates; none may weaken a P0 acceptance row.

## 8. Sequencing summary

```text
P0-0 land 1.4 (+H2/H3/H4/H7 fixes, exec export)
  -> P0-1 wb base + broker/outbox/fs (+H1, H5, H8)
  -> P0-2 manager/reconcile/CLI-local (+H6 tokens, H10, H11, H14)
  -> P0-3 network/proxy (+H13)  |  P0-4 seccomp  |  P0-5 broker full  |  P0-7 PTY   (parallel-eligible after 1.6)
  -> P0-6 presets + @ host sets (needs P0-3 egress)
  -> P0-8 server (+H15) -> SDK -> MCP + CLI-remote (first e2e lands with server)
  -> P0-9 deploy + docs + density e2e
  -> E1..E14 expansions, each behind its P0 parent's green gate
  -> E15/E16 only after an owner decision (E16 also needs a new spec req)
```

Risks to the plan itself: (1) all bare-host numbers are unproven until P0-0's gate runs off
this sandbox — if committed 1.3 fails there, P0-0 grows and everything shifts right;
(2) `node-pty` reproducibility (P0-7 fallback noted); (3) slirp4netns/nft availability is a
doctor probe, not an assumption — P0-3 cannot start on a host failing it.

