# Use the SDK

`@workbox/sdk` is a client for the REST and WebSocket API. It lives in `packages/sdk` of this
workspace and is not published; import it by path from a checkout. It needs a running
[server](getting-started.md#4-serve) and a key with the scopes the calls need (see the
[scope table](../reference/rest-api.md#scopes)).

## Create a sandbox and run a command

Save as `demo.mjs` in the repository root:

```js
import { WorkboxClient } from './packages/sdk/src/index.js';

const client = new WorkboxClient({
  baseUrl: 'http://127.0.0.1:8790',
  token: process.env.WORKBOX_TOKEN,
});

const box = await client.createSandbox({ name: 'demo', profile: { network: { mode: 'none' } } });
try {
  const out = await box.exec({ argv: ['sh', '-c', 'wb status --json'] });
  console.log(out.exitCode, out.stdout);
} finally {
  await box.destroy();
}
```

Run it with `node demo.mjs`. `createSandbox` always sends an idempotency key (yours, or a fresh
UUID), so a retry after a lost response returns the same sandbox. `exec` runs to completion and is
sent once, never retried; GET, HEAD and DELETE calls are retried with jittered backoff on 5xx and
network errors.

## Files

```js
await box.writeFile('/tmp/hello.txt', 'hi', { mkdirs: true });
const { data, eof } = await box.readFile('/tmp/hello.txt'); // data is base64
```

`listFiles(dir)` lists a directory. The paths are sandbox paths. `writeFile` also takes `append` and
`mode`; a string is written as UTF-8.

## Stream a session

```js
const { sessionId } = await box.startSession({ argv: ['sh', '-c', 'echo one; sleep 1; echo two'] });
const stream = box.attach(sessionId);
for await (const evt of stream) {
  if (evt.type === 'session.output') process.stdout.write(Buffer.from(evt.params.data, 'base64'));
}
```

The stream replays the session from its first byte and ends after `session.exit`. It also offers
`input(data)`, `resize(rows, cols)`, `sendSignal(name)` and `close()`, which detaches while the
session keeps running. The WebSocket carries the token as a `?token=` query parameter; see the
[stated limit](../security.md#stated-limits).

## Events, evidence, artifacts and checkpoints

- `box.events({ afterSeq, follow: true, signal })` is an async iterator over the events route. The
  route is paged polling, not a push stream: the iterator pages until a page is empty, or with
  `follow` keeps polling every `intervalMs` (default 1000 ms) until the signal aborts.
- `listEvidence`, `listArtifacts` take `cursor` and `limit`; `listCheckpoints` and
  `createCheckpoint({ name, summary, paths })` manage checkpoints. A new sandbox can start from
  one with `createSandbox({ fromCheckpoint })`.
- `client.listAsks()` and `client.answerAsk(askId, answer)` list and answer the asks an agent
  raised with `wb ask`; answering needs the `answer` scope.
- `client.reconcile()` calls `POST /v1/reconcile` (admin).

Failures reject with `WorkboxApiError`; the error codes are in the
[REST API reference](../reference/rest-api.md#errors).
