import { EventEmitter } from 'node:events';

/** In-memory manager with the Manager surface the server uses. HTTP/WS are real. */
export class FakeManager extends EventEmitter {
  constructor() {
    super();
    this.rows = new Map();
    this.seq = 0;
    this.store = {
      listEvidence: () => ({ items: [], cursor: null, complete: true }),
      listArtifacts: () => ({ items: [], cursor: null, complete: true }),
      listCheckpoints: () => [],
      listEvents: () => [],
      listAsks: () => [],
    };
  }
  async create(input = {}) {
    const id = `sb-${++this.seq}`;
    const row = {
      id,
      name: input.name ?? null,
      state: 'READY',
      health: 'HEALTHY',
      profile: input.profile ?? {},
    };
    this.rows.set(id, row);
    return row;
  }
  list() {
    return { items: [...this.rows.values()], cursor: null, complete: true };
  }
  inspect(id) {
    const r = this.rows.get(id);
    if (!r) {
      const e = new Error('not found');
      e.code = 'E_NOT_FOUND';
      e.status = 404;
      throw e;
    }
    return { id, desired: r.state, health: r.health, lastObservedAt: 1 };
  }
  async destroy(id) {
    this.rows.delete(id);
    return { id, state: 'DELETED' };
  }
  drain(id) {
    return { id, state: 'DRAINING' };
  }
  async reconcile() {
    return { attached: [], absent: [...this.rows.keys()], suspect: [], quarantined: [] };
  }
  async exec(id, opts) {
    return {
      sessionId: 'x',
      exitCode: 0,
      signal: null,
      stdout: `ran ${opts.argv.join(' ')}`,
      stderr: '',
      truncated: { stdout: false, stderr: false },
      timedOut: false,
      durationMs: 1,
    };
  }
  async request(id, method, params) {
    if (method === 'session.list') return { sessions: [] };
    if (method === 'session.start') return { sessionId: 'sess-1', pid: 2 };
    if (method === 'session.attach') {
      setImmediate(() =>
        this.emit('event', {
          sandboxId: id,
          method: 'session.output',
          params: {
            sessionId: params.sessionId,
            stream: 'stdout',
            seq: 0,
            data: Buffer.from('hi').toString('base64'),
          },
        }),
      );
      return { sessionId: params.sessionId };
    }
    return { ok: true, method };
  }
  answerAsk() {
    return { askId: 'a', status: 'answered' };
  }
}
