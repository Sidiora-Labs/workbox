# Use the MCP server

`workbox-mcp` is a stdio MCP server built on the SDK. It talks to a running
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
version. The token needs `admin` for `sandbox_create`, `sandbox_destroy` and for `agent_run` when it
creates a sandbox, `read` for `sandbox_list`, and `exec` for `sandbox_exec`, `agent_run` and
`agent_output`.

## Tools

| Tool              | Arguments                                                                                     | Result                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `sandbox_create`  | `name`, `rootfs`, `networkMode` (`none`, `egress`, `allowlist`), `allow` (up to 64 hostnames) | The sandbox id, once it is ready                                                        |
| `sandbox_list`    | `limit` (1 to 100), `cursor`                                                                  | One page of sandboxes with state and health                                             |
| `sandbox_exec`    | `sandboxId`, `command` (a shell command), `timeoutMs` (at most 240000)                        | Exit code, stdout and stderr, each capped at 64 KiB; any cut is reported in `truncated` |
| `sandbox_destroy` | `sandboxId`                                                                                   | Destroys the sandbox and deletes its writable layer                                     |

`allow` is accepted only with `networkMode` set to `allowlist`. Arguments are checked against each
tool's input schema before anything is sent. Everything else is a command the agent finds inside
the box with `wb tools` and `--help`; see the [wb reference](../wb.md).

## Agent tools

`agent_run` and `agent_output` let an MCP client hand a task to Claude Code or Codex running inside
a sandbox built from the `agents` rootfs. See [Run coding agents in a sandbox](agents.md) for the
rootfs and credentials.

| Tool           | Arguments                                                                                                                                                                          | Result                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `agent_run`    | `agent` (`claude` or `codex`), `prompt`, `sandboxId` (reuse a sandbox), `name`, `networkMode` (default `allowlist`), `allow`, `secretRefs` (up to 8), `timeoutMs` (at most 240000) | The run, as below                       |
| `agent_output` | `sandboxId`, `sessionId`, `timeoutMs` (default 0, at most 240000)                                                                                                                  | The same run, read again from the start |

Both return `{sandboxId, sessionId, running, exitCode, signal, output, truncated}`. `output` is the
last 64 KiB of the combined stdout and stderr. If the agent is still working when `timeoutMs`
passes, `running` is true and the session keeps going; call `agent_output` to wait for it.
`exitCode` and `signal` are set once it exits.

Without `secretRefs`, `agent_run` grants the agent's default credential: `ANTHROPIC_API_KEY` for
Claude Code, and `OPENAI_API_KEY` passed as `CODEX_API_KEY` for Codex. Pass `secretRefs: []` to
grant none.
