# Frequently asked questions

## Is Workbox a container runtime?

No. A sandbox is a bubblewrap-launched process tree inside a user namespace, bounded by cgroup v2
and with a private overlay over a shared read-only rootfs. Docker is used only to build the base
rootfs. See the [architecture](architecture.md#launch-chain).

## Is it a hypervisor-grade boundary?

No. Sandboxes share the host kernel. The [security model](security.md) lists what is enforced and
the [stated limits](security.md#stated-limits) list what is not, including the shared subordinate
uid range and the x86_64-only seccomp filter.

## Why a shell instead of tool schemas?

The agent's primary interface is the shell, so the harness only needs exec and lifecycle. What a
box cannot do alone is a `wb` subcommand the agent finds with `wb tools` and `--help`. See the
[wb reference](wb.md) and [Why Workbox?](why-workbox.md).

## Which hosts does it run on?

One Linux host with cgroup v2 and user namespaces, driven by a root daemon. There is no macOS or
Windows support, no multi-host scheduling, no HA and no TLS in v1. `workbox doctor` checks a host.
See [project status](project-status.md#supported-host).

## How does an agent reach the network?

By the sandbox's network mode: `none`, `egress` or `allowlist`. In `allowlist` mode hostname
rules bind only clients that honour `HTTP_PROXY` and `HTTPS_PROXY`; other traffic is dropped. The
default mode is `egress`. See the [network section of the security model](security.md#network).

## Does it call models?

No. It runs the commands an agent issues; the agent brings its own model access.

## How do secrets work?

A secret is a named reference the daemon holds. `wb secret exec <ref>... -- <cmd...>` injects the
value into that child's environment only, and registered values are redacted from logs. Once
injected, a value is readable by any process in the box under the same uid. See
[Secrets](security.md#secrets).

## What survives a daemon restart?

Sandboxes are detached from the daemon and keep running. `workbox serve` reconciles at start and
reattaches what is still alive. See [Reconcile after a restart](operations.md#reconcile-after-a-restart).

## Can the CLI and the server drive the same root at once?

No. One engine drives a Workbox root at a time; a local `workbox sandbox` command next to a running
server exits 4 and names the holder. Use `--server` to go through the server. See
[Operations](operations.md#run-the-server).

## Is there a Hyperfide adapter?

Not yet. [The provider mapping](hyperfide-provider.md) shows which Workbox endpoint an adapter
would call for each provider operation, and which operations are not covered.

## Where are the numbers for create time and memory?

[Measurements](measurements.md), recorded by the end-to-end suite.
