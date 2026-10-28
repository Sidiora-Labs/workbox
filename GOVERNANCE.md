# Governance

Workbox is currently a maintainer-led project. This file describes the actual decision process; it
does not imply a foundation or voting body that does not exist.

## Roles

**Contributors** report issues, improve documentation, propose designs, or submit code. No prior
permission is required for a focused pull request.

**Reviewers** are trusted contributors who regularly provide technically sound review in a defined
area. Review is advisory unless a maintainer delegates merge authority.

**Maintainers** own releases, security response, repository settings, moderation, and final merge
decisions. They are listed in [MAINTAINERS.md](MAINTAINERS.md).

Sustained contributors may be invited to reviewer or maintainer roles based on judgment,
reliability, security awareness, constructive conduct, and demonstrated care for compatibility, not
contribution count alone.

## Decision process

- Focused fixes and documentation improvements use ordinary pull-request review.
- Changes to the isolation boundary, the wire protocol, the REST or MCP surface, the `wb` command
  set, or the on-disk layout begin with a public design issue.
- Scope and acceptance criteria are recorded in [spec/workbox/spec.kvx](spec/workbox/spec.kvx).
  Decisions the owner has ruled on are marked `RULED` there; changing one needs the owner's explicit
  approval, recorded in the issue or pull request.
- Maintainers seek rough consensus and record the rationale in the issue, spec, or pull request.
- When consensus is not possible, maintainers make the decision and document the tradeoff. Silence
  is not treated as consensus.
- Security decisions may remain private until coordinated disclosure is safe.

The [roadmap](ROADMAP.md) communicates direction, not entitlement to implementation or a delivery
date.

## Compatibility authority

The `wb` command set, the NDJSON protocol between host and runner, the REST and WebSocket routes,
the four MCP tools and the on-disk sandbox layout are contracts. A maintainer cannot merge an
incompatible change only because tests were updated to accept it. The protocol carries a version;
an incompatible change needs a new protocol version, a stated migration for existing sandboxes, and
a changelog entry.

## Conflicts of interest

Reviewers should disclose material conflicts and recuse themselves when they cannot review
impartially. A maintainer whose conduct is reported must not handle that report.

## Changes to governance

Governance changes use a public pull request and require explicit maintainer approval. As the
contributor base grows, this document should evolve toward named maintainers and clearer delegated
ownership rather than pretending those structures exist early.
