## Problem and contract

<!-- What is wrong or missing, and what observable contract does this change establish? -->

## Change

<!-- Summarize the implementation. Keep unrelated cleanup out of this PR. -->

## Compatibility and migration

<!-- Cover the protocol version, REST routes, wb --json output, MCP tools, CLI flags, the on-disk sandbox layout, and existing sandboxes. Write "none" only after checking. -->

## Authority and security

<!-- Identify changes to capabilities, seccomp, namespaces, cgroups, network policy, the host-namespace guard, secrets, leases, artifacts, or the API scopes. -->

## Evidence

<!-- List exact commands and results. Say which of them could not run on your machine and why. -->

- [ ] `make check` passes.
- [ ] `make unit-unprivileged` passes.
- [ ] `make test` passes on a prepared host for changes to the launch chain, cgroups, network, or a surface.
- [ ] New behavior has positive and negative coverage, on real code paths.
- [ ] User-visible changes are documented; `node docs/gen-wb.mjs` was run after a change to the wb command table.
- [ ] No secret, token, audit data, or machine-specific file is included.
- [ ] I read and will follow the Code of Conduct.

## Deliberately out of scope

<!-- State what this PR does not prove or implement. -->
