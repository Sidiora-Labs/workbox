# Run coding agents in a sandbox

Workbox can run Claude Code or Codex inside a sandbox. Both come preinstalled in the `agents`
rootfs and are set up to work without permission prompts, since the sandbox is the boundary. This
guide assumes a running server ([Getting started](getting-started.md)).

## Build the agents rootfs

```sh
workbox rootfs build agents
```

The `agents` rootfs is the `minimal` rootfs plus Node 22.23.4, Claude Code 2.1.312 and Codex
0.165.0. It needs Docker to build and takes about 1.1 GB on disk. Every sandbox shares it
read-only, so nothing is downloaded when a sandbox starts.

## Give the agent a credential

Add the key to the host's secrets file, `/etc/workbox/secrets.json` (mode 0600), then restart
`workbox serve` so it loads the change:

```json
{ "ANTHROPIC_API_KEY": "<key>", "OPENAI_API_KEY": "<key>" }
```

| Agent       | Secret                    | Notes                                                                        |
| ----------- | ------------------------- | ---------------------------------------------------------------------------- |
| Claude Code | `ANTHROPIC_API_KEY`       | The default for `workbox agent claude`.                                      |
| Claude Code | `CLAUDE_CODE_OAUTH_TOKEN` | A subscription token from `claude setup-token`; select it with `--secret`.   |
| Codex       | `OPENAI_API_KEY`          | The default for `workbox agent codex`; Codex receives it as `CODEX_API_KEY`. |

The key is passed only to the agent's process, and registered secret values are redacted from
session output and logs. To sign in inside the sandbox instead, pass `--no-secret` and run
`/login` in Claude Code, or `codex login --device-auth`.

## Run an agent

With `S='--server http://127.0.0.1:8790'`:

```sh
workbox agent claude $S                                  # interactive, in this terminal
workbox agent codex -p "Add a test for parse()" $S        # one task, output streamed
workbox agent claude --detach -p "Fix the build" $S       # prints {sandboxId, sessionId}
workbox sandbox attach <sandbox-id> <session-id> $S       # replay and follow that session
```

Without a sandbox id, `workbox agent` creates a sandbox and prints its id; it keeps running after
the agent exits. Pass the id to run again in the same sandbox:

```sh
workbox agent claude <sandbox-id> $S
```

The agent starts in `/workspace`. To give it a repository, clone it there, for example with
`workbox sandbox exec <sandbox-id> $S -- git clone <url> /workspace/repo`, or write files with the
[SDK](sdk.md#files).

The exit code of `workbox agent -p` is the agent's own.

## Network

By default the sandbox uses an allowlist: the agent's API and sign-in hosts (`@anthropic` or
`@openai`), plus `@github`, `@node` and `@python` so it can fetch code and packages. Change it when
creating the sandbox:

- `--allow <host or @set>` adds entries; repeat it for more.
- `--network egress` allows any public address.
- `--network none` cuts the sandbox off entirely.

Run agents through `--server`. The server keeps each sandbox's network proxy running; a local
`workbox agent` without `--server` stops it when the command exits, so `--detach` without
`--server` is refused unless the network is `none`.

## From an MCP client

The MCP server's `agent_run` and `agent_output` tools do the same from another agent: hand a task
to Claude Code or Codex in a sandbox and read its output. See
[the MCP guide](mcp.md#agent-tools).

## Security

The agent runs as root inside its sandbox and can read its own credential. The allowlist limits
where it can send it. For interactive Claude Code with an API key, the last 20 characters of the
key are recorded in the sandbox's `~/.claude.json`, so that Claude Code accepts the key without
asking. See [the security model](../security.md).
