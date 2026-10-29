# Give an agent API access

An AI agent running on another machine can create and use Workbox sandboxes with two things: the
server's URL and one API key. With them it can run builds, fetch data, read and write files, and
be told when a build finishes or fails, over HTTPS from `curl`, from a script it writes, or from
the [SDK](sdk.md).

The first half of this guide is for the operator of the Workbox host. The second half is for the
agent, and can be handed to it as is.

## Why a key and not SSH

An SSH login or a copy of the host's credentials gives the agent the host: every sandbox, the
secrets file, the database, and whatever else the host can reach. A Workbox key gives it the API
and nothing more:

- It reaches only the sandboxes that carry its label, and only with the scopes it was given.
- It can be revoked on its own, and it expires when its lifetime is up.
- The server keeps only its SHA-256 digest; the token is shown once, when it is made.
- Every request that changes something is written to the audit log under the key's id.

Nothing about the host has to be pasted into a chat: the agent gets a URL and a token through its
environment, the same way it gets any other API key.

## For the operator

### 1. Expose the server safely

Serve the API over TLS, either from `workbox serve` itself or from a reverse proxy in front of
it, and add the public name to `serverNames` so the server accepts requests addressed to it.
[Deploy the server](deploy.md#expose-the-api-to-remote-agents) has both setups. Do not expose
plain HTTP: the token and every file would cross the network in clear text.

Check from the agent's side that the server answers; this route needs no key:

```sh
curl -sS https://workbox.example.com:8790/healthz
# {"ok":true}
```

### 2. Mint a key bound to a label

On the host, next to the running server:

```sh
workbox key create --name dots --scope read --scope exec --scope admin \
  --label owner=dots --ttl 30d
```

```json
{
  "id": "key_01K8PR1C80HK8KXR88J34H4Z9Z",
  "name": "dots",
  "token": "wbk_...",
  "scopes": ["read", "exec", "admin"],
  "binding": { "labels": { "owner": "dots" } },
  "createdAt": 1761700000000,
  "expiresAt": 1764292000000
}
```

The token is printed only this once; the server cannot show it again. The key works at once,
without a restart. The same key can be made through the API (`POST /v1/keys` with `name`,
`scopes`, `labels` and `ttlSeconds`) or with `workbox key create --server URL` and an admin token.
`--ttl` takes a number followed by `s`, `m`, `h` or `d`.

What this key can do:

- Create sandboxes. Each one gets the label `owner=dots`, whether or not the request names it; a
  request that sets `owner` to another value is refused with 403.
- Run commands and background sessions, read and write files, download artifacts, and destroy
  the sandboxes it sees.
- Read the events of those sandboxes, by page, by long-poll or over a WebSocket, and register
  webhooks, which receive only those sandboxes' events.

What it cannot do:

- See or touch a sandbox without `owner=dots`. Such a sandbox answers 404, exactly like one that
  does not exist, on every route including the session and event WebSockets, and it is left out
  of every list.
- Use the fleet routes: `GET /metrics`, `POST /v1/reconcile` and the `/v1/keys` routes answer
  403, so it cannot mint, list or revoke keys.
- See or change webhooks made with another key.

Choose the scopes for the job. `admin` on a bound key is what lets it create and destroy
sandboxes and register webhooks; it still reaches only its own sandboxes. A key with only `read`
and `exec` works inside sandboxes the operator creates with the label (`POST /v1/sandboxes` with
`"labels": {"owner": "dots"}`). The full rules are in
[bound access](../reference/rest-api.md#stored-keys-and-bound-access).

A key that can create sandboxes can also grant them `secretRefs`, and the binding does not limit
which references it names. Keep in the host's [secrets file](../reference/configuration.md#secrets)
only values that every agent with such a key may use.

### 3. Hand the agent its access

Give the agent, through its environment or its secret store rather than a chat message:

- `WORKBOX_URL`, for example `https://workbox.example.com:8790`;
- `WORKBOX_TOKEN`, the `wbk_...` token;
- if the certificate comes from a private CA, that CA's certificate.

Then point it at the description of the API and at this guide. The server describes every route,
its scope and its request body at `GET /v1/openapi.json`, which needs no key; the same OpenAPI
3.1 document is kept in the repository as [openapi.json](../reference/openapi.json), and the
[REST API reference](../reference/rest-api.md#openapi-document) explains its extensions. A short
instruction is enough:

> A Workbox server is at `$WORKBOX_URL` and your key is in `$WORKBOX_TOKEN`. Its API is described
> at `$WORKBOX_URL/v1/openapi.json`; `docs/guides/remote-agents.md` in the Workbox repository
> shows how to run a build there. Destroy the sandboxes you create when you are done.

## For the agent

Every request carries the key as `Authorization: Bearer $WORKBOX_TOKEN`. Bodies are JSON, except
raw file uploads, whose body is the file. Errors are JSON as well:
`{"error": {"code": "E_NOT_FOUND", "message": "...", "requestId": "..."}}`. The routes are listed
in the [REST API reference](../reference/rest-api.md).

The examples build this small project, which writes a result file, stores it as an artifact and
prints a few lines:

```sh
#!/bin/sh
# build.sh
set -eu
echo "building on $(uname -sr)"
mkdir -p out
date -u +%Y-%m-%dT%H:%M:%SZ > out/result.txt
wb artifact put out/result.txt
echo "build ok"
```

`wb` is the command inside every sandbox; `wb artifact put` copies a file out of the box into the
server's artifact store, where it stays downloadable by its SHA-256.

### With curl

```sh
W=$WORKBOX_URL
AUTH="authorization: Bearer $WORKBOX_TOKEN"
JSON='content-type: application/json'

# Who am I? The binding and the expiry of this key.
curl -sS -H "$AUTH" $W/v1/whoami
# {"id":"key_01K8...","scopes":["read","exec","admin"],"binding":{"labels":{"owner":"dots"}},"source":"store","expiresAt":1764292000000}

# Create a sandbox. The answer (201) comes once it is READY, with the key's label on it.
ID=$(curl -sS -H "$AUTH" -H "$JSON" -d '{"name":"build"}' $W/v1/sandboxes | jq -r .id)
S=$W/v1/sandboxes/$ID

# Upload the project. -T sends the file as the body of a PUT.
curl -sS -H "$AUTH" -T build.sh "$S/files/raw?path=/workspace/project/build.sh&mkdirs=1"
# {"path":"/workspace/project/build.sh","bytes":166}

# Start the build as a background session; it keeps running without a connection.
SID=$(curl -sS -H "$AUTH" -H "$JSON" \
  -d '{"argv":["sh","build.sh"],"cwd":"/workspace/project","name":"build"}' \
  "$S/sessions" | jq -r .sessionId)

# Wait for it: this answers as soon as the session exits, or with "exited": null after timeoutMs.
curl -sS -H "$AUTH" -H "$JSON" -d '{"timeoutMs":300000}' "$S/sessions/$SID/wait"
# {"sessionId":"01K8...","exited":{"code":0,"signal":null,"at":1761700012345}}

# Or long-poll the event log for exits; the request returns as soon as one is logged.
curl -sS -H "$AUTH" "$W/v1/events?sandboxId=$ID&types=session.exited&afterSeq=0&waitMs=60000"
# {"events":[{"seq":17,"sandboxId":"01K8...","type":"session.exited","source":"host","payload":{"sessionId":"01K8...","name":"build","code":0,"signal":null},"causation":null,"at":1761700012345}],"nextSeq":17}

# The build's output, stdout and stderr in order.
curl -sS -H "$AUTH" "$S/sessions/$SID/output?encoding=text" | jq -j '.chunks[].data'

# The result file, and the artifact the build stored.
curl -sS -H "$AUTH" -o result.txt "$S/files/raw?path=/workspace/project/out/result.txt"
SHA=$(curl -sS -H "$AUTH" "$S/artifacts" | jq -r '.items[] | select(.name == "result.txt") | .sha256')
curl -sS -H "$AUTH" -o artifact.txt "$S/artifacts/$SHA"

# Done: destroy the sandbox.
curl -sS -H "$AUTH" -X DELETE $S
```

Notes:

- A command that should simply run to completion can use `POST $S/exec` with
  `{"argv": [...], "cwd": "...", "timeoutMs": 60000}`; the answer holds `exitCode`, `stdout` and
  `stderr`. A session is better for anything long, because it does not depend on the request
  staying open.
- The long-poll's `nextSeq` is where the next call should start: pass it back as `afterSeq` and
  only newer events come back. `types` takes exact types or `prefix.*`, comma-separated.
- `output` returns at most 1 MiB at a time by default; while `truncated` is true, read again with
  `fromSeq` set to `nextSeq`.
- Whether the sandbox can reach the internet depends on the server's network mode, `egress`
  unless the operator chose otherwise. A sandbox can ask for `none`, or for `allowlist` with a list
  of hosts, with `"profile": {"network": {"mode": "allowlist", "allow": ["pypi.org"]}}` on create.
- `-sS` keeps errors visible. A 404 for a sandbox id means it does not exist or this key cannot
  see it; the server does not say which.

### With Python and the standard library

The same flow, with nothing beyond `urllib` and `json`:

```python
#!/usr/bin/env python3
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ["WORKBOX_URL"].rstrip("/")
TOKEN = os.environ["WORKBOX_TOKEN"]
# Trusts the system CAs, or only WORKBOX_CA_FILE when it is set.
TLS = ssl.create_default_context(cafile=os.environ.get("WORKBOX_CA_FILE"))

BUILD = b"""#!/bin/sh
set -eu
echo "building on $(uname -sr)"
mkdir -p out
date -u +%Y-%m-%dT%H:%M:%SZ > out/result.txt
wb artifact put out/result.txt
echo "build ok"
"""


def call(method, path, body=None, data=None, query=None, timeout=120):
    """One request. JSON answers are decoded; raw file answers come back as bytes."""
    url = BASE + path
    if query:
        url += "?" + urllib.parse.urlencode(query)
    headers = {"authorization": f"Bearer {TOKEN}"}
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    elif data is not None:
        headers["content-type"] = "application/octet-stream"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=TLS) as res:
            raw = res.read()
            kind = res.headers.get("content-type", "")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {path}: HTTP {e.code}: {e.read().decode(errors='replace')}")
    return json.loads(raw) if "json" in kind else raw


me = call("GET", "/v1/whoami")
print("key", me["id"], "bound to", me["binding"], "expires at", me["expiresAt"])

box = call("POST", "/v1/sandboxes", {"name": "py-build"})
S = f"/v1/sandboxes/{box['id']}"
try:
    call("PUT", f"{S}/files/raw", data=BUILD,
         query={"path": "/workspace/project/build.sh", "mkdirs": "1"})
    started = call("POST", f"{S}/sessions",
                   {"argv": ["sh", "build.sh"], "cwd": "/workspace/project", "name": "build"})
    sid = started["sessionId"]

    # Long-poll for this session's exit.
    after, exited = 0, None
    while exited is None:
        page = call("GET", "/v1/events", timeout=90, query={
            "sandboxId": box["id"], "types": "session.exited",
            "afterSeq": after, "waitMs": 60000,
        })
        after = page["nextSeq"]
        for event in page["events"]:
            if event["payload"]["sessionId"] == sid:
                exited = event["payload"]
    print("build exited with code", exited["code"], "signal", exited["signal"])

    out = call("GET", f"{S}/sessions/{sid}/output", query={"encoding": "text"})
    for chunk in out["chunks"]:
        (sys.stdout if chunk["stream"] == "stdout" else sys.stderr).write(chunk["data"])

    result = call("GET", f"{S}/files/raw", query={"path": "/workspace/project/out/result.txt"})
    with open("result.txt", "wb") as f:
        f.write(result)

    artifacts = call("GET", f"{S}/artifacts")["items"]
    sha = next(a["sha256"] for a in artifacts if a["name"] == "result.txt")
    with open("artifact.txt", "wb") as f:
        f.write(call("GET", f"{S}/artifacts/{sha}"))
finally:
    call("DELETE", S)
```

### With the JavaScript SDK

The SDK lives in `packages/sdk` of the Workbox repository and uses only Node's built-in `fetch`
and `WebSocket` (Node 22 or later). Clone the repository, or copy `packages/sdk/src`, and import
it by path:

```js
import fs from 'node:fs';
import { WorkboxClient } from './workbox/packages/sdk/src/index.js';

const client = new WorkboxClient({
  baseUrl: process.env.WORKBOX_URL,
  token: process.env.WORKBOX_TOKEN,
});
console.log(await client.whoami());

const box = await client.createSandbox({ name: 'sdk-build' });
try {
  await box.upload('/workspace/project/build.sh', fs.readFileSync('build.sh'), { mkdirs: true });
  const { sessionId } = await box.startSession({
    argv: ['sh', 'build.sh'],
    cwd: '/workspace/project',
    name: 'build',
  });
  const build = box.session(sessionId);
  const { exited } = await build.wait({ timeoutMs: 300_000 });
  console.log('exit code', exited?.code);

  const out = await build.output({ encoding: 'text' });
  for (const chunk of out.chunks) process.stdout.write(chunk.data);

  fs.writeFileSync('result.txt', await box.download('/workspace/project/out/result.txt'));
  const { items } = await box.listArtifacts();
  const ref = items.find((a) => a.name === 'result.txt');
  fs.writeFileSync('artifact.txt', await box.downloadArtifact(ref.sha256));
} finally {
  await box.destroy();
}
```

A private CA is trusted through `NODE_EXTRA_CA_CERTS`, a PEM file of extra CA certificates.
Failed calls reject with a `WorkboxApiError` carrying `status` and `code`. The
[SDK guide](sdk.md) covers the rest of the client.

The operator CLI works the same way from another machine: `workbox sandbox run`, `logs`, `wait`
and `cp` take `--server $WORKBOX_URL --token $WORKBOX_TOKEN`.

## Get notified when a build ends

An agent does not have to hold a request open while a build runs. It can be called, or keep one
stream open for every sandbox it has.

### By webhook

An agent with an HTTPS endpoint of its own registers it once:

```sh
curl -sS -H "$AUTH" -H "$JSON" $W/v1/webhooks \
  -d '{"url":"https://agent.example.com/workbox","types":["session.exited"]}'
```

The answer holds the webhook's `secret` (`whsec_...`), shown only this once. From then on every
session exit in the key's sandboxes is sent as a signed `POST`; `payload.code` is the exit code,
0 for success, and `payload.sessionId` and `sandboxId` say which build it was. Check the signature
before acting on a request: [Get notified with webhooks](webhooks.md#verify-the-signature) has
receivers in Node (`verifyWebhook` from the SDK) and in Python with the standard library, and
explains retries and duplicates.

A webhook made with a bound key receives only the events of the sandboxes that key sees. The
endpoint must be `https:` on a public address unless the operator has allowed private addresses
or plain HTTP in the [engine configuration](../reference/configuration.md#webhooks).

### By WebSocket

An agent without a public endpoint can keep one WebSocket open instead:
`wss://workbox.example.com:8790/v1/events/ws?types=session.exited&afterSeq=N`, with the key in the
`Authorization` header (or `?token=`). It sends the stored events after `afterSeq`, then each new
one as it is logged, as `{"type": "event", "event": {...}}` frames; `{"type": "live", "seq": N}`
marks the switch to live events. After a dropped connection, reconnect with `afterSeq` set to the
last `seq` received. With the SDK:

```js
for await (const event of client.events({ afterSeq: 0, types: ['session.exited'] })) {
  console.log(event.sandboxId, event.payload.sessionId, 'exited', event.payload.code);
}
```

The SDK's stream reconnects by itself and resumes where it stopped. The frames and the events are
described in the [REST API reference](../reference/rest-api.md#events).

## Limits and safety

- **Revocation.** `workbox key rm <keyId>` (or `DELETE /v1/keys/:keyId`) revokes the key: its next
  request is answered 401, and its webhooks stop receiving deliveries, queued ones included. The
  key is checked when a request or a WebSocket upgrade arrives, so a WebSocket it opened earlier
  stays open until it closes; restarting `workbox serve` closes every WebSocket, and sandboxes
  keep running across the restart.
- **Expiry.** A key made with `--ttl` stops working when that time has passed. `GET /v1/whoami`
  shows `expiresAt` in milliseconds since the epoch; ask the operator for a new key before then.
- **Bad tokens.** After 20 failed authentications within 60 s, every request from that client
  address is answered 429 `E_LIMIT` with a `Retry-After` header until the 60 s are over. Behind a
  reverse proxy every client shares the proxy's address.
- **Secrets inside the box.** Do not put the Workbox token, host credentials or other secrets into
  files or commands in a sandbox: anything in the box is readable by every process there,
  including code the build downloads. When a build needs a credential, the operator puts it in the
  host's secrets file and the sandbox is created with that reference in `secretRefs`; inside,
  `wb secret exec REF -- cmd` hands the value to that one command. Once injected, the value is
  visible to processes in the box running as the same user; see the
  [stated limits](../security.md#stated-limits).
- **Sandboxes do not expire.** A sandbox runs until it is destroyed. Destroy each one when the work
  is done, and list what is left with `GET /v1/sandboxes`.
- **Audit.** Every request that changes something is recorded in the host's audit log with the
  key's id, refused ones included.
