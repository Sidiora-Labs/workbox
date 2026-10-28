# Guides

Task-oriented walkthroughs. Each one starts from a working checkout of this repository and says
what it assumes. For lookups, use the [reference](../reference/README.md); for the reasoning behind
the design, the [architecture](../architecture.md) and the [security model](../security.md).

- [Getting started](getting-started.md): install the host, build a rootfs, serve, and run a first command.
- [Use the SDK](sdk.md): create sandboxes, run commands, stream a session and page events from JavaScript.
- [Use the MCP server](mcp.md): point an MCP client at a Workbox server.
- [Deploy the server](deploy.md): run `workbox serve` under systemd or in the server image.
