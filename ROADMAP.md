# Roadmap

Planned direction, without dates.

## Now

- A full Hyperfide provider: a capability endpoint, a lifetime model, and complete coverage of
  the operations in the [provider mapping](docs/hyperfide-provider.md).
- Pushed sandbox events. Events are paged by polling today; only session output is streamed.

## Next

- Per-sandbox subordinate uid ranges through idmapped mounts, so inner root of one sandbox no
  longer shares a host uid with every other.
- Argument filtering for `clone`, `clone3` and `personality` in the seccomp program, and seccomp
  on architectures other than x86_64.
- Idle expiry for sandboxes. Today they run until destroyed.

## Later

- TLS in the server.
- High availability and live migration across hosts.
- Lower runner memory per sandbox; see [docs/measurements.md](docs/measurements.md).

## Non-goals

- Docker or a microVM at runtime. Docker is used only to build the root filesystem.
- TypeScript, a bundler or a build step.

Proposals are welcome through the feature request form.
