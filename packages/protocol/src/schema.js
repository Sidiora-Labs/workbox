/**
 * A small, dependency-free validator. Schemas are plain objects produced by the helpers below;
 * validate() returns every problem with its JSON path so callers can report precisely.
 */

/** @typedef {{path: string, message: string}} Problem */
/** @typedef {{ok: true} | {ok: false, errors: Problem[]}} Result */

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
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {Result}
 */
export function validate(schema, value, path = '$') {
  /** @type {Problem[]} */
  const errors = [];
  check(schema, value, path, errors);
  return errors.length ? { ok: false, errors } : { ok: true };
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
 * @param {object} s schema
 * @param {unknown} val
 * @param {string} path
 * @param {Problem[]} errors
 */
function check(s, val, path, errors) {
  if (val === undefined) {
    if (!s.optional) errors.push({ path, message: 'is required' });
    return;
  }
  if (val === null) {
    if (!s.nullable && s.kind !== 'any') errors.push({ path, message: 'must not be null' });
    return;
  }
  const fn = KINDS[s.kind];
  if (!fn) {
    errors.push({ path, message: `unknown schema kind ${s.kind}` });
    return;
  }
  fn(s, val, path, errors);
}

/** @param {Problem[]} errors */
function bounds(s, actual, noun, path, errors) {
  if (s.min !== undefined && actual < s.min)
    errors.push({ path, message: `must have at least ${s.min} ${noun}` });
  if (s.max !== undefined && actual > s.max)
    errors.push({ path, message: `must have at most ${s.max} ${noun}` });
}

function checkString(s, val, path, errors) {
  if (typeof val !== 'string') {
    errors.push({ path, message: 'must be a string' });
    return;
  }
  bounds(s, val.length, 'characters', path, errors);
  if (s.pattern && !s.pattern.test(val)) errors.push({ path, message: `must match ${s.pattern}` });
}

function checkNumber(s, val, path, errors) {
  if (typeof val !== 'number' || Number.isNaN(val)) {
    errors.push({ path, message: 'must be a number' });
    return;
  }
  if (s.kind === 'integer' && !Number.isInteger(val))
    errors.push({ path, message: 'must be an integer' });
  if (s.min !== undefined && val < s.min) errors.push({ path, message: `must be >= ${s.min}` });
  if (s.max !== undefined && val > s.max) errors.push({ path, message: `must be <= ${s.max}` });
}

function checkBoolean(_s, val, path, errors) {
  if (typeof val !== 'boolean') errors.push({ path, message: 'must be a boolean' });
}

function checkEnum(s, val, path, errors) {
  if (!s.values.includes(val))
    errors.push({ path, message: `must be one of ${s.values.join(', ')}` });
}

function checkArray(s, val, path, errors) {
  if (!Array.isArray(val)) {
    errors.push({ path, message: 'must be an array' });
    return;
  }
  bounds(s, val.length, 'items', path, errors);
  val.forEach((item, i) => check(s.items, item, `${path}[${i}]`, errors));
}

function isObjectLike(val) {
  return typeof val === 'object' && !Array.isArray(val);
}

function checkObject(s, val, path, errors) {
  if (!isObjectLike(val)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  for (const key of s.required) {
    if (val[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'is required' });
  }
  for (const [key, sub] of Object.entries(s.props)) {
    if (val[key] !== undefined) check(sub, val[key], `${path}.${key}`, errors);
  }
  if (s.additional) return;
  for (const key of Object.keys(val)) {
    if (!(key in s.props)) errors.push({ path: `${path}.${key}`, message: 'is not allowed' });
  }
}

function checkRecord(s, val, path, errors) {
  if (!isObjectLike(val)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const entries = Object.entries(val);
  for (const [key, item] of entries) {
    if (s.keyPattern && !s.keyPattern.test(key)) {
      errors.push({ path: `${path}.${key}`, message: `key must match ${s.keyPattern}` });
    }
    check(s.values, item, `${path}.${key}`, errors);
  }
  if (s.max !== undefined && entries.length > s.max)
    errors.push({ path, message: `must have at most ${s.max} keys` });
}

function checkOneOf(s, val, path, errors) {
  if (s.schemas.some((sub) => validate(sub, val, path).ok)) return;
  errors.push({ path, message: 'matches none of the allowed shapes' });
}

const KINDS = {
  any: () => undefined,
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
