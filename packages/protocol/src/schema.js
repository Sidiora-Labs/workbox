/**
 * A small, dependency-free validator. Schemas are plain objects produced by the helpers below;
 * validate() returns every problem with its JSON path so callers can report precisely.
 */

/** @typedef {{ok: true} | {ok: false, errors: {path: string, message: string}[]}} Result */

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
  /** @type {{path: string, message: string}[]} */
  const errors = [];
  check(schema, value, path, errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} name used in the thrown message
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

function check(s, val, path, errors) {
  if (val === undefined) {
    if (!s.optional) errors.push({ path, message: 'is required' });
    return;
  }
  if (val === null) {
    if (!s.nullable && s.kind !== 'any') errors.push({ path, message: 'must not be null' });
    return;
  }
  switch (s.kind) {
    case 'any':
      return;
    case 'string':
      if (typeof val !== 'string') return void errors.push({ path, message: 'must be a string' });
      if (s.min !== undefined && val.length < s.min)
        errors.push({ path, message: `must have at least ${s.min} characters` });
      if (s.max !== undefined && val.length > s.max)
        errors.push({ path, message: `must have at most ${s.max} characters` });
      if (s.pattern && !s.pattern.test(val))
        errors.push({ path, message: `must match ${s.pattern}` });
      return;
    case 'integer':
    case 'number':
      if (typeof val !== 'number' || Number.isNaN(val))
        return void errors.push({ path, message: 'must be a number' });
      if (s.kind === 'integer' && !Number.isInteger(val))
        errors.push({ path, message: 'must be an integer' });
      if (s.min !== undefined && val < s.min) errors.push({ path, message: `must be >= ${s.min}` });
      if (s.max !== undefined && val > s.max) errors.push({ path, message: `must be <= ${s.max}` });
      return;
    case 'boolean':
      if (typeof val !== 'boolean') errors.push({ path, message: 'must be a boolean' });
      return;
    case 'enum':
      if (!s.values.includes(val))
        errors.push({ path, message: `must be one of ${s.values.join(', ')}` });
      return;
    case 'array':
      if (!Array.isArray(val)) return void errors.push({ path, message: 'must be an array' });
      if (s.min !== undefined && val.length < s.min)
        errors.push({ path, message: `must have at least ${s.min} items` });
      if (s.max !== undefined && val.length > s.max)
        errors.push({ path, message: `must have at most ${s.max} items` });
      val.forEach((item, i) => check(s.items, item, `${path}[${i}]`, errors));
      return;
    case 'object': {
      if (typeof val !== 'object' || Array.isArray(val))
        return void errors.push({ path, message: 'must be an object' });
      for (const key of s.required) {
        if (val[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'is required' });
      }
      for (const [key, sub] of Object.entries(s.props)) {
        if (val[key] === undefined) continue;
        check(sub, val[key], `${path}.${key}`, errors);
      }
      if (!s.additional) {
        for (const key of Object.keys(val)) {
          if (!(key in s.props)) errors.push({ path: `${path}.${key}`, message: 'is not allowed' });
        }
      }
      return;
    }
    case 'record':
      if (typeof val !== 'object' || Array.isArray(val))
        return void errors.push({ path, message: 'must be an object' });
      for (const [key, item] of Object.entries(val)) {
        if (s.keyPattern && !s.keyPattern.test(key))
          errors.push({ path: `${path}.${key}`, message: `key must match ${s.keyPattern}` });
        check(s.values, item, `${path}.${key}`, errors);
      }
      if (s.max !== undefined && Object.keys(val).length > s.max)
        errors.push({ path, message: `must have at most ${s.max} keys` });
      return;
    case 'oneOf': {
      for (const sub of s.schemas) {
        const r = validate(sub, val, path);
        if (r.ok) return;
      }
      errors.push({ path, message: 'matches none of the allowed shapes' });
      return;
    }
    default:
      errors.push({ path, message: `unknown schema kind ${s.kind}` });
  }
}
