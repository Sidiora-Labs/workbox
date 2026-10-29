import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTH_FAILURE_DEFAULTS, addressKey, createFailureLimiter } from '../../src/ratelimit.js';

test('defaults allow 20 failures per 60 s and track at most 10000 addresses', () => {
  assert.deepEqual({ ...AUTH_FAILURE_DEFAULTS }, { max: 20, windowMs: 60_000, maxEntries: 10_000 });
  const limiter = createFailureLimiter();
  for (let i = 0; i < 19; i++) limiter.fail('a', 1000);
  assert.equal(limiter.retryAfter('a', 1000), 0);
  limiter.fail('a', 1000);
  assert.equal(limiter.retryAfter('a', 1000), 60);
  assert.equal(limiter.retryAfter('a', 60_999), 1);
  assert.equal(limiter.retryAfter('a', 61_000), 0);
});

test('an address is refused once it reaches the limit, until its window ends', () => {
  const limiter = createFailureLimiter({ max: 3, windowMs: 1000 });
  assert.equal(limiter.retryAfter('a', 0), 0);
  limiter.fail('a', 0);
  limiter.fail('a', 100);
  assert.equal(limiter.retryAfter('a', 100), 0, 'below the limit');
  limiter.fail('a', 200);
  assert.equal(limiter.retryAfter('a', 200), 1, 'rounded up to whole seconds');
  assert.equal(limiter.retryAfter('a', 999), 1);
  assert.equal(limiter.retryAfter('b', 200), 0, 'other addresses are not affected');
  assert.equal(limiter.size, 1);
  assert.equal(limiter.retryAfter('a', 1000), 0, 'the window started at the first failure');
  assert.equal(limiter.size, 0, 'an expired window is forgotten');
  limiter.fail('a', 1000);
  assert.equal(limiter.retryAfter('a', 1000), 0, 'a new window counts from one');

  const long = createFailureLimiter({ max: 2, windowMs: 10_000 });
  long.fail('c', 0);
  long.fail('c', 0);
  assert.equal(long.retryAfter('c', 1), 10);
  assert.equal(long.retryAfter('c', 9500), 1);
});

test('expired windows are pruned and the map never exceeds maxEntries', () => {
  const limiter = createFailureLimiter({ max: 1, windowMs: 1000, maxEntries: 2 });
  limiter.fail('a', 0);
  limiter.fail('b', 500);
  assert.equal(limiter.size, 2);
  limiter.fail('c', 600);
  assert.equal(limiter.size, 2);
  assert.equal(limiter.retryAfter('a', 600), 0, 'the oldest window was dropped');
  assert.equal(limiter.retryAfter('b', 600), 1);
  assert.equal(limiter.retryAfter('c', 600), 1);
  limiter.fail('d', 1550);
  assert.equal(limiter.size, 2, 'b expired and was pruned before d was added');
  assert.equal(limiter.retryAfter('b', 1550), 0);
  assert.equal(limiter.retryAfter('c', 1550), 1);
  limiter.fail('e', 5000);
  assert.equal(limiter.size, 1);
});

test('the clock defaults to now', () => {
  const limiter = createFailureLimiter({ max: 1, windowMs: 5000 });
  limiter.fail('a');
  const left = limiter.retryAfter('a');
  assert.ok(left >= 1 && left <= 5, String(left));
});

test('options must be positive integers', () => {
  for (const opts of [{ max: 0 }, { windowMs: 1.5 }, { maxEntries: -1 }, { max: '3' }])
    assert.throws(() => createFailureLimiter(opts), RangeError, JSON.stringify(opts));
});

test('addressKey keeps IPv4, unmaps IPv4-mapped IPv6 and groups IPv6 by /64', () => {
  const cases = [
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:10.0.0.1', '10.0.0.1'],
    ['::FFFF:127.0.0.1', '127.0.0.1'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:aaaa::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['1::2:3:4:5:6:7', '1:0:2:3::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'],
    ['1:2:3::4.5.6.7', '1:2:3:0::/64'],
    [undefined, 'unknown'],
    ['', 'unknown'],
  ];
  for (const [address, key] of cases) assert.equal(addressKey(address), key, String(address));
});
