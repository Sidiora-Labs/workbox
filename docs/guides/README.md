# Guides

Step-by-step guides, each starting from a checkout of this repository. For lookups, see the
[reference](../reference/README.md); for the design, the [architecture](../architecture.md) and
the [security model](../security.md).

- [Getting started](getting-started.md): install the host, build a rootfs, serve, and run a first command.
- [Use the SDK](sdk.md): create sandboxes, run commands, stream a session and page events from JavaScript.
- [Get notified with webhooks](webhooks.md): signed calls to your endpoint when a build finishes or fails, with retries.
- [Run coding agents in a sandbox](agents.md): Claude Code and Codex with `workbox agent`.
- [Use the MCP server](mcp.md): point an MCP client at a Workbox server.
- [Deploy the server](deploy.md): run `workbox serve` under systemd or in the server image.
- [Give an agent API access](remote-agents.md): let an agent on another machine build, read files and get notified with only a URL and one key.
