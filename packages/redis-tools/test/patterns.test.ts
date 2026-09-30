import { describe, expect, it } from 'vitest';

import { aggregateByPattern, displayBytes, keyPattern } from '../src';
import { enc } from './fixtures';

describe('keyPattern', () => {
  it.each([
    ['user:42:profile', 'user:*:profile'],
    ['session:3f2a9c1e5b7d4a60', 'session:*'],
    ['order:2024-01-05:items', 'order:*-*-*:items'],
    ['doc:550e8400-e29b-41d4-a716-446655440000', 'doc:*'],
    ['job:01ARZ3NDEKTSV4RRFFQ69G5FAV', 'job:*'],
    ['cache/v2/page.html', 'cache/v2/page.html'],
    ['rate-limit:api:1700000000', 'rate-limit:api:*'],
    ['metrics|cpu|12.5', 'metrics|cpu|*'],
    ['plain', 'plain'],
    ['user_123', 'user_*'],
    ['abcdefgh', 'abcdefgh'],
    ['abcdef1', 'abcdef1'],
    ['deadbeef1', '*'],
    ['v1.2.3', 'v1.*'],
  ])('%s → %s', (key, pattern) => {
    expect(keyPattern(key)).toBe(pattern);
  });

  it('treats binary segments as ids and honours a custom delimiter', () => {
    expect(keyPattern(Uint8Array.of(0x6b, 0x3a, 0xff, 0x01))).toBe('k:*');
    expect(keyPattern('tenant~7~user', '~')).toBe('tenant~*~user');
  });
});

describe('aggregateByPattern', () => {
  const samples = [
    { key: enc('user:1'), type: 'hash', bytes: 100, ttlMs: -1 },
    { key: enc('user:2'), type: 'hash', bytes: 300, ttlMs: 5000 },
    { key: enc('cache:9'), type: 'string', bytes: 1000, ttlMs: 10 },
    { key: enc('lock:x'), type: 'string', bytes: null },
    { key: enc('queue:1'), type: 'list', bytes: 50 },
  ];

  it('sums memory per pattern, largest first', () => {
    const stats = aggregateByPattern(samples);
    expect(stats.map((s) => [s.pattern, s.count, s.totalBytes, s.maxBytes, s.avgBytes])).toEqual([
      ['cache:*', 1, 1000, 1000, 1000],
      ['user:*', 2, 400, 300, 200],
      ['queue:*', 1, 50, 50, 50],
      ['lock:x', 1, 0, 0, 0],
    ]);
    const user = stats[1]!;
    expect(displayBytes(user.largestKey!)).toBe('user:2');
    expect(user.types).toEqual({ hash: 2 });
    expect(user.withTtl).toBe(1);
    expect(user.share).toBeCloseTo(400 / 1450);
  });

  it('merges the tail into (other)', () => {
    const stats = aggregateByPattern(samples, { limit: 2 });
    expect(stats.map((s) => [s.pattern, s.count, s.totalBytes])).toEqual([
      ['cache:*', 1, 1000],
      ['(other)', 4, 450],
    ]);
    expect(stats[1]!.types).toEqual({ hash: 2, list: 1, string: 1 });
  });
});
