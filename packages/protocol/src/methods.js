import { v, validate } from './schema.js';
import { ProtocolError, Codes } from './errors.js';

export const PROTOCOL_VERSION = 1;

const base64 = v.string({ pattern: /^[A-Za-z0-9+/]*={0,2}$/, max: 6 * 1024 * 1024 });
const path = v.string({ min: 1, max: 4096 });
const sessionId = v.string({ min: 1, max: 64 });
const envRecord = v.record(v.string({ max: 32 * 1024 }), {
  keyPattern: /^[A-Za-z_][A-Za-z0-9_]*$/,
  max: 512,
});
const signalName = v.string({ pattern: /^SIG[A-Z0-9]{2,8}$/ });

/**
 * Every method the host, the runner and wb speak. Keys are method names; each has a params
 * schema and a short description used by `wb tools` and the server's OpenAPI document.
 * Methods prefixed `broker.` are raised by wb, relayed by the runner and served by the host.
 */
export const Methods = Object.freeze({
  // ── host → runner ──
  'runner.hello': {
    doc: 'Open the control channel; the runner answers with its boot identity and, once per boot, the boot nonce.',
    params: v.object(
      {
        protocol: v.integer({ min: 1 }),
        role: v.optional(v.enum(['host', 'local'])),
        hostToken: v.optional(v.string({ max: 128 })),
        minProtocol: v.optional(v.integer({ min: 1 })),
        maxProtocol: v.optional(v.integer({ min: 1 })),
      },
      { required: ['protocol'] },
    ),
  },
  'runner.go': {
    doc: 'Release the runner from its boot barrier once network and policy are in place.',
    params: v.object(
      {
        env: v.optional(envRecord),
        network: v.optional(
          v.object(
            {
              mode: v.enum(['none', 'egress', 'allowlist']),
              proxy: v.optional(v.string({ max: 256 })),
            },
            { required: ['mode'] },
          ),
        ),
      },
      {},
    ),
  },
  'runner.status': {
    doc: 'Runner uptime, session count and spool usage.',
    params: v.object({}, {}),
  },
  'runner.shutdown': {
    doc: 'Stop every session and exit.',
    params: v.object({ graceMs: v.optional(v.integer({ min: 0, max: 600_000 })) }, {}),
  },

  'session.start': {
    doc: 'Start a durable session from an argv.',
    params: v.object(
      {
        argv: v.array(v.string({ min: 1, max: 65_536 }), { min: 1, max: 4096 }),
        cwd: v.optional(path),
        env: v.optional(envRecord),
        inheritEnv: v.optional(v.boolean()),
        uid: v.optional(v.integer({ min: 0, max: 65_535 })),
        gid: v.optional(v.integer({ min: 0, max: 65_535 })),
        name: v.optional(v.string({ min: 1, max: 128, pattern: /^[A-Za-z0-9._-]+$/ })),
        pty: v.optional(v.boolean()),
        rows: v.optional(v.integer({ min: 1, max: 1000 })),
        cols: v.optional(v.integer({ min: 1, max: 1000 })),
        spoolBytes: v.optional(v.integer({ min: 4096, max: 64 * 1024 * 1024 })),
        secretRefs: v.optional(v.array(v.string({ min: 1, max: 128 }), { max: 64 })),
      },
      { required: ['argv'] },
    ),
  },
  'session.list': { doc: 'List sessions, live and exited.', params: v.object({}, {}) },
  'session.attach': {
    doc: 'Subscribe to a session, replaying retained output from a sequence number.',
    params: v.object(
      { sessionId, fromSeq: v.optional(v.integer({ min: 0 })) },
      { required: ['sessionId'] },
    ),
  },
  'session.detach': {
    doc: 'Stop receiving output for a session without affecting it.',
    params: v.object({ sessionId }, { required: ['sessionId'] }),
  },
  'session.input': {
    doc: 'Write bytes to a session stdin; eof closes it.',
    params: v.object(
      { sessionId, data: v.optional(base64), eof: v.optional(v.boolean()) },
      { required: ['sessionId'] },
    ),
  },
  'session.signal': {
    doc: 'Send a signal to the session process group.',
    params: v.object({ sessionId, signal: signalName }, { required: ['sessionId', 'signal'] }),
  },
  'session.stop': {
    doc: 'SIGTERM the session, SIGKILL after the grace period.',
    params: v.object(
      { sessionId, graceMs: v.optional(v.integer({ min: 0, max: 600_000 })) },
      { required: ['sessionId'] },
    ),
  },
  'session.resize': {
    doc: 'Resize a PTY session.',
    params: v.object(
      { sessionId, rows: v.integer({ min: 1, max: 1000 }), cols: v.integer({ min: 1, max: 1000 }) },
      { required: ['sessionId', 'rows', 'cols'] },
    ),
  },
  'session.remove': {
    doc: 'Forget an exited session and free its spool.',
    params: v.object({ sessionId }, { required: ['sessionId'] }),
  },

  'fs.read': {
    doc: 'Read a byte range of a file inside the sandbox.',
    params: v.object(
      {
        path,
        offset: v.optional(v.integer({ min: 0 })),
        length: v.optional(v.integer({ min: 0, max: 4 * 1024 * 1024 })),
      },
      { required: ['path'] },
    ),
  },
  'fs.write': {
    doc: 'Write or append bytes to a file inside the sandbox.',
    params: v.object(
      {
        path,
        data: base64,
        append: v.optional(v.boolean()),
        mode: v.optional(v.integer({ min: 0, max: 0o7777 })),
        mkdirs: v.optional(v.boolean()),
      },
      { required: ['path', 'data'] },
    ),
  },
  'fs.list': { doc: 'List a directory.', params: v.object({ path }, { required: ['path'] }) },
  'fs.stat': { doc: 'Stat a path.', params: v.object({ path }, { required: ['path'] }) },
  'fs.mkdir': {
    doc: 'Create a directory and its parents.',
    params: v.object(
      { path, mode: v.optional(v.integer({ min: 0, max: 0o7777 })) },
      { required: ['path'] },
    ),
  },
  'fs.remove': {
    doc: 'Remove a file or directory.',
    params: v.object({ path, recursive: v.optional(v.boolean()) }, { required: ['path'] }),
  },

  // ── wb → runner → host ──
  'broker.status': {
    doc: 'Sandbox identity, limits, usage and network mode.',
    params: v.object({}, {}),
  },
  'broker.evidence.record': {
    doc: 'Store an evidence envelope produced by wb run.',
    params: v.object({ envelope: v.record(v.any(), { max: 64 }) }, { required: ['envelope'] }),
  },
  'broker.artifact.put': {
    doc: 'Hand a file in the shared outbox to the host content store.',
    params: v.object(
      {
        outboxName: v.string({ min: 1, max: 255, pattern: /^[A-Za-z0-9._-]+$/ }),
        sha256: v.string({ pattern: /^[a-f0-9]{64}$/ }),
        size: v.integer({ min: 0 }),
        name: v.optional(v.string({ max: 255 })),
        contentType: v.optional(v.string({ max: 128 })),
        kind: v.optional(v.string({ max: 64 })),
      },
      { required: ['outboxName', 'sha256', 'size'] },
    ),
  },
  'broker.artifact.get': {
    doc: 'Copy a stored artifact into the shared inbox.',
    params: v.object({ sha256: v.string({ pattern: /^[a-f0-9]{64}$/ }) }, { required: ['sha256'] }),
  },
  'broker.artifact.list': {
    doc: 'List artifacts of this sandbox.',
    params: v.object(
      {
        limit: v.optional(v.integer({ min: 1, max: 1000 })),
        cursor: v.optional(v.string({ max: 128 })),
      },
      {},
    ),
  },
  'broker.ask.raise': {
    doc: 'Raise a question, decision, permission or secret ask to a human.',
    params: v.object(
      {
        kind: v.enum(['question', 'decision', 'permission', 'secret']),
        title: v.string({ min: 1, max: 512 }),
        body: v.optional(v.string({ max: 64 * 1024 })),
        options: v.optional(v.array(v.string({ min: 1, max: 256 }), { max: 16 })),
        recommended: v.optional(v.string({ max: 256 })),
        timeoutMs: v.optional(v.integer({ min: 0 })),
        ref: v.optional(v.string({ max: 256 })),
      },
      { required: ['kind', 'title'] },
    ),
  },
  'broker.ask.status': {
    doc: 'Read one ask.',
    params: v.object({ askId: v.string({ min: 1, max: 64 }) }, { required: ['askId'] }),
  },
  'broker.ask.list': {
    doc: 'List asks of this sandbox.',
    params: v.object({ status: v.optional(v.enum(['open', 'answered', 'expired', 'all'])) }, {}),
  },
  'broker.ask.wait': {
    doc: 'Block until an ask is answered or the timeout passes.',
    params: v.object(
      {
        askId: v.string({ min: 1, max: 64 }),
        timeoutMs: v.optional(v.integer({ min: 0, max: 7 * 24 * 3600 * 1000 })),
      },
      { required: ['askId'] },
    ),
  },
  'broker.secret.list': {
    doc: 'List secret references this sandbox may use.',
    params: v.object({}, {}),
  },
  'broker.secret.resolve': {
    doc: 'Resolve references to values for injection into one child process. Runner-only.',
    params: v.object(
      { refs: v.array(v.string({ min: 1, max: 128 }), { min: 1, max: 64 }) },
      { required: ['refs'] },
    ),
  },
  'broker.event.emit': {
    doc: 'Append a structured event to the sandbox event log.',
    params: v.object(
      {
        type: v.string({ min: 1, max: 128, pattern: /^[a-z][a-z0-9_.-]*$/ }),
        payload: v.optional(v.record(v.any(), { max: 64 })),
        causation: v.optional(v.string({ max: 64 })),
      },
      { required: ['type'] },
    ),
  },
  'broker.lease.status': {
    doc: 'Current lease and derived offline deadline.',
    params: v.object({}, {}),
  },
  'broker.lease.renew': {
    doc: 'Renew the lease.',
    params: v.object({ ttlMs: v.optional(v.integer({ min: 1000, max: 24 * 3600 * 1000 })) }, {}),
  },
  'broker.checkpoint.create': {
    doc: 'Checkpoint the sandbox upper layer with an envelope.',
    params: v.object(
      {
        name: v.optional(v.string({ max: 128 })),
        summary: v.optional(v.string({ max: 64 * 1024 })),
        paths: v.optional(v.array(path, { max: 256 })),
      },
      {},
    ),
  },
  'broker.checkpoint.list': { doc: 'List checkpoints of this sandbox.', params: v.object({}, {}) },
  'broker.net.policy': { doc: 'Show the effective network policy.', params: v.object({}, {}) },
  'broker.net.test': {
    doc: 'Test reachability of host:port under the current policy.',
    params: v.object(
      {
        host: v.string({ min: 1, max: 253 }),
        port: v.integer({ min: 1, max: 65_535 }),
        timeoutMs: v.optional(v.integer({ min: 100, max: 60_000 })),
      },
      { required: ['host', 'port'] },
    ),
  },
  'broker.preset.manifest': {
    doc: 'Mirror a preset preparation manifest to the host.',
    params: v.object(
      {
        name: v.string({ min: 1, max: 64, pattern: /^[a-z][a-z0-9-]*$/ }),
        manifest: v.record(v.any(), { max: 256 }),
      },
      { required: ['name', 'manifest'] },
    ),
  },
});

/** Events, by name, with the shape each carries. */
export const Events = Object.freeze({
  'session.output': v.object(
    {
      sessionId,
      stream: v.enum(['stdout', 'stderr', 'pty']),
      seq: v.integer({ min: 0 }),
      data: base64,
    },
    { required: ['sessionId', 'stream', 'seq', 'data'] },
  ),
  'session.started': v.object(
    {
      sessionId,
      name: v.nullable(v.string()),
      pid: v.integer({ min: 1 }),
      argv: v.array(v.string()),
      startedAt: v.integer({ min: 0 }),
    },
    { required: ['sessionId', 'pid', 'argv', 'startedAt'] },
  ),
  'session.exit': v.object(
    {
      sessionId,
      code: v.nullable(v.integer()),
      signal: v.nullable(v.string()),
      seq: v.integer({ min: 0 }),
      at: v.integer({ min: 0 }),
    },
    { required: ['sessionId', 'code', 'signal', 'seq', 'at'] },
  ),
  'runner.log': v.object(
    {
      level: v.enum(['debug', 'info', 'warn', 'error']),
      msg: v.string({ max: 8192 }),
      data: v.optional(v.any()),
    },
    { required: ['level', 'msg'] },
  ),
  'ask.answered': v.object({ askId: v.string(), answer: v.any() }, { required: ['askId'] }),
});

/**
 * Validate params for a method, throwing a ProtocolError with the field paths on failure.
 * @param {string} method
 * @param {unknown} params
 */
export function validateParams(method, params) {
  const def = Methods[method];
  if (!def) throw new ProtocolError(Codes.UNKNOWN_METHOD, `unknown method ${method}`, { method });
  const r = validate(def.params, params ?? {});
  if (!r.ok)
    throw new ProtocolError(Codes.INVALID_PARAMS, `invalid params for ${method}`, {
      method,
      errors: r.errors,
    });
  return params ?? {};
}

/** @param {string} method */
export function isBrokerMethod(method) {
  return method.startsWith('broker.');
}

/** Names of every method, sorted. */
export function methodNames() {
  return Object.keys(Methods).sort();
}
