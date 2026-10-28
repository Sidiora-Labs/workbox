import { E } from '../errors.js';

/**
 * `broker.ask.*`: human asks. Answers arrive only through the host API (`answerAskHost`), never
 * through wb — the broker surface deliberately has no answer method. Per-kind answer schemas:
 * question=string, decision=one of options, permission=boolean, secret=ref name only.
 */

/** @param {object} ctx @param {object} params */
export function askRaise(ctx, params) {
  if (params.kind === 'decision' && (!Array.isArray(params.options) || params.options.length === 0))
    throw E.invalid('decision asks require options');
  const ask = ctx.store.createAsk({ sandboxId: ctx.sandboxId, ...params });
  ctx.audit?.append({
    actor: 'broker',
    action: 'ask.raise',
    sandboxId: ctx.sandboxId,
    data: { askId: ask.id, kind: ask.kind, title: ask.title },
  });
  ctx.onAsk?.(ask);
  return publicAsk(ask);
}

/** @param {object} ctx @param {{askId: string}} params */
export function askStatus(ctx, params) {
  ctx.store.expireAsks();
  const ask = ctx.store.getAsk(params.askId);
  if (!ask || ask.sandboxId !== ctx.sandboxId)
    throw E.notFound(`ask ${params.askId} not found`, { askId: params.askId });
  return publicAsk(ask);
}

/** @param {object} ctx @param {{status?: string}} params */
export function askList(ctx, params) {
  ctx.store.expireAsks();
  return {
    asks: ctx.store
      .listAsks({ sandboxId: ctx.sandboxId, status: params.status ?? 'all' })
      .map(publicAsk),
  };
}

/**
 * Block until answered/expired or the timeout passes. Polls the store; the ask row is the truth.
 * @param {object} ctx @param {{askId: string, timeoutMs?: number}} params
 * @param {{signal?: AbortSignal, pollMs?: number}} [opts]
 */
export async function askWait(ctx, params, opts = {}) {
  const timeoutMs = params.timeoutMs ?? 300_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ask = askStatus(ctx, params);
    if (ask.status !== 'open') return ask;
    if (opts.signal?.aborted) throw E.invalid('ask wait aborted');
    if (Date.now() >= deadline)
      throw E.timeout(`ask ${params.askId} not answered within ${timeoutMs} ms`, {
        askId: params.askId,
      });
    await new Promise((r) => {
      setTimeout(r, Math.min(opts.pollMs ?? 250, Math.max(1, deadline - Date.now())));
    });
  }
}

/**
 * Host-only answer path (REST/manager). Validates the answer against the ask kind.
 * @param {object} ctx @param {string} askId @param {{answer: unknown, by?: string}} input
 */
export function answerAskHost(ctx, askId, input) {
  const ask = ctx.store.getAsk(askId);
  if (!ask) throw E.notFound(`ask ${askId} not found`, { askId });
  validateAnswer(ask, input.answer);
  const answered = ctx.store.answerAsk(askId, input);
  ctx.audit?.append({
    actor: input.by ?? 'host',
    action: 'ask.answer',
    sandboxId: ask.sandboxId,
    data: { askId, kind: ask.kind },
  });
  return publicAsk(answered);
}

/** @param {object} ask @param {unknown} answer */
export function validateAnswer(ask, answer) {
  switch (ask.kind) {
    case 'question':
      if (typeof answer !== 'string' || answer.length === 0)
        throw E.invalid('question answer must be a non-empty string');
      break;
    case 'decision':
      if (!Array.isArray(ask.options) || !ask.options.includes(answer))
        throw E.invalid('decision answer must be one of the options', { options: ask.options });
      break;
    case 'permission':
      if (typeof answer !== 'boolean') throw E.invalid('permission answer must be boolean');
      break;
    case 'secret':
      if (typeof answer !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(answer))
        throw E.invalid('secret answer must be a secret reference name, never a value');
      break;
    default:
      throw E.invalid(`unknown ask kind ${ask.kind}`);
  }
}

/** @param {object} ask */
export function publicAsk(ask) {
  return {
    askId: ask.id,
    sandboxId: ask.sandboxId,
    kind: ask.kind,
    title: ask.title,
    body: ask.body,
    options: ask.options,
    recommended: ask.recommended,
    status: ask.status,
    answer: ask.answer,
    createdAt: ask.createdAt,
    expiresAt: ask.expiresAt,
    answeredAt: ask.answeredAt,
  };
}
