# Use the MCP server

`workbox-mcp` is a stdio MCP server with exactly four tools, over the SDK. It talks to a running
Workbox server; start one first ([Getting started](getting-started.md#4-serve)).

## Configure

| Variable         | Meaning                         | Default                 |
| ---------------- | ------------------------------- | ----------------------- |
| `WORKBOX_SERVER` | Base URL of the Workbox server  | `http://127.0.0.1:8790` |
| `WORKBOX_TOKEN`  | Bearer token the server accepts | empty                   |

In an MCP client that launches stdio servers, point the command at the checkout:

```json
{
  "mcpServers": {
    "workbox": {
      "command": "node",
      "args": ["/path/to/workbox/packages/mcp/src/main.js"],
      "env": { "WORKBOX_SERVER": "http://127.0.0.1:8790", "WORKBOX_TOKEN": "<token>" }
    }
  }
}
```

The exact configuration file and key names depend on the client. `workbox-mcp --version` prints the
version. The token needs `admin` for create and destroy, `read` for list and `exec` for exec.

## Tools

| Tool              | Arguments                                                                                     | Result                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `sandbox_create`  | `name`, `rootfs`, `networkMode` (`none`, `egress`, `allowlist`), `allow` (up to 64 hostnames) | The sandbox id, once it is ready                                                        |
| `sandbox_list`    | `limit` (1 to 100), `cursor`                                                                  | One page of sandboxes with state and health                                             |
| `sandbox_exec`    | `sandboxId`, `command` (a shell command), `timeoutMs` (at most 240000)                        | Exit code, stdout and stderr, each capped at 64 KiB; any cut is reported in `truncated` |
| `sandbox_destroy` | `sandboxId`                                                                                   | Destroys the sandbox and deletes its writable layer                                     |

`allow` is accepted only with `networkMode` set to `allowlist`. Arguments are validated against each tool's input schema before anything is sent. The tool
surface is deliberately only lifecycle and exec: everything else is a command the agent discovers
inside the box with `wb tools` and `--help`; see the [wb reference](../wb.md).
