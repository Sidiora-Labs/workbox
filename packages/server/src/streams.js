import { E } from '@workbox/core';
import { isBound, sandboxVisible } from './access.js';

/**
 * Sandbox events pushed to API clients: the long-poll behind the events routes and the event
 * WebSockets, which replay stored rows after a sequence number and then turn live on the
 * Manager's `'logged'` rows with no gap and no duplicate. A bound principal gets only the events
 * of the sandboxes it can see: stored rows are filtered in SQL, live rows by `sandboxVisible`.
 */

/** The longest a long-poll waits for an event. */
export const MAX_WAIT_MS = 60_000;

/** Stored rows read per replay page. */
export const REPLAY_PAGE = 500;

/** The most type patterns one request may give. */
export const MAX_TYPE_PATTERNS = 32;

/** Sandbox rows an event filter remembers. */
const VISIBILITY_CACHE = 256;

const MAX_PATTERN_LENGTH = 128;

function invalidQuery(name, message) {
  return E.invalid(`invalid query.${name}: ${message}`, {
    errors: [{ path: `query.${name}`, message }],
  });
}

/**
 * The event type patterns of a `types` query: comma-separated, each an exact type or `prefix.*`.
 * The parameter may repeat. An absent or empty value means every type.
 * @param {URLSearchParams} search
 * @returns {string[]|undefined}
 */
export function parseTypes(search) {
  const given = search.getAll('types').filter((s) => s !== '');
  if (!given.length) return undefined;
  const types = given.flatMap((s) => s.split(',')).map((s) => s.trim());
  if (types.some((t) => !t || t.length > MAX_PATTERN_LENGTH))
    throw invalidQuery('types', 'must be event types or prefix.* patterns separated by commas');
  if (types.length > MAX_TYPE_PATTERNS)
    throw invalidQuery('types', `takes at most ${MAX_TYPE_PATTERNS} patterns`);
  return [...new Set(types)];
}

/**
 * A predicate over event types that agrees with the SQL of `store.listFleetEvents`: a pattern is
 * an exact type, or `prefix.*`, which matches every type starting with `prefix.`. No patterns
 * match every type.
 * @param {string[]|undefined} types
 * @returns {(type: string) => boolean}
 */
export function typeMatcher(types) {
  if (!types?.length) return () => true;
  const exact = new Set();
  const prefixes = [];
  for (const t of types) {
    if (t.endsWith('.*')) prefixes.push(t.slice(0, -1));
    else exact.add(t);
  }
  return (type) => exact.has(type) || prefixes.some((p) => type.startsWith(p));
}

function intQuery(search, name, max) {
  const value = search.get(name);
  if (value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw invalidQuery(name, 'must be a non-negative integer');
  if (max !== undefined && n > max) throw invalidQuery(name, `must be at most ${max}`);
  return n;
}

/**
 * @typedef {object} EventsQuery
 * @property {number} [afterSeq] return rows after this sequence number; absent on a stream means
 *   live only
 * @property {number} [limit] rows per answer (default 100, at most 1000)
 * @property {string[]} [types] type patterns
 * @property {string} [sandboxId] one sandbox only
 * @property {number} [waitMs] long-poll wait, 0..MAX_WAIT_MS
 */

/**
 * The query of an events route: `afterSeq`, `limit`, `types`, `waitMs`, and with `fleet` also
 * `sandboxId`. Malformed values are E_INVALID_PARAMS naming the parameter.
 * @param {URL} url
 * @param {{fleet?: boolean}} [opts]
 * @returns {EventsQuery}
 */
export function eventsQuery(url, opts = {}) {
  const s = url.searchParams;
  const query = {
    afterSeq: intQuery(s, 'afterSeq'),
    limit: intQuery(s, 'limit'),
    types: parseTypes(s),
    waitMs: intQuery(s, 'waitMs', MAX_WAIT_MS) ?? 0,
  };
  if (opts.fleet) {
    const sandboxId = s.get('sandboxId');
    if (sandboxId !== null && sandboxId !== '') query.sandboxId = sandboxId;
  }
  return query;
}

/**
 * The live-row filter of one request or stream: its types, its sandbox, and for a bound principal
 * the sandboxes it can see. Visible sandbox rows are remembered (at most 256, oldest dropped
 * first); a sandbox not found is looked up again on its next event.
 * @param {{getSandbox: (id: string) => object|null}} store
 * @param {{types?: string[], sandboxId?: string, principal?: object|null}} query
 * @returns {(row: {sandboxId: string, type: string}) => boolean}
 */
export function eventFilter(store, query) {
  const typeOk = typeMatcher(query.types);
  const principal = query.principal;
  const bound = isBound(principal);
  const seen = new Map();
  const visible = (id) => {
    if (seen.has(id)) return seen.get(id);
    const row = store.getSandbox(id);
    if (!row) return false;
    const ok = sandboxVisible(principal, row);
    if (seen.size >= VISIBILITY_CACHE) seen.delete(seen.keys().next().value);
    seen.set(id, ok);
    return ok;
  };
  return (row) => {
    if (query.sandboxId !== undefined && row.sandboxId !== query.sandboxId) return false;
    if (!typeOk(row.type)) return false;
    return !bound || visible(row.sandboxId);
  };
}

/**
 * One `'logged'` listener on the Manager shared by every subscriber of a server or a CLI follow,
 * attached while there is at least one subscriber.
 */
export class EventHub {
  /** @param {import('node:events').EventEmitter & {store: object}} manager the core Manager */
  constructor(manager) {
    this.manager = manager;
    /** @type {Set<(row: object) => void>} */
    this.subscribers = new Set();
    this.onRow = (row) => {
      let failure = null;
      for (const fn of [...this.subscribers]) {
        try {
          fn(row);
        } catch (e) {
          failure ??= e;
        }
      }
      if (failure) throw failure;
    };
  }

  /** Subscribers right now. */
  get size() {
    return this.subscribers.size;
  }

  /**
   * Call `fn` with every row logged from now on.
   * @param {(row: object) => void} fn
   * @returns {() => void} unsubscribe
   */
  subscribe(fn) {
    if (!this.subscribers.size) this.manager.on('logged', this.onRow);
    this.subscribers.add(fn);
    return () => {
      if (!this.subscribers.delete(fn)) return;
      if (!this.subscribers.size) this.manager.off('logged', this.onRow);
    };
  }
}

function fleetPage(store, query, afterSeq, limit) {
  return store.listFleetEvents({
    afterSeq,
    limit,
    types: query.types,
    sandboxId: query.sandboxId,
    binding: query.principal?.binding ?? null,
  });
}

/**
 * Stored events after `afterSeq` (default 0). With `waitMs` and nothing stored yet, wait for the
 * next matching row to be logged, the timeout, or the signal (the client went away, or the server
 * is shutting down), then answer. `nextSeq` is the last returned seq, or `afterSeq` when empty.
 * @param {EventHub} hub
 * @param {EventsQuery & {principal?: object|null}} query
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{events: object[], nextSeq: number}>}
 */
export async function pollEvents(hub, query, opts = {}) {
  const store = hub.manager.store;
  const afterSeq = query.afterSeq ?? 0;
  const list = () => fleetPage(store, query, afterSeq, query.limit);
  let events = list();
  if (!events.length && query.waitMs > 0 && !opts.signal?.aborted) {
    const accept = eventFilter(store, query);
    const woke = await nextRow(hub, (row) => row.seq > afterSeq && accept(row), query.waitMs, opts);
    if (woke) events = list();
  }
  return { events, nextSeq: events.length ? events[events.length - 1].seq : afterSeq };
}

/** Resolve true on the first row `accept` takes, false at the timeout or on abort. */
function nextRow(hub, accept, waitMs, { signal }) {
  return new Promise((resolve) => {
    let unsubscribe = null;
    const done = (value) => {
      clearTimeout(timer);
      unsubscribe?.();
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), waitMs);
    unsubscribe = hub.subscribe((row) => {
      if (accept(row)) done(true);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The merge of a replay with live rows. While the replay runs, live rows are buffered; rows at or
 * below the last delivered seq are dropped, so the switch to live has no gap and no duplicate.
 */
export class ReplayMerge {
  /** @param {number} lastSeq the last seq already delivered or skipped */
  constructor(lastSeq) {
    this.lastSeq = lastSeq;
    this.replaying = true;
    /** @type {{seq: number}[]} */
    this.pending = [];
  }

  /**
   * A stored row read by the replay, or a buffered one being flushed.
   * @param {{seq: number}} row
   * @returns {boolean} true when it is new and is to be delivered
   */
  replayed(row) {
    if (row.seq <= this.lastSeq) return false;
    this.lastSeq = row.seq;
    return true;
  }

  /**
   * A live row. During the replay it is buffered and false is returned; afterwards, true when it
   * is new.
   * @param {{seq: number}} row
   * @returns {boolean}
   */
  live(row) {
    if (!this.replaying) return this.replayed(row);
    if (row.seq > this.lastSeq) this.pending.push(row);
    return false;
  }

  /** Forget buffered rows the replay has already delivered. */
  trim() {
    this.pending = this.pending.filter((r) => r.seq > this.lastSeq);
  }

  /**
   * End the replay. Returns the buffered rows still to deliver, in seq order; later live rows
   * pass straight through {@link ReplayMerge#live}.
   * @returns {{seq: number}[]}
   */
  goLive() {
    this.replaying = false;
    const rows = this.pending.sort((x, y) => x.seq - y.seq);
    this.pending = [];
    return rows.filter((r) => this.replayed(r));
  }
}

/**
 * @typedef {object} FeedSink
 * @property {(row: object) => void} send deliver one event row
 * @property {() => Promise<void>|null} [ready] during the replay, a promise to wait on before
 *   the next row (backpressure), or null to go on
 * @property {(seq: number) => void} [live] called once when the feed turns live: every matching
 *   row up to `seq` has been delivered, later ones follow as they are logged
 */

/**
 * Stored events after `afterSeq`, then live ones as they are logged. Without `afterSeq` the feed
 * is live from the start.
 */
export class EventFeed {
  /**
   * @param {EventHub} hub
   * @param {{afterSeq?: number, types?: string[], sandboxId?: string, principal?: object|null}} query
   * @param {FeedSink} sink
   */
  constructor(hub, query, sink) {
    this.hub = hub;
    this.query = query;
    this.sink = sink;
    this.closed = false;
    this.unsubscribe = null;
  }

  /**
   * Replay, then turn live. Resolves once live, or once closed during the replay; a failure
   * closes the feed and rejects.
   */
  async start() {
    if (this.closed) return;
    try {
      await this.#run();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  async #run() {
    const store = this.hub.manager.store;
    const accept = eventFilter(store, this.query);
    const replay = this.query.afterSeq !== undefined;
    const merge = new ReplayMerge(replay ? this.query.afterSeq : store.lastEventSeq());
    this.unsubscribe = this.hub.subscribe((row) => {
      if (!this.closed && accept(row) && merge.live(row)) this.sink.send(row);
    });
    if (replay) {
      for (;;) {
        const page = fleetPage(store, this.query, merge.lastSeq, REPLAY_PAGE);
        for (const row of page) {
          const wait = this.sink.ready?.();
          if (wait) await wait;
          if (this.closed) return;
          if (merge.replayed(row)) this.sink.send(row);
        }
        merge.trim();
        if (page.length < REPLAY_PAGE) break;
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        if (this.closed) return;
      }
    }
    for (const row of merge.goLive()) this.sink.send(row);
    this.sink.live?.(Math.max(merge.lastSeq, store.lastEventSeq()));
  }

  /** Stop delivering and drop the subscription. */
  close() {
    this.closed = true;
    this.unsubscribe?.();
  }
}

/**
 * A promise that settles when `stream` has drained its write buffer or closed, or null when it
 * can take more now.
 * @param {import('node:stream').Writable} stream
 * @returns {Promise<void>|null}
 */
export function drained(stream) {
  if (!stream.writableNeedDrain || stream.destroyed) return null;
  return new Promise((resolve) => {
    const done = () => {
      stream.off('drain', done);
      stream.off('close', done);
      resolve();
    };
    stream.on('drain', done);
    stream.on('close', done);
  });
}

/**
 * Serve an event WebSocket: frames `{"type":"event","event":{...}}`, and `{"type":"live","seq":N}`
 * once when the stream turns live. The replay waits on the socket's buffer; live rows go out as
 * they come and a consumer that falls too far behind is dropped by the socket's backpressure rule.
 * @param {EventHub} hub
 * @param {import('./ws.js').WsSocket} ws
 * @param {{afterSeq?: number, types?: string[], sandboxId?: string, principal?: object|null}} query
 * @returns {Promise<void>}
 */
export async function streamEvents(hub, ws, query) {
  const feed = new EventFeed(hub, query, {
    send: (row) => ws.send(JSON.stringify({ type: 'event', event: row })),
    ready: () => drained(ws.socket),
    live: (seq) => ws.send(JSON.stringify({ type: 'live', seq })),
  });
  ws.onClose(() => feed.close());
  try {
    await feed.start();
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', code: e.code ?? 'E_INTERNAL', message: e.message }));
    ws.close(1011);
  }
}
