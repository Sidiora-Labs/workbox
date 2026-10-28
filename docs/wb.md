# wb reference

Generated from `wb tools --json` by docs/gen-wb.mjs — do not edit by hand.
Every subcommand accepts `--help` and `--json`. Diagnostics go to stderr.
Exit codes: 0 ok, 1 internal, 2 usage, 3 not found, 4 denied/unavailable, 5 timeout.
`wb run` propagates the wrapped command exit code.

| Command | Summary | Usage |
|---|---|---|
| `status` | Sandbox id, boot id, limits, usage and network mode | `wb status [--json]` |
| `tools` | List every wb subcommand | `wb tools [--json]` |
| `help` | Show help for wb or one subcommand | `wb help [command]` |
| `session` | Durable sessions: start|list|attach|input|stop | `wb session start [--name n] [--cwd d] [--env K=V] [--pty] -- <cmd...>` |
| `run` | Run a command and record an evidence envelope | `wb run -- <cmd...>` |
| `ask` | Ask a human: raise|status|list|wait | `wb ask raise --kind question|decision|permission|secret [--option o] <title>` |
| `secret` | Brokered secrets: exec|list (values injected into the child only) | `wb secret exec <ref>... -- <cmd...> | wb secret list` |
| `event` | Append a structured event | `wb event emit <type> [json]` |
| `lease` | Lease status|renew | `wb lease status | wb lease renew [--ttl-ms n]` |
| `checkpoint` | Checkpoint create|list | `wb checkpoint create [--name n] | wb checkpoint list` |
| `artifact` | Artifacts: put|get|list | `wb artifact put <file> | get <sha256> [dest] | list` |
| `net` | Network policy|test | `wb net policy | wb net test <host> <port>` |
| `preset` | Toolchain presets: list|install | `wb preset list | wb preset install <web|python|rust|go|system|agents>` |
