# Get notified with webhooks

A webhook is an HTTPS endpoint of yours that Workbox calls when something happens in a sandbox:
a build session exits, a command finishes, an agent raises an ask. Each call is a signed `POST`
in the [Standard Webhooks](https://www.standardwebhooks.com/) format, so the receiver can check
that it came from your Workbox server and was not replayed. Deliveries are kept in the server's
database and retried, so nothing is lost while your endpoint or the Workbox server is down for a
while.

You need a running [server](getting-started.md#4-serve) and a key with the `admin` scope to
register a webhook (`read` is enough to list webhooks and their deliveries).

## Register a webhook

From the CLI, on the host or through `--server`:

```sh
workbox webhook add https://agent.example.com/workbox \
  --type session.exited --type exec.finished --description "build results"
```

Through the REST API:

```sh
curl -sS https://workbox.example.com:8790/v1/webhooks \
  -H "authorization: Bearer $WORKBOX_TOKEN" -H 'content-type: application/json' \
  -d '{"url": "https://agent.example.com/workbox", "types": ["session.exited"]}'
```

Or from JavaScript with the [SDK](sdk.md):

```js
const hook = await client.createWebhook({
  url: 'https://agent.example.com/workbox',
  types: ['session.exited', 'exec.*'],
  sandboxId: box.id,
});
console.log(hook.id, hook.secret);
```

The answer carries the webhook's `secret` (`whsec_` followed by base64). It is shown only in this
answer and when you rotate it (`workbox webhook rotate <id>` or
`POST /v1/webhooks/:webhookId/rotate-secret`); store it with the receiver.

What a webhook receives:

- `types` lists event types (`session.exited`) and prefixes (`session.*` matches every type that
  starts with `session.`). Without `types` it receives every event.
- `sandboxId` limits it to one sandbox, and `labels` to the sandboxes that carry every one of
  those labels.
- It receives only events logged after it was created.
- A webhook created with a key bound to some sandboxes receives only those sandboxes' events, and
  only that key (or an unbound key) can see and manage it. See
  [bound access](../reference/rest-api.md#stored-keys-and-bound-access).

`workbox webhook test <id>` (or `POST /v1/webhooks/:webhookId/test`) sends a `webhook.test` event,
which is a quick way to check the receiver and its signature check. The events of a build are
`session.started` and `session.exited` for a session (`code` is the exit code, 0 for success), and
`exec.finished` for `POST /v1/sandboxes/:id/exec` (`exitCode`). Other host events are
`sandbox.created`, `sandbox.state`, `sandbox.health`, `ask.raised`, `ask.answered`,
`checkpoint.created` and `artifact.added`; agents add their own with `wb event emit`.

## The request

```http
POST /workbox HTTP/1.1
content-type: application/json
user-agent: Workbox-Webhooks/0.1.0-alpha.1
webhook-id: msg_01K8QZ6R3V4TQ7J9W2N5B8C1DE
webhook-timestamp: 1761700000
webhook-signature: v1,<base64 of the HMAC-SHA256 described below>

{"type":"session.exited","timestamp":"2025-10-29T01:06:40.000Z","data":{"seq":42,"sandboxId":"01K8QZ5F...","type":"session.exited","source":"host","payload":{"sessionId":"s-1","name":"build","code":0,"signal":null},"causation":null,"at":1761700000000}}
```

- `webhook-id` identifies the delivery and stays the same on every retry of it.
- `webhook-timestamp` is when this attempt was sent, in unix seconds.
- `webhook-signature` is `v1,` followed by the base64 HMAC-SHA256 of
  `<webhook-id>.<webhook-timestamp>.<body>`, keyed with the base64-decoded part of the secret
  after `whsec_`.
- The body's `timestamp` is when the event happened, and `data` is the event as the event log
  holds it. `data.seq` grows with every event the server logs.

Answer with any 2xx status within 15 seconds; do the work afterwards.

## Verify the signature

Check every request before acting on it, against the raw body as received. Refuse a request whose
`webhook-timestamp` is more than five minutes from your clock: that stops a captured request from
being replayed later.

### In Node with the SDK

`verifyWebhook` compares the signature in constant time, checks the timestamp window and returns
the parsed payload; it throws a `WebhookVerificationError` otherwise.

```js
import https from 'node:https';
import fs from 'node:fs';
import { verifyWebhook } from './packages/sdk/src/index.js';

const secret = process.env.WORKBOX_WEBHOOK_SECRET;
const seen = new Set();

const tls = { cert: fs.readFileSync('cert.pem'), key: fs.readFileSync('key.pem') };
https
  .createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let event;
      try {
        event = verifyWebhook(secret, req.headers, Buffer.concat(chunks));
      } catch {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(204).end();
      const id = req.headers['webhook-id'];
      if (seen.has(id)) return;
      seen.add(id);
      if (event.type === 'session.exited')
        console.log(`session ${event.data.payload.sessionId} exited ${event.data.payload.code}`);
    });
  })
  .listen(8443);
```

### In Python with the standard library

```python
import base64, hashlib, hmac, json, os, ssl, time
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ["WORKBOX_WEBHOOK_SECRET"]
KEY = base64.b64decode(SECRET.removeprefix("whsec_"))
TOLERANCE_SECONDS = 300
seen = set()


def verify(headers, body):
    msg_id = headers.get("webhook-id")
    timestamp = headers.get("webhook-timestamp")
    signatures = headers.get("webhook-signature")
    if not (msg_id and timestamp and signatures and timestamp.isdigit()):
        raise ValueError("missing or malformed webhook headers")
    if abs(time.time() - int(timestamp)) > TOLERANCE_SECONDS:
        raise ValueError("timestamp outside the tolerance window")
    signed = f"{msg_id}.{timestamp}.".encode() + body
    expected = base64.b64encode(hmac.new(KEY, signed, hashlib.sha256).digest()).decode()
    for entry in signatures.split(" "):
        version, _, signature = entry.partition(",")
        if version == "v1" and hmac.compare_digest(signature, expected):
            return json.loads(body)
    raise ValueError("no signature matches")


class Hook(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        try:
            event = verify(self.headers, body)
        except ValueError:
            self.send_response(400)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()
        if self.headers["webhook-id"] in seen:
            return
        seen.add(self.headers["webhook-id"])
        print(event["type"], event["data"]["seq"], event["data"]["payload"])


server = HTTPServer(("0.0.0.0", 8443), Hook)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain("cert.pem", "key.pem")
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
```

## Retries and duplicates

- A 2xx answer marks the delivery delivered.
- Any other status, no answer within 15 seconds, or a connection error is a failed attempt. A
  redirect is not followed and counts as a failure.
- After a failed attempt the delivery is tried again after 5 seconds, then 5 minutes, 30 minutes,
  2 hours, 5 hours, 10 hours and 10 hours: eight attempts over about 28 hours. Then it is marked
  `failed`.
- A `410 Gone` answer disables the webhook at once; its `disabledReason` says why. Enable it again
  with `PATCH /v1/webhooks/:webhookId` and `{"enabled": true}`.
- Pending deliveries survive a restart of the Workbox server and are sent once it is back.
  Sessions that exited while the server was down are logged when it re-attaches to their
  sandboxes, and delivered then.
- `workbox webhook deliveries <id>` lists each delivery with its `status`, `attempts`,
  `lastStatus` and the start of the last failed answer's body (`lastError`).
  `POST /v1/webhooks/:webhookId/deliveries/:deliveryId/retry` sends one again now.

Delivery is at least once and in no particular order. A receiver may see the same delivery more
than once (after a timeout on an answer that did arrive, for example), so de-duplicate on
`webhook-id`. Deliveries can also arrive out of order; sort on `data.seq` when the order matters.

## Which endpoints are refused, and why

The Workbox server makes these requests from the host it runs on, which can usually reach more
than the internet can: loopback services, the private network, cloud metadata endpoints and the
link the sandboxes' network proxy listens on. So that a webhook cannot be used to reach them, the
URL is checked when the webhook is created or changed, and again before every attempt:

- It must use `https:`, carry no user name or password, and be at most 2048 characters long.
- Its host must resolve only to public addresses. Refused are `0.0.0.0/8`, `10.0.0.0/8`,
  `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`,
  `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`,
  `224.0.0.0/4`, `240.0.0.0/4`, `::`, `::1`, `64:ff9b::/96`, `fc00::/7`, `fe80::/10`, `ff00::/8`
  and `2001:db8::/32`, and IPv4-mapped IPv6 forms of the IPv4 ranges. A name such as `localhost`
  that resolves to one of them is refused too.
- The request connects to the address that was checked, so a DNS answer that changes between the
  check and the connection cannot redirect it to a private address.

Creating or changing a webhook with a refused URL is a 400 `E_INVALID_PARAMS` naming the host and
address. When a URL that passed later resolves to a refused address, that attempt fails with the
reason in `lastError` and is retried like any other failure.

When the receiver runs on the Workbox host itself or inside a trusted network, the operator can
allow it in the [engine configuration](../reference/configuration.md#webhooks):
`webhooks.allowPrivate` accepts addresses that are not public and `webhooks.allowHttp` accepts
`http:` URLs.
