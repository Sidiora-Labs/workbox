# Configuration

Workbox has two configuration files and a set of environment variables. Unknown keys, bad types
and out-of-range values fail closed with a coded error rather than being ignored.

## Engine configuration

`loadConfig` (`packages/core/src/config.js`) resolves, in order: the built-in defaults, the JSON
file named by `WORKBOX_CONFIG`, the environment variables below, then explicit overrides. The
file is a JSON object whose keys mirror the defaults.

| Key (file)             | Environment variable    | Default                     |
| ---------------------- | ----------------------- | --------------------------- |
| `root`                 | `WORKBOX_ROOT`          | `/var/lib/workbox`          |
| `secretsFile`          | `WORKBOX_SECRETS_FILE`  | `/etc/workbox/secrets.json` |
| `uid.base`             | `WORKBOX_UID_BASE`      | `300000`                    |
| `uid.count`            | `WORKBOX_UID_COUNT`     | `65536`                     |
| `cgroup.root`          | `WORKBOX_CGROUP_ROOT`   | `/sys/fs/cgroup`            |
| `cgroup.parent`        | `WORKBOX_CGROUP_PARENT` | `workbox`                   |
| `network.mode`         | `WORKBOX_NETWORK_MODE`  | `egress`                    |
| `network.allow`        |                         | empty list                  |
| `rootfs`               | `WORKBOX_ROOTFS`        | `minimal`                   |
| `runtime`              | `WORKBOX_RUNTIME`       | `current`                   |
| `limits.memoryBytes`   |                         | 2 GiB                       |
| `limits.swapBytes`     |                         | 0                           |
| `limits.cpuMillis`     |                         | 2000                        |
| `limits.pids`          |                         | 4096                        |
| `session.spoolBytes`   |                         | 8 MiB                       |
| `session.stopGraceMs`  |                         | 5000                        |
| `lease.ttlMs`          |                         | 300000                      |
| `events.retentionDays` |                         | 30                          |
| `bootTimeoutMs`        |                         | 20000                       |

Everything the engine stores is under `root`: `workbox.db`, `audit/`, `artifacts/`, `checkpoints/`,
`rootfs/`, `runtime/` and `sandboxes/`. The cgroup parent is `<cgroup.root>/<cgroup.parent>`.
A rootfs is shifted on disk for one uid base; using it under another base is refused, and
`workbox rootfs build` rebuilds it.

## Serve config file

`workbox serve --config file`. A JSON object with these keys only:

```json
{
  "host": "127.0.0.1",
  "port": 8790,
  "serverNames": ["workbox.example.internal"],
  "keys": [
    { "id": "agent", "tokenSha256": "<hex sha-256 of the token>", "scopes": ["read", "exec"] }
  ],
  "tls": { "certFile": "/etc/workbox/tls/cert.pem", "keyFile": "/etc/workbox/tls/key.pem" }
}
```

- `host` and `port` are used when the flags and `WORKBOX_PORT` do not set them: flags first, then
  `WORKBOX_PORT`, then the file, then `127.0.0.1:8790`.
- `serverNames` lists the `Host` names accepted besides `localhost`, `127.0.0.1` and `::1`; add the
  public name clients use, whether the server presents the certificate itself or a
  TLS-terminating proxy forwards that name.
- `keys` entries carry an `id`, a `tokenSha256` (or a plaintext `token`) and `scopes`
  (`read`, `exec`, `admin`, `answer`; what each allows is in the
  [REST API reference](rest-api.md#scopes)).
- `tls` turns on HTTPS and WSS. `certFile` is a PEM certificate chain (the server's certificate
  first) and `keyFile` its PEM private key; relative paths are resolved against the config file's
  directory. The flags `--tls-cert` and `--tls-key` override them, and both files must be given.
  The files are read at start and again on SIGHUP; a reload that fails keeps the old certificate
  ([Operations](../operations.md#reload-the-tls-certificate)).

Keys also come from the environment: `WORKBOX_TOKEN` defines one key with every scope; otherwise
`WORKBOX_API_KEYS` may hold a JSON array of keys. File and environment keys are combined. To
rotate a key, add the new one, restart, move clients over, remove the old one, restart.

## Other environment variables

| Variable               | Used by           | Meaning                                                                                                     |
| ---------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| `WORKBOX_TOKEN`        | `serve`, CLI, MCP | Server side: the single full-scope key. Client side: the bearer token for `--server` and for `workbox-mcp`. |
| `WORKBOX_SERVER`       | `workbox-mcp`     | Server URL; default `http://127.0.0.1:8790`.                                                                |
| `WORKBOX_PORT`         | `serve`           | Listen port when `--port` is absent.                                                                        |
| `WORKBOX_LOG_LEVEL`    | logger            | Log level; default `info`.                                                                                  |
| `WORKBOX_SECRET_<REF>` | daemon            | A secret value for reference `<REF>`; see below.                                                            |
| `NODE_EXTRA_CA_CERTS`  | CLI, SDK, MCP     | A PEM file of extra CA certificates Node trusts, for a server certificate signed by a private CA.           |

`deploy/install.sh` reads its own set (`WORKBOX_ETC`, `WORKBOX_SUBUID_FILE`, `WORKBOX_SUBGID_FILE`,
`WORKBOX_USER`, plus the root, cgroup and uid variables above); its header documents each.

## Secrets

Secrets live in `/etc/workbox/secrets.json` (`{"REF": "value"}`, which must not be group or world
readable) or in `WORKBOX_SECRET_<REF>` variables of the daemon. Values shorter than 8 characters are
refused. Grant references to a sandbox at create time with `secretRefs`; inside the box
`wb secret exec` injects them into a child process only. See [the security model](../security.md#secrets).
