# Governance

Workbox is maintainer-led.

## Roles

**Contributors** report issues, improve documentation, propose designs and submit code. A focused
pull request needs no prior permission.

**Reviewers** are regular contributors who review changes in an area they know well. Their review
is advisory unless a maintainer gives them merge rights.

**Maintainers** own releases, security response, repository settings, moderation and merge
decisions. They are listed in [MAINTAINERS.md](MAINTAINERS.md).

Contributors who sustain good work may be invited to become reviewers or maintainers.

## Decisions

- Fixes and documentation changes go through normal pull request review.
- Changes to the isolation boundary, the wire protocol, the REST or MCP interface, the `wb`
  command set or the on-disk layout start with a design issue.
- Maintainers aim for consensus and record the reasoning in the issue or pull request. When
  consensus is not reached, the maintainers decide.
- Security decisions may stay private until disclosure is safe.

The [roadmap](ROADMAP.md) shows direction, not commitments or dates.

## Compatibility

The `wb` command set, the protocol between host and runner, the REST and WebSocket routes, the MCP
tools and the on-disk sandbox layout are interfaces other code depends on. An incompatible change
needs a new protocol version where the protocol is affected, a migration path for existing
sandboxes, and a changelog entry.

## Changes to this document

Governance changes are made by pull request and need a maintainer's approval.
