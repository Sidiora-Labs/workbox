import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Methods, v } from '@workbox/protocol';
import {
  BASE64_PATTERN,
  OPENAPI_PATH,
  PUBLIC_ROUTES,
  ROUTE_DOCS,
  SERVER_VERSION,
  allRoutes,
  buildOpenApi,
  openApiPath,
  patternOf,
  routeDocProblems,
  toJsonSchema,
} from '../../src/openapi.js';
import { BODY_SCHEMAS } from '../../src/server.js';
import { FLEET_ROUTES, KEY_CREATE_SCHEMA, SCOPE_MATRIX } from '../../src/auth.js';
import { WEBHOOK_CREATE_SCHEMA, WEBHOOK_UPDATE_SCHEMA } from '../../src/webhooks.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'];

/** Every operation of a document as [key, operation], key `METHOD /path`. */
function operations(api) {
  return Object.entries(api.paths).flatMap(([p, item]) =>
    METHODS.filter((m) => item[m]).map((m) => [`${m.toUpperCase()} ${p}`, item[m]]),
  );
}

/** Every `$ref` value in a JSON value. */
function refs(value, out = []) {
  if (Array.isArray(value)) for (const x of value) refs(x, out);
  else if (value && typeof value === 'object')
    for (const [k, x] of Object.entries(value)) {
      if (k === '$ref') out.push(x);
      else refs(x, out);
    }
  return out;
}

function resolvePointer(api, ref) {
  assert.ok(ref.startsWith('#/'), ref);
  return ref
    .slice(2)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((node, key) => (node && Object.hasOwn(node, key) ? node[key] : undefined), api);
}

/** The schema kinds and modifiers a `v` schema tree uses. */
function kindsOf(schema, out = new Set()) {
  out.add(schema.kind);
  if (schema.nullable) out.add('nullable');
  if (schema.pattern) out.add('pattern');
  if (schema.keyPattern) out.add('keyPattern');
  if (schema.kind === 'object') for (const sub of Object.values(schema.props)) kindsOf(sub, out);
  if (schema.kind === 'array') kindsOf(schema.items, out);
  if (schema.kind === 'record') kindsOf(schema.values, out);
  if (schema.kind === 'oneOf') for (const sub of schema.schemas) kindsOf(sub, out);
  return out;
}

const doc = buildOpenApi({ version: SERVER_VERSION });

test('strings keep their bounds and pattern; the protocol base64 string is marked', () => {
  assert.deepEqual(toJsonSchema(v.string({ min: 1, max: 64 })), {
    type: 'string',
    minLength: 1,
    maxLength: 64,
  });
  assert.deepEqual(toJsonSchema(v.string({ pattern: /^SIG[A-Z0-9]{2,8}$/ })), {
    type: 'string',
    pattern: '^SIG[A-Z0-9]{2,8}$',
  });
  const data = toJsonSchema(Methods['fs.write'].params.props.data);
  assert.equal(data.pattern, BASE64_PATTERN);
  assert.equal(data.contentEncoding, 'base64');
  assert.equal(data.maxLength, 6 * 1024 * 1024);
  assert.match(data.description, /base64/i);
});

test('numbers, booleans, any and enums', () => {
  assert.deepEqual(toJsonSchema(v.integer({ min: 0, max: 0o7777 })), {
    type: 'integer',
    minimum: 0,
    maximum: 4095,
  });
  assert.deepEqual(toJsonSchema(v.number({ min: 0.5 })), { type: 'number', minimum: 0.5 });
  assert.deepEqual(toJsonSchema(v.boolean()), { type: 'boolean' });
  assert.deepEqual(toJsonSchema(v.any()), {});
  assert.deepEqual(toJsonSchema(v.nullable(v.any())), {}, 'any already admits null');
  assert.deepEqual(toJsonSchema(v.enum(['a', 'b'])), { type: 'string', enum: ['a', 'b'] });
  assert.deepEqual(toJsonSchema(v.enum([1, 2])), { type: 'integer', enum: [1, 2] });
  assert.deepEqual(toJsonSchema(v.enum(['a', 1])), { enum: ['a', 1] });
  assert.deepEqual(toJsonSchema(v.nullable(v.enum(['a']))), {
    type: ['string', 'null'],
    enum: ['a', null],
  });
});

test('nullable widens the type; optional shows only in the parent required list', () => {
  assert.deepEqual(toJsonSchema(v.nullable(v.string({ max: 3 }))), {
    type: ['string', 'null'],
    maxLength: 3,
  });
  assert.deepEqual(toJsonSchema(v.optional(v.integer())), { type: 'integer' });
  const update = toJsonSchema(WEBHOOK_UPDATE_SCHEMA);
  assert.deepEqual(update.properties.description, { type: ['string', 'null'], maxLength: 1024 });
  assert.equal(update.required, undefined, 'every field of the patch is optional');
  assert.equal(update.additionalProperties, false);
});

test('arrays, objects, records and oneOf', () => {
  assert.deepEqual(toJsonSchema(v.array(v.string(), { min: 1, max: 4 })), {
    type: 'array',
    items: { type: 'string' },
    minItems: 1,
    maxItems: 4,
  });
  assert.deepEqual(
    toJsonSchema(v.object({ a: v.string(), b: v.optional(v.boolean()) }, { required: ['a'] })),
    {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'boolean' } },
      required: ['a'],
      additionalProperties: false,
    },
  );
  assert.deepEqual(toJsonSchema(v.object({}, { additional: true })), {
    type: 'object',
    properties: {},
  });
  assert.deepEqual(toJsonSchema(v.record(v.string({ max: 256 }), { max: 32 })), {
    type: 'object',
    additionalProperties: { type: 'string', maxLength: 256 },
    maxProperties: 32,
  });
  assert.deepEqual(toJsonSchema(Methods['session.start'].params.props.env), {
    type: 'object',
    additionalProperties: { type: 'string', maxLength: 32 * 1024 },
    maxProperties: 512,
    propertyNames: { pattern: '^[A-Za-z_][A-Za-z0-9_]*$' },
  });
  assert.deepEqual(toJsonSchema(v.oneOf([v.string(), v.integer()])), {
    oneOf: [{ type: 'string' }, { type: 'integer' }],
  });
  assert.deepEqual(toJsonSchema(v.nullable(v.oneOf([v.string()]))), {
    oneOf: [{ type: 'string' }, { type: 'null' }],
  });
  assert.throws(() => toJsonSchema({ kind: 'tuple' }), /unknown schema kind tuple/);
});

test('patterns: the s flag is spelled out, u is kept, other flags are refused', () => {
  assert.equal(patternOf(/^.{1,128}$/su), '^[\\s\\S]{1,128}$');
  assert.equal(patternOf(/^a\.b[.x]c.$/s), '^a\\.b[.x]c[\\s\\S]$');
  assert.equal(patternOf(/^[\]a.]+$/s), '^[\\]a.]+$');
  assert.equal(patternOf(/^x+$/u), '^x+$');
  assert.throws(() => patternOf(/^x$/i), /cannot express: i/);
  const labels = toJsonSchema(KEY_CREATE_SCHEMA).properties.labels;
  assert.deepEqual(labels.propertyNames, { pattern: '^[\\s\\S]{1,128}$' });
  assert.ok(new RegExp(labels.propertyNames.pattern, 'u').test('line\nbreak'));
  assert.equal(new RegExp(labels.propertyNames.pattern, 'u').test(''), false);
});

test("every schema kind the server's bodies use converts, and each body is in the document", () => {
  const used = new Set();
  for (const [route, schema] of Object.entries(BODY_SCHEMAS)) {
    assert.ok(route in SCOPE_MATRIX, `${route} has a body but no route`);
    kindsOf(schema, used);
    const [method, template] = route.split(' ');
    const op = doc.paths[openApiPath(template)][method.toLowerCase()];
    const media = op.requestBody?.content?.['application/json'];
    assert.ok(media, `${route} documents its JSON body`);
    assert.deepEqual(media.schema, toJsonSchema(schema), route);
    assert.equal(op.requestBody.required, schema.required.length > 0, route);
  }
  for (const kind of [
    'object',
    'string',
    'integer',
    'boolean',
    'any',
    'enum',
    'array',
    'record',
    'nullable',
    'pattern',
    'keyPattern',
  ])
    assert.ok(used.has(kind), `the bodies use ${kind}`);
  assert.deepEqual(
    [...used].filter(
      (k) =>
        ![
          'object',
          'string',
          'integer',
          'number',
          'boolean',
          'any',
          'enum',
          'array',
          'record',
          'oneOf',
          'nullable',
          'pattern',
          'keyPattern',
        ].includes(k),
    ),
    [],
  );
  const create = doc.paths['/v1/webhooks'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(create, toJsonSchema(WEBHOOK_CREATE_SCHEMA));
  assert.deepEqual(create.required, ['url']);
  assert.equal(create.properties.types.items.pattern, '^[a-z][a-z0-9_.-]*(\\.\\*)?$');
  const exec = doc.paths['/v1/sandboxes/{id}/exec'].post.requestBody.content['application/json'];
  assert.deepEqual(exec.schema.required, ['argv']);
  assert.equal(exec.schema.properties.argv.minItems, 1);
});

test('the route table covers every route and names no other', () => {
  assert.deepEqual(routeDocProblems(), []);
  assert.deepEqual(allRoutes(), [...PUBLIC_ROUTES, ...Object.keys(SCOPE_MATRIX)]);
  const missing = { ...ROUTE_DOCS };
  delete missing['GET /v1/whoami'];
  assert.deepEqual(routeDocProblems(missing), ['GET /v1/whoami has no ROUTE_DOCS entry']);
  const extra = { ...ROUTE_DOCS, 'GET /v1/nothing': ROUTE_DOCS['GET /v1/whoami'] };
  assert.deepEqual(routeDocProblems(extra), ['ROUTE_DOCS entry GET /v1/nothing names no route']);
  assert.deepEqual(routeDocProblems(ROUTE_DOCS, [...allRoutes(), 'POST /v1/new']), [
    'POST /v1/new has no ROUTE_DOCS entry',
  ]);
  for (const [route, entry] of Object.entries(ROUTE_DOCS)) {
    for (const field of ['operationId', 'summary', 'description'])
      assert.equal(typeof entry[field], 'string', `${route} ${field}`);
    if (!entry.ws) assert.equal(typeof entry.returns, 'string', `${route} returns`);
  }
});

test('path templates become OpenAPI paths with one path parameter per segment', () => {
  assert.equal(openApiPath('/v1/sandboxes'), '/v1/sandboxes');
  assert.equal(
    openApiPath('/v1/sandboxes/:id/sessions/:sessionId/ws'),
    '/v1/sandboxes/{id}/sessions/{sessionId}/ws',
  );
  assert.equal(
    openApiPath('/v1/webhooks/:webhookId/deliveries/:deliveryId/retry'),
    '/v1/webhooks/{webhookId}/deliveries/{deliveryId}/retry',
  );
  for (const [key, op] of operations(doc)) {
    const names = [...key.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const params = (op.parameters ?? []).filter((p) => p.in === 'path');
    assert.deepEqual(
      params.map((p) => p.name),
      names,
      key,
    );
    for (const p of params) {
      assert.equal(p.required, true, `${key} ${p.name}`);
      assert.equal(p.schema.type, 'string', `${key} ${p.name}`);
    }
  }
  const sha = doc.paths['/v1/sandboxes/{id}/artifacts/{sha256}'].get.parameters[1];
  assert.equal(sha.schema.pattern, '^[a-f0-9]{64}$');
});

test('the document is structurally valid OpenAPI 3.1', () => {
  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.version, SERVER_VERSION);
  assert.equal(typeof doc.info.title, 'string');
  assert.equal(buildOpenApi({ version: '9.9.9' }).info.version, '9.9.9');
  const ops = operations(doc);
  assert.equal(ops.length, allRoutes().length);
  const ids = ops.map(([, op]) => op.operationId);
  assert.equal(new Set(ids).size, ids.length, 'operationIds are unique');
  const tags = new Set(doc.tags.map((t) => t.name));
  for (const [key, op] of ops) {
    assert.ok(Object.keys(op.responses).length > 1, `${key} has responses`);
    assert.ok(op.responses.default, `${key} has a default response`);
    for (const [status, r] of Object.entries(op.responses)) {
      assert.match(status, /^(default|[1-5]\d\d)$/, key);
      assert.equal(typeof r.description, 'string', `${key} ${status}`);
    }
    for (const tag of op.tags) assert.ok(tags.has(tag), `${key} tag ${tag}`);
    for (const p of op.parameters ?? []) {
      assert.ok(['path', 'query'].includes(p.in), `${key} ${p.name}`);
      assert.equal(typeof p.schema, 'object', `${key} ${p.name}`);
    }
    for (const req of op.security ?? [])
      for (const name of Object.keys(req))
        assert.ok(doc.components.securitySchemes[name], `${key} security ${name}`);
  }
  for (const req of doc.security)
    for (const name of Object.keys(req)) assert.ok(doc.components.securitySchemes[name]);
  const all = refs(doc);
  assert.ok(all.length > ops.length);
  for (const ref of all) assert.ok(resolvePointer(doc, ref) !== undefined, `${ref} resolves`);
  assert.deepEqual(doc.components.securitySchemes.bearer, {
    type: 'http',
    scheme: 'bearer',
    description: doc.components.securitySchemes.bearer.description,
  });
  const envelope = doc.components.schemas.Error;
  assert.deepEqual(envelope.required, ['error']);
  assert.deepEqual(envelope.properties.error.required, ['code', 'message']);
  assert.deepEqual(Object.keys(envelope.properties.error.properties), [
    'code',
    'message',
    'details',
    'requestId',
  ]);
  for (const line of ['- 400: ', '- 404: ', '- 409: ', '- 429: `E_LIMIT`', '- 503: '])
    assert.ok(envelope.description.includes(line), line);
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc, 'the document is plain JSON');
  assert.equal(
    JSON.stringify(buildOpenApi({ version: SERVER_VERSION })),
    JSON.stringify(doc),
    'two builds are identical, keys in the same order',
  );
});

test('scopes, unbound keys and public routes are marked on each operation', () => {
  const expected = (route) => {
    if (PUBLIC_ROUTES.includes(route)) return ['none', 'No authentication.'];
    if (SCOPE_MATRIX[route] === 'any') return ['any key', 'Scope: any key.'];
    return [SCOPE_MATRIX[route], `Scope: \`${SCOPE_MATRIX[route]}\`.`];
  };
  for (const route of allRoutes()) {
    const [method, template] = route.split(' ');
    const op = doc.paths[openApiPath(template)][method.toLowerCase()];
    const pub = PUBLIC_ROUTES.includes(route);
    const [scope, note] = expected(route);
    assert.equal(op['x-workbox-scope'], scope, route);
    assert.ok(op.description.includes(note), route);
    assert.equal(op['x-workbox-unbound-key'], FLEET_ROUTES.includes(route) || undefined, route);
    if (pub) {
      assert.deepEqual(op.security, [], route);
      assert.equal(op.responses['401'], undefined, route);
    } else assert.ok(op.responses['401'], route);
  }
  assert.equal(doc.paths['/v1/whoami'].get['x-workbox-scope'], 'any key');
  assert.ok(doc.paths['/metrics'].get.description.includes('not bound to sandboxes'));
  assert.ok(doc.paths[OPENAPI_PATH].get);
});

test('WebSocket routes are GET operations with x-websocket and their frames', () => {
  const ws = Object.keys(SCOPE_MATRIX).filter((k) => k.endsWith('/ws'));
  assert.equal(ws.length, 3);
  for (const [key, op] of operations(doc)) {
    const isWs = ws.some((r) => openApiPath(r) === key);
    assert.equal(op['x-websocket'], isWs || undefined, key);
    if (!isWs) continue;
    assert.ok(key.startsWith('GET '), key);
    assert.ok(op.responses['101'], key);
    assert.ok(op.responses['426'], key);
    assert.deepEqual(op.security, [{ bearer: [] }, { queryToken: [] }], key);
  }
  const session = doc.paths['/v1/sandboxes/{id}/sessions/{sessionId}/ws'].get.description;
  for (const frame of ['"type": "ready"', '"type": "session.output"', '"type": "input"'])
    assert.ok(session.includes(frame), frame);
  for (const p of ['/v1/events/ws', '/v1/sandboxes/{id}/events/ws']) {
    const op = doc.paths[p].get;
    for (const frame of ['"type": "event"', '"type": "live"', '"type": "error"'])
      assert.ok(op.description.includes(frame), `${p} ${frame}`);
    assert.ok(op.parameters.some((q) => q.name === 'afterSeq' && q.in === 'query'));
  }
  assert.equal(doc.components.securitySchemes.queryToken.in, 'query');
});

test('response and request media types, success statuses and query parameters', () => {
  const ok = (p, m, status = '200') => Object.keys(doc.paths[p][m].responses[status].content);
  assert.deepEqual(ok('/v1/sandboxes/{id}/files/raw', 'get'), ['application/octet-stream']);
  assert.deepEqual(ok('/v1/sandboxes/{id}/artifacts/{sha256}', 'get'), [
    'application/octet-stream',
  ]);
  assert.deepEqual(ok('/metrics', 'get'), ['text/plain; version=0.0.4']);
  assert.deepEqual(ok('/v1/sandboxes', 'post', '201'), ['application/json']);
  assert.deepEqual(ok('/v1/webhooks/{webhookId}/test', 'post', '202'), ['application/json']);
  assert.deepEqual(ok('/healthz', 'get'), ['application/json']);
  const upload = doc.paths['/v1/sandboxes/{id}/files/raw'].put;
  assert.deepEqual(Object.keys(upload.requestBody.content), ['application/octet-stream']);
  assert.equal(upload.requestBody.required, true);
  const query = (p, m) =>
    Object.fromEntries(
      doc.paths[p][m].parameters.filter((x) => x.in === 'query').map((x) => [x.name, x]),
    );
  const files = query('/v1/sandboxes/{id}/files', 'get');
  assert.equal(files.path.required, true);
  assert.deepEqual(files.list.schema, { type: 'string', enum: ['1'] });
  assert.equal(files.offset.schema.type, 'integer');
  const events = query('/v1/events', 'get');
  assert.deepEqual(Object.keys(events), ['afterSeq', 'limit', 'types', 'waitMs', 'sandboxId']);
  assert.equal(events.waitMs.schema.maximum, 60_000);
  assert.deepEqual(Object.keys(query('/v1/sandboxes/{id}/events', 'get')), [
    'afterSeq',
    'limit',
    'types',
    'waitMs',
  ]);
  assert.deepEqual(query('/v1/sandboxes/{id}/sessions/{sessionId}/output', 'get').encoding.schema, {
    type: 'string',
    enum: ['base64', 'text'],
  });
  assert.deepEqual(query('/v1/webhooks/{webhookId}/deliveries', 'get').status.schema.enum, [
    'pending',
    'delivered',
    'failed',
  ]);
  assert.equal(doc.paths['/v1/whoami'].get.parameters, undefined);
});

test('the version is the server package version', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(SERVER_VERSION, pkg.version);
  assert.equal(OPENAPI_PATH, '/v1/openapi.json');
  assert.ok(PUBLIC_ROUTES.includes(`GET ${OPENAPI_PATH}`));
});
