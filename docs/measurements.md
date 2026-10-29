# Measurements

Recorded by `test/e2e/lifecycle.test.js`: 20 sandboxes created concurrently through the SDK against a real server, on the host below. These are measurements, not performance targets.

## Host

| Field | Value |
|---|---|
| Date | 2026-10-29T20:23:45.335Z |
| Revision | 5ec2211e998bcce6525e9624ba21706cd3fee5d7 plus uncommitted working-tree changes |
| Kernel | Linux 6.8.0-147-generic x64 |
| CPUs | 8 (AMD EPYC Processor (with IBPB)) |
| Memory | 23.5 GiB |
| Load average before the creates (1/5/15 min) | 4.87 / 3.07 / 2.15 |
| Node | v22.22.2 |
| Network mode | none (Manager network setup off) |

## Results

Create-to-ready is the SDK `createSandbox` round trip until the server answers with the READY row. Runner RSS is VmRSS from /proc/<pid>/status of the runner process in each sandbox's cgroup; cgroup memory is that cgroup's memory.current. Both are sampled once with all 20 sandboxes READY and idle. Percentiles are nearest-rank over the 20 sandboxes.

| Metric | p50 | p95 | max |
|---|---|---|---|
| create-to-ready (ms) | 842 | 1088 | 1144 |
| runner RSS per sandbox (MiB) | 50.1 | 50.1 | 50.2 |
| cgroup memory.current per sandbox (MiB) | 11.9 | 12.1 | 12.2 |

Server process RSS (test process hosting server and Manager) at measurement: 87.4 MiB.
