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
Other systemd hardening options break the launch chain; the comments in the unit say which ones
and why, so read them before adding any. Sandboxes keep running when the
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

## Expose the API to remote agents

An agent on another machine needs two things: the server's URL and one key. Serve the API over
TLS, either from Workbox itself or from a reverse proxy in front of it. Do not expose plain HTTP:
bearer tokens and file contents would cross the network in clear text, and `workbox serve` warns
on stderr when it listens beyond loopback without TLS.

### Built-in TLS

Give the server a certificate for its public name and listen on a reachable address:

```json
{
  "host": "0.0.0.0",
  "port": 8790,
  "serverNames": ["workbox.example.com"],
  "tls": { "certFile": "/etc/workbox/tls/fullchain.pem", "keyFile": "/etc/workbox/tls/key.pem" },
  "keys": [
    { "id": "agent-1", "tokenSha256": "<hex sha-256 of the token>", "scopes": ["read", "exec"] }
  ]
}
```

Start it with `workbox serve --config /etc/workbox/serve.json` (or pass `--tls-cert` and
`--tls-key`). Flags outrank the file, so under systemd replace `--host 127.0.0.1 --port 8790` in
`ExecStart` with `--config /etc/workbox/serve.json`. The startup line shows the `https://`
address. The certificate can come from an ACME client such as certbot or from a private CA. After
a renewal, send the server a SIGHUP to load the new files without a restart
([Operations](../operations.md#reload-the-tls-certificate)). Allow the port through the host's
firewall.

### Behind a reverse proxy

Keep `workbox serve` on `127.0.0.1` and let a proxy terminate TLS. With Caddy, which obtains and
renews the certificate itself and passes WebSocket upgrades through:

```
workbox.example.com {
	reverse_proxy 127.0.0.1:8790
}
```

Caddy forwards the original `Host`, so list the public name in `serverNames`. The server counts
failed authentications per client address, and behind a proxy every client has the proxy's
address: one client sending bad tokens can delay the others by up to a minute.

### Keys and clients

- Give each remote client its own key with only the scopes it needs (`read` and `exec` for an
  agent that runs builds and reads files; `admin` only for one that creates and destroys
  sandboxes). Store `tokenSha256`, not the token, in the config file, and hand the token to that
  one client. Removing its key and restarting revokes that client alone.
- The client uses `https://workbox.example.com:8790` (or the proxy's URL) as `--server`, as the
  SDK's `baseUrl` or as `WORKBOX_SERVER`; session WebSockets follow as `wss://`. A client trusts a
  certificate from a private CA through Node's `NODE_EXTRA_CA_CERTS`, a PEM file of extra CA
  certificates.
- After 20 failed authentications within 60 s, a client address gets 429 `E_LIMIT` with
  `Retry-After` until the 60 s are over.

`deploy/check.sh` validates the deployment assets and this host; see [Testing](../verification.md).
