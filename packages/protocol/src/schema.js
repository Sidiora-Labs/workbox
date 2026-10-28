/**
 * A small, dependency-free validator. Schemas are plain objects produced by the helpers below;
 * validate() returns every problem with its JSON path so callers can report precisely.
 */

/** @typedef {{path: string, message: string, limit?: 'depth'|'nodes'}} Problem */
/** @typedef {{ok: true} | {ok: false, errors: Problem[]}} Result */
/** @typedef {{nodes: number, maxDepth: number, maxNodes: number, refused: Problem|null}} Budget */
/** @typedef {{errors: Problem[], budget: Budget}} Ctx */

/** Deepest nesting validate() walks; the root value is depth 0. */
export const MAX_DEPTH = 64;
/** Most values validate() visits in one document, `any` subtrees included. */
export const MAX_NODES = 100_000;

export const v = {
  string: (o = {}) => ({ kind: 'string', ...o }),
  integer: (o = {}) => ({ kind: 'integer', ...o }),
  number: (o = {}) => ({ kind: 'number', ...o }),
  boolean: () => ({ kind: 'boolean' }),
  any: () => ({ kind: 'any' }),
  enum: (values) => ({ kind: 'enum', values }),
  array: (items, o = {}) => ({ kind: 'array', items, ...o }),
  object: (props, o = {}) => ({
    kind: 'object',
    props,
    required: o.required ?? [],
    additional: o.additional ?? false,
  }),
  record: (values, o = {}) => ({ kind: 'record', values, ...o }),
  optional: (schema) => ({ ...schema, optional: true }),
  nullable: (schema) => ({ ...schema, nullable: true }),
  oneOf: (schemas) => ({ kind: 'oneOf', schemas }),
};

/**
 * A document deeper than maxDepth or larger than maxNodes is refused with a single problem
 * carrying `limit`, without walking the rest of it.
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @param {{maxDepth?: number, maxNodes?: number}} [opts]
 * @returns {Result}
 */
export function validate(schema, value, path = '$', opts = {}) {
  /** @type {Ctx} */
  const ctx = {
    errors: [],
    budget: {
      nodes: 0,
      maxDepth: opts.maxDepth ?? MAX_DEPTH,
      maxNodes: opts.maxNodes ?? MAX_NODES,
      refused: null,
    },
  };
  check(schema, value, path, ctx, 0);
  if (ctx.budget.refused) return { ok: false, errors: [ctx.budget.refused] };
  return ctx.errors.length ? { ok: false, errors: ctx.errors } : { ok: true };
}

/**
 * Throw an error carrying code E_INVALID_PARAMS and the problem list when the value is invalid.
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [name] used in the thrown message
 */
export function assertValid(schema, value, name = 'value') {
  const r = validate(schema, value);
  if (!r.ok) {
    const e = new Error(
      `invalid ${name}: ${r.errors.map((x) => `${x.path} ${x.message}`).join('; ')}`,
    );
    e.code = 'E_INVALID_PARAMS';
    e.data = { errors: r.errors };
    throw e;
  }
}

/**
 * Count one visited value against the budget; false once the document has been refused.
 * @param {Budget} budget
 * @param {string} path
 * @param {number} depth
 */
function spend(budget, path, depth) {
  if (budget.refused) return false;
  if (depth > budget.maxDepth) {
    budget.refused = {
      path,
      message: `exceeds the maximum depth of ${budget.maxDepth}`,
      limit: 'depth',
    };
    return false;
  }
  if (++budget.nodes > budget.maxNodes) {
    budget.refused = {
      path,
      message: `exceeds the maximum of ${budget.maxNodes} values`,
      limit: 'nodes',
    };
    return false;
  }
  return true;
}

/**
 * @param {object} s schema
 * @param {unknown} val
 * @param {string} path
 * @param {Ctx} ctx
 * @param {number} depth
 */
function check(s, val, path, ctx, depth) {
  const { errors } = ctx;
  if (val === undefined) {
    if (!s.optional) errors.push({ path, message: 'is required' });
    return;
  }
  if (!spend(ctx.budget, path, depth)) return;
  if (val === null) {
    if (!s.nullable && s.kind !== 'any') errors.push({ path, message: 'must not be null' });
    return;
  }
  const fn = KINDS[s.kind];
  if (!fn) {
    errors.push({ path, message: `unknown schema kind ${s.kind}` });
    return;
  }
  fn(s, val, path, ctx, depth);
}

/**
 * Walk an `any` value iteratively so its depth and size count against the budget too.
 * @param {object} _s
 * @param {unknown} val already counted by check()
 * @param {string} path
 * @param {Ctx} ctx
 * @param {number} depth
 */
function scanAny(_s, val, path, ctx, depth) {
  const stack = [[val, depth]];
  while (stack.length) {
    const [cur, d] = stack.pop();
    if (cur === null || typeof cur !== 'object') continue;
    for (const child of Object.values(cur)) {
      if (!spend(ctx.budget, path, d + 1)) return;
      stack.push([child, d + 1]);
    }
  }
}

/** @param {Problem[]} errors */
function bounds(s, actual, noun, path, errors) {
  if (s.min !== undefined && actual < s.min)
    errors.push({ path, message: `must have at least ${s.min} ${noun}` });
  if (s.max !== undefined && actual > s.max)
    errors.push({ path, message: `must have at most ${s.max} ${noun}` });
}

function checkString(s, val, path, { errors }) {
  if (typeof val !== 'string') {
    errors.push({ path, message: 'must be a string' });
    return;
  }
  bounds(s, Buffer.byteLength(val, 'utf8'), 'bytes', path, errors);
  if (s.pattern && !s.pattern.test(val)) errors.push({ path, message: `must match ${s.pattern}` });
}

function checkNumber(s, val, path, { errors }) {
  if (typeof val !== 'number' || Number.isNaN(val)) {
    errors.push({ path, message: 'must be a number' });
    return;
  }
  if (s.kind === 'integer' && !Number.isInteger(val))
    errors.push({ path, message: 'must be an integer' });
  if (s.min !== undefined && val < s.min) errors.push({ path, message: `must be >= ${s.min}` });
  if (s.max !== undefined && val > s.max) errors.push({ path, message: `must be <= ${s.max}` });
}

function checkBoolean(_s, val, path, { errors }) {
  if (typeof val !== 'boolean') errors.push({ path, message: 'must be a boolean' });
}

function checkEnum(s, val, path, { errors }) {
  if (!s.values.includes(val))
    errors.push({ path, message: `must be one of ${s.values.join(', ')}` });
}

function checkArray(s, val, path, ctx, depth) {
  if (!Array.isArray(val)) {
    ctx.errors.push({ path, message: 'must be an array' });
    return;
  }
  bounds(s, val.length, 'items', path, ctx.errors);
  for (let i = 0; i < val.length && !ctx.budget.refused; i++)
    check(s.items, val[i], `${path}[${i}]`, ctx, depth + 1);
}

function isObjectLike(val) {
  return typeof val === 'object' && !Array.isArray(val);
}

function checkObject(s, val, path, ctx, depth) {
  const { errors } = ctx;
  if (!isObjectLike(val)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  for (const key of s.required) {
    if (val[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'is required' });
  }
  for (const [key, sub] of Object.entries(s.props)) {
    if (val[key] !== undefined) check(sub, val[key], `${path}.${key}`, ctx, depth + 1);
  }
  if (s.additional) return;
  for (const key of Object.keys(val)) {
    if (!(key in s.props)) errors.push({ path: `${path}.${key}`, message: 'is not allowed' });
  }
}

function checkRecord(s, val, path, ctx, depth) {
  const { errors } = ctx;
  if (!isObjectLike(val)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const entries = Object.entries(val);
  for (const [key, item] of entries) {
    if (ctx.budget.refused) return;
    if (s.keyPattern && !s.keyPattern.test(key)) {
      errors.push({ path: `${path}.${key}`, message: `key must match ${s.keyPattern}` });
    }
    check(s.values, item, `${path}.${key}`, ctx, depth + 1);
  }
  if (s.max !== undefined && entries.length > s.max)
    errors.push({ path, message: `must have at most ${s.max} keys` });
}

function checkOneOf(s, val, path, ctx, depth) {
  // Alternatives share the budget, so nesting oneOf cannot reset the depth or node count.
  const matched = s.schemas.some((sub) => {
    const alt = { errors: [], budget: ctx.budget };
    check(sub, val, path, alt, depth);
    return !ctx.budget.refused && alt.errors.length === 0;
  });
  if (!matched && !ctx.budget.refused)
    ctx.errors.push({ path, message: 'matches none of the allowed shapes' });
}

const KINDS = {
  any: scanAny,
  string: checkString,
  integer: checkNumber,
  number: checkNumber,
  boolean: checkBoolean,
  enum: checkEnum,
  array: checkArray,
  object: checkObject,
  record: checkRecord,
  oneOf: checkOneOf,
};
