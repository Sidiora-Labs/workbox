# Maintainers

This file lists who is responsible for Workbox, what they own, and how maintainership works. It is
the authoritative record; if GitHub permissions and this file ever disagree, this file wins and
permissions get corrected.

## Current maintainers

| Role                         | Areas                                                                  |
| ---------------------------- | ---------------------------------------------------------------------- |
| Repository owner, maintainer | Everything; final say on architecture, releases and the spec (`spec/`) |

The owner is the account that owns this repository on GitHub. Contact for project matters is
through the repository: open an issue, or for anything private use the channels in
[SECURITY.md](SECURITY.md).

## What maintainers do

- Review and merge pull requests
- Triage issues and label them honestly, including closing ones that will not be worked on
- Cut releases and write release notes; nothing is a release until a tag exists, and none does yet
- Handle security reports per [SECURITY.md](SECURITY.md)
- Enforce the [code of conduct](CODE_OF_CONDUCT.md)
- Keep the documents under `docs/` truthful as the code evolves; `node docs/check.mjs` gates the
  generated `wb` reference and every relative link
- Keep task `status` lines in `spec/workbox/spec.kvx` backed by evidence

## Decision making

Day-to-day decisions are made in issues and pull requests by whoever is doing the work, subject to
review. Anything that changes an external contract gets extra scrutiny before merge:

- The `wb` command set and its `--json` output
- The NDJSON protocol and its method catalogue
- REST and WebSocket routes, scopes and error codes
- The four MCP tools and their schemas
- `workbox` CLI flags, output and exit codes
- Configuration names and environment variables
- The on-disk sandbox layout, the store schema and the audit chain format
- The isolation boundary: capability set, seccomp program, network policy and the host-namespace
  guard

Disagreements are resolved by discussion first. If discussion stalls, the owner decides. Decisions
are recorded in the relevant issue so they do not have to be re-argued from memory.

## Becoming a maintainer

There is no application form. Maintainers are invited after a track record of:

- Several merged contributions of real substance, not just typo fixes
- Review comments on other people's pull requests that demonstrate understanding of the codebase
- Reliability: doing what you said you would do, on roughly the timeline you said

## Stepping down

Maintainers can step down at any time by updating this file. A clean handoff is worth far more than
a lingering absent name. Maintainers inactive for 12 months will be moved to emeritus status after a
check-in.

## Emeritus

None yet.
