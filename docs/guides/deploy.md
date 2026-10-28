# Deploy the server

Two ways to keep `workbox serve` running. Both need the host prepared first
([Getting started](getting-started.md#2-prepare-the-host)), with the rootfs and runtime installed.

## systemd

`deploy/workbox.service` runs the daemon as root:

```
ExecStart=node /opt/workbox-src/packages/cli/src/main.js serve --host 127.0.0.1 --port 8790
```

1. Put a checkout (with `pnpm install` done) at `/opt/workbox-src`, or edit `ExecStart` to where it
   lives.
2. Create `/etc/workbox/workbox.env` holding `WORKBOX_TOKEN=<token>` or
   `WORKBOX_API_KEYS=<json array>`. The unit reads it with `EnvironmentFile=-/etc/workbox/workbox.env`
   and sets `WORKBOX_ROOT=/var/lib/workbox`.
3. Install and start it:

```sh
cp deploy/workbox.service /etc/systemd/system/workbox.service
systemctl daemon-reload
systemctl enable --now workbox
```

The unit sets `Restart=on-failure`, `ProtectSystem=full`, `PrivateTmp=yes` and `NoNewPrivileges=yes`.
The comments in the unit list each hardening option it deliberately leaves out and which step of
the launch chain it would break; read them before adding any. Sandboxes keep running when the
daemon stops, and `serve` reconciles them at start
([Operations](../operations.md#reconcile-after-a-restart)).

## Container image

`deploy/Dockerfile.server` builds a server image from the repository root:

```sh
docker build -f deploy/Dockerfile.server -t workbox-server .
```

The container must run privileged with the host cgroup namespace, because the daemon maps a
subordinate uid range, writes cgroup v2 files, mounts overlayfs, runs bubblewrap and installs
nftables rules:

```sh
docker run --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v workbox:/var/lib/workbox -e WORKBOX_TOKEN=<token> -p 127.0.0.1:8790:8790 workbox-server
```

Docker is not inside the image: build the rootfs on the host into the mounted Workbox root. With
`--cgroupns=host` the subordinate range 300000 to 365535 is the host's, so keep it out of every
other user's `subuid` entry.

## Before exposing it

The server has no TLS. Keep it on loopback or a trusted network, or put a TLS-terminating proxy in
front and add the name it forwards to `serverNames` in the serve config
([Operations](../operations.md#run-the-server)). `deploy/check.sh` validates the deployment assets
and this host; see [Verification](../verification.md).
