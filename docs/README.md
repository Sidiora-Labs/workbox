# Workbox documentation

## Evaluate Workbox

- [Why Workbox?](why-workbox.md): what it is for, what it is not, and how it differs from the alternatives it replaces.
- [Project status and compatibility](project-status.md): what is implemented, the supported host, and the current limits.
- [FAQ](faq.md): common architecture, security and adoption questions.
- [Security model and its limits](security.md): what is enforced, how, and what is not.
- [Measurements](measurements.md): recorded create times and per-sandbox memory from the end-to-end suite.

## Build and operate

- [Guides](guides/README.md): task-oriented walkthroughs.
  - [Getting started](guides/getting-started.md): from a checkout to a first command in a sandbox.
  - [Use the SDK](guides/sdk.md): drive sandboxes from JavaScript.
  - [Get notified with webhooks](guides/webhooks.md): signed, retried event deliveries to your endpoint.
  - [Run coding agents in a sandbox](guides/agents.md): Claude Code and Codex in the `agents` rootfs.
  - [Use the MCP server](guides/mcp.md): give an MCP client the sandbox and agent tools.
  - [Deploy the server](guides/deploy.md): systemd unit and container image.
- [Architecture](architecture.md): packages, host layout, launch chain, runner protocol, state machine.
- [Operations](operations.md): install, run, configure, observe, reconcile, recover, back up.
- [Testing](verification.md): the test suites and checks, and what they need from the host.

## Reference

- [Reference index](reference/README.md)
  - [Operator CLI](reference/cli.md): every `workbox` command, flag and exit code.
  - [REST and WebSocket API](reference/rest-api.md): routes, scopes and error shape.
  - [Configuration](reference/configuration.md): environment variables, files and defaults.
- [wb reference](wb.md): the in-box agent command, generated from its command table.
- [Hyperfide provider mapping](hyperfide-provider.md): how the surfaces cover Hyperfide's provider operations.

## Contribute

- [Contributing](../CONTRIBUTING.md), [support](../SUPPORT.md) and the [security policy](../SECURITY.md).
- [Changelog](../CHANGELOG.md) and [roadmap](../ROADMAP.md).

## Editing these docs

`node docs/check.mjs` fails when a required page is missing, when `wb.md` is out of date, when a
relative link or anchor does not resolve, or when a page is not linked from this index. `wb.md` is
generated: change the `wb` command table, then run `node docs/gen-wb.mjs`. `measurements.md` is
rewritten by the end-to-end suite; do not edit it by hand.
