# Roadmap

This roadmap communicates direction. It is not a delivery schedule, support commitment, or promise
that every item will ship unchanged. Every item below is a limit or gap the project already states
in [docs/security.md](docs/security.md#stated-limits) or
[docs/hyperfide-provider.md](docs/hyperfide-provider.md); nothing here is a release date.

## Now: close the stated gaps

- Fill the gaps in the Hyperfide provider mapping: a capability profile endpoint and a lifetime
  model, and the partially mapped operations. Until then Workbox is not usable as a Hyperfide
  provider.
- Stream sandbox events. Events are paged by polling today; only session output is streamed.

## Next: deepen isolation

- Per-sandbox subordinate uid ranges through idmapped mounts, so inner root of one sandbox no
  longer shares a host uid with every other.
- Argument filtering for `clone`, `clone3` and `personality` in the seccomp program, and seccomp
  on architectures other than x86_64.
- A sandbox lifetime model: sandboxes have no idle expiry today and run until destroyed.

## Later: operate at scale

- TLS in the server, beyond loopback and a fronting proxy.
- High availability and live migration. Workbox is a single-host system today.
- Lower runner memory per sandbox. Measured density is recorded in
  [docs/measurements.md](docs/measurements.md).

## Explicit non-goals

- A Docker or microVM dependency at runtime. Docker is used only to build the base rootfs.
- TypeScript, a bundler or a transpile step.
- Web search, key-value memory and model calls inside the box in v1.
- Treating redaction or the audit chain as a guarantee beyond what
  [docs/security.md](docs/security.md) states.

Proposals are welcome through the structured feature form. A proposal should state the problem and
contract, not only a preferred implementation.
