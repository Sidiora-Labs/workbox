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
`mode`; a string is written as UTF-8. `statFile(path)`, `mkdir(dir, { parents, mode })` and
`removeFile(path, { recursive })` do what their names say.

`readFile` and `writeFile` move at most 4 MiB per call. For files of any size use the raw routes:

```js
import fs from 'node:fs';

await box.upload('/workspace/data.tar', fs.createReadStream('data.tar'), { mkdirs: true });
const report = await box.download('/workspace/report.json'); // a Buffer
const body = await box.download('/workspace/big.log', { stream: true }); // a web ReadableStream
```

`upload` takes a Buffer, a string, a web ReadableStream, a Node readable or any async iterable of
chunks, and `mode` and `mkdirs`. An upload from bytes is retried like a write; one from a stream is
sent once. `downloadArtifact(sha256)` returns an artifact's bytes the same way.

## Control a session over HTTP

```js
const { sessionId } = await box.startSession({ argv: ['sh', '-c', 'make test'] });
const build = box.session(sessionId);
const { exited } = await build.wait({ timeoutMs: 300_000 }); // null if still running
const out = await build.output({ encoding: 'text' });
for (const chunk of out.chunks) process.stdout.write(chunk.data);
await build.remove();
```

`box.session(sessionId)` makes no request. Its methods are `info()`, `output({ fromSeq,
maxBytes, encoding })`, `wait({ timeoutMs })`, `input(data, { eof })`, `signal(name)`,
`stop({ graceMs })`, `resize(rows, cols)` and `remove()`. `output` returns whole chunks up to
`maxBytes`; read again from `nextSeq` while `truncated` is true. `wait`, `stop` and `resize` are
retried; `input` and `signal` are sent once. See the
[REST API reference](../reference/rest-api.md#sessions-without-a-websocket).

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

- `box.listEvents({ afterSeq, limit, types, waitMs })` reads one page of the sandbox's events and
  `nextSeq`. `box.events({ afterSeq, types })` iterates them until a page is empty; with
  `follow: true` it streams over the events WebSocket instead: the stored events after `afterSeq`
  (default 0), then new ones as they are logged, until the signal aborts.
- `client.listEvents({ afterSeq, limit, types, sandboxId, waitMs })` and
  `client.events({ afterSeq, types, sandboxId, signal })` do the same across every sandbox the key
  sees. `waitMs` (at most 60000) holds the request until a matching event is logged. `events()`
  is live only without `afterSeq`. `types` are exact types or `prefix.*` patterns.
- An event stream reconnects with backoff after a dropped connection and resumes after the last
  event it yielded, so none is missed or repeated; `stream.lastSeq` is that point and
  `stream.close()` ends it. A refused connection whose REST route answers 4xx (a bad key, a
  missing sandbox) throws that `WorkboxApiError`.
- `listEvidence`, `listArtifacts` take `cursor` and `limit`; `listCheckpoints` and
  `createCheckpoint({ name, summary, paths })` manage checkpoints. A new sandbox can start from
  one with `createSandbox({ fromCheckpoint })`.
- `client.listAsks()` and `client.answerAsk(askId, answer)` list and answer the asks an agent
  raised with `wb ask`; answering needs the `answer` scope.
- `client.reconcile()` calls `POST /v1/reconcile` (admin).

Failures reject with `WorkboxApiError`; the error codes are in the
[REST API reference](../reference/rest-api.md#errors).
