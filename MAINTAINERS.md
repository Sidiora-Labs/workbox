# Maintainers

Workbox is maintained by the owner of this repository. To reach the maintainers, open an issue;
for security reports, follow [SECURITY.md](SECURITY.md).

## Responsibilities

- Review and merge pull requests
- Triage issues
- Cut releases and write release notes
- Handle security reports
- Enforce the [code of conduct](CODE_OF_CONDUCT.md)
- Keep the documentation in `docs/` up to date with the code

## Interfaces that need extra review

Changes to these affect code outside this repository:

- The `wb` command set and its `--json` output
- The host–runner protocol and its method catalogue
- REST and WebSocket routes, scopes and error codes
- The MCP tools and their schemas
- `workbox` CLI flags, output and exit codes
- Configuration keys and environment variables
- The on-disk sandbox layout, the store schema and the audit log format
- The isolation boundary: capability set, seccomp program, network policy and the host-namespace
  guard

## Becoming a maintainer

Maintainers are invited based on a record of substantial contributions and helpful reviews.
