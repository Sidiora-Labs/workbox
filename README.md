# Workbox

A production sandbox for AI agents whose primary interface is the shell.

Each sandbox is a namespaced, capability-limited, cgroup-bounded process tree on a private
writable overlay of a shared read-only rootfs. Inside it runs a small supervisor and the `wb`
toolkit, so an agent discovers and uses everything through commands and `--help` rather than
through fixed tool schemas. The host exposes lifecycle and exec over REST, WebSocket, a JS SDK,
an MCP server and an operator CLI.

The single source of truth for scope, acceptance criteria and the task plan is
[`spec/workbox/spec.kvx`](spec/workbox/spec.kvx). Documentation lives under [`docs/`](docs/).
