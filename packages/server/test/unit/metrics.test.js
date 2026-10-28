import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Metrics } from '../../src/metrics.js';

test('metrics render sorted prometheus text with labels', () => {
  const m = new Metrics();
  m.describe('workbox_http_requests_total', 'requests');
  m.inc('workbox_http_requests_total', { route: '/v1/sandboxes', status: '2xx' });
  m.inc('workbox_http_requests_total', { route: '/v1/sandboxes', status: '2xx' });
  m.set('workbox_sandboxes', 3, { state: 'READY' });
  const text = m.render();
  assert.match(text, /workbox_http_requests_total\{route="\/v1\/sandboxes",status="2xx"\} 2/);
  assert.match(text, /workbox_sandboxes\{state="READY"\} 3/);
});
