# Operations runbook

## Bring-up

```sh
sudo sh deploy/install.sh
workbox doctor                 # every prerequisite pass/fail with a remedy
workbox rootfs build minimal
workbox runtime install
WORKBOX_TOKEN=$(openssl rand -hex 24) workbox serve --host 127.0.0.1 --port 8790
# or: systemctl enable --now workbox   (deploy/workbox.service)
```

Smoke test:

```sh
workbox sandbox create --name smoke
workbox sandbox exec <id> -- sh -c 'id; wb status --json; wb run -- echo hello'
workbox sandbox rm <id>
workbox audit verify
```

## Configuration

`loadConfig` resolves defaults → JSON file (`WORKBOX_CONFIG`) → environment (`WORKBOX_ROOT`, `WORKBOX_SECRETS_FILE`, `WORKBOX_UID_BASE`, `WORKBOX_CGROUP_PARENT`, `WORKBOX_NETWORK_MODE`, …) → explicit overrides. Unknown shapes fail closed with coded errors. Secrets live in `/etc/workbox/secrets.json` (0600, `{ "REF": "value" }`) or `WORKBOX_SECRET_<REF>` environment variables; grant a sandbox a ref at create time with `secretRefs`.

## API keys

`WORKBOX_TOKEN` becomes a full-access key for `workbox serve`. For scoped keys set `WORKBOX_API_KEYS` to a JSON array of `{"id", "tokenSha256", "scopes"}` (scopes: `read`, `exec`, `admin`, `answer`). Rotate by adding the new key, switching clients, then removing the old one.

## Observability

- `GET /metrics` (read scope): `workbox_http_requests_total{route,status}`, `workbox_sandboxes{state}`.
- Structured JSON logs on stdout (component-tagged); secret values are redacted.
- Audit: hash-chained NDJSON under `<root>/audit`. Verify with `workbox audit verify` after any incident or restore.
- `wb status`, `workbox sandbox inspect <id>`, `workbox sandbox events <id>` are the first three debugging commands.

## Failure handling

- Sandbox stuck `PROVISIONING`/`BOOTSTRAPPING`: read `sandboxes/<id>/launch.log`; `workbox doctor` re-checks the host.
- `QUARANTINED`: self-check failure or nonce replay. Inspect, then destroy (`workbox sandbox rm <id>`); quarantine never auto-retries.
- `DELETING` that never reaches `DELETED`: the cgroup would not empty; the row's `stateReason` carries the failure. Check cgroup processes, then retry the destroy.
- Daemon restart: `serve` reconciles on start. Live sandboxes reattach; `ABSENT` sandboxes are reported, never relaunched.
- Network wrong: `wb net policy` in-box shows the effective mode; `wb net test <host> <port>` probes. Proxy denials are audited on the host.

## Backup / restore (single host)

Stop the daemon, snapshot `<root>/workbox.db` (+ `-wal`), `<root>/audit`, `<root>/artifacts` and `<root>/checkpoints`. Restore to an empty root, run `workbox audit verify`, then start and reconcile. There is no HA claim in v1.
