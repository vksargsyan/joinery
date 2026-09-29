import type { BulkDeleteProgress, BulkDeleteResult } from '@joinery/driver-redis';
import { parseInfo, utf8Bytes } from '@joinery/redis-tools';
import { describe, expect, it } from 'vitest';

import {
  describeBulkDelete,
  initialBulkDelete,
  runBulkDelete,
  type BulkDeleteCall,
  type BulkDeleteState,
} from '../src/renderer/src/state/redis/bulk-delete';
import {
  deriveDashboard,
  formatUptime,
  pushSample,
  sampleFrom,
  sparklinePath,
} from '../src/renderer/src/state/redis/dashboard';

function result(overrides: Partial<BulkDeleteResult>): BulkDeleteResult {
  return {
    matched: 0,
    deleted: 0,
    failed: 0,
    scanCalls: 1,
    dryRun: true,
    cancelled: false,
    sample: [],
    ...overrides,
  };
}

/** A server that matches `matched` keys and deletes them in batches of 2, with progress. */
function server(matched: number) {
  const calls: { dryRun: boolean; match: string; type?: string }[] = [];
  const call: BulkDeleteCall = async (request, onProgress, signal) => {
    calls.push({
      dryRun: request.dryRun,
      match: new TextDecoder().decode(request.match),
      ...(request.type !== undefined ? { type: request.type } : {}),
    });
    if (request.dryRun) {
      onProgress({ matched, deleted: 0, failed: 0, scanCalls: 1 });
      return result({ matched, sample: [utf8Bytes('tmp:1')] });
    }
    let deleted = 0;
    while (deleted < matched) {
      if (signal.aborted) return result({ matched, deleted, dryRun: false, cancelled: true });
      deleted = Math.min(matched, deleted + 2);
      onProgress({ matched, deleted, failed: 0, scanCalls: 2 });
      await Promise.resolve();
    }
    return result({ matched, deleted, dryRun: false });
  };
  return { call, calls };
}

describe('bulk delete flow', () => {
  it('counts, asks with the count and a sample, then deletes with progress', async () => {
    const { call, calls } = server(5);
    const states: BulkDeleteState[] = [];
    let asked: [number, number] | undefined;
    const final = await runBulkDelete({
      pattern: 'tmp:*',
      type: 'string',
      call,
      confirm: async (count, sample) => {
        asked = [count, sample.length];
        return true;
      },
      onState: (state) => states.push(state),
      signal: new AbortController().signal,
    });
    expect(asked).toEqual([5, 1]);
    expect(calls).toEqual([
      { dryRun: true, match: 'tmp:*', type: 'string' },
      { dryRun: false, match: 'tmp:*', type: 'string' },
    ]);
    expect(states.map((s) => s.phase)).toContain('confirming');
    const deleting = states.filter((s) => s.phase === 'deleting').map((s) => s.progress.deleted);
    expect(deleting).toEqual([0, 2, 4, 5]);
    expect(final).toMatchObject({ phase: 'done', counted: 5 });
    expect(describeBulkDelete(final)).toBe('Deleted 5 keys');
  });

  it('deletes nothing when the user declines, or when nothing matches', async () => {
    const declined = server(3);
    const final = await runBulkDelete({
      pattern: 'tmp:*',
      type: '',
      call: declined.call,
      confirm: async () => false,
      onState: () => undefined,
      signal: new AbortController().signal,
    });
    expect(final.phase).toBe('cancelled');
    expect(declined.calls.map((c) => c.dryRun)).toEqual([true]);
    expect(describeBulkDelete(final)).toBe('Cancelled: nothing was deleted');

    const empty = server(0);
    let asked = false;
    const none = await runBulkDelete({
      pattern: 'nothing:*',
      type: '',
      call: empty.call,
      confirm: async () => (asked = true),
      onState: () => undefined,
      signal: new AbortController().signal,
    });
    expect(asked).toBe(false);
    expect(describeBulkDelete(none)).toBe('No keys match nothing:*');
  });

  it('stops when cancelled mid-run and says how many keys went', async () => {
    const { call } = server(10);
    const abort = new AbortController();
    const final = await runBulkDelete({
      pattern: 'tmp:*',
      type: '',
      call: (request, onProgress, signal) =>
        call(
          request,
          (progress: BulkDeleteProgress) => {
            onProgress(progress);
            if (progress.deleted >= 4) abort.abort();
          },
          signal,
        ),
      confirm: async () => true,
      onState: () => undefined,
      signal: abort.signal,
    });
    expect(final.phase).toBe('cancelled');
    expect(final.progress.deleted).toBe(4);
    expect(describeBulkDelete(final)).toBe('Cancelled after deleting 4 keys');
  });

  it('refuses an empty pattern and reports failures', async () => {
    const empty = await runBulkDelete({
      pattern: ' ',
      type: '',
      call: server(1).call,
      confirm: async () => true,
      onState: () => undefined,
      signal: new AbortController().signal,
    });
    expect(empty.phase).toBe('failed');
    const failed = await runBulkDelete({
      pattern: 'x*',
      type: '',
      call: async () => {
        throw new Error('READ_ONLY');
      },
      confirm: async () => true,
      onState: () => undefined,
      signal: new AbortController().signal,
    });
    expect(failed).toMatchObject({ phase: 'failed', error: 'READ_ONLY' });
    expect(describeBulkDelete(initialBulkDelete('a*'))).toMatch(/Count the matching keys/);
  });
});

function info(
  fields: Record<string, string | number>,
  keyspace = 'db0:keys=10,expires=2,avg_ttl=0',
) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}:${v}`);
  return parseInfo(
    `# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n# Stats\r\n${lines.join('\r\n')}\r\n# Replication\r\nrole:master\r\nconnected_slaves:1\r\nslave0:ip=10.0.0.2,port=6380,state=online,offset=100,lag=0\r\n# Keyspace\r\n${keyspace}\r\n`,
  );
}

describe('INFO dashboard', () => {
  it('derives the tiles from the latest sample and the hit ratio from the deltas', () => {
    let samples = pushSample(
      [],
      sampleFrom(1000, [
        info({
          used_memory: 1000,
          maxmemory: 4000,
          keyspace_hits: 90,
          keyspace_misses: 10,
          instantaneous_ops_per_sec: 5,
          connected_clients: 3,
          uptime_in_seconds: 90_000,
        }),
      ]),
    );
    samples = pushSample(
      samples,
      sampleFrom(6000, [
        info({
          used_memory: 2000,
          maxmemory: 4000,
          keyspace_hits: 120,
          keyspace_misses: 40,
          instantaneous_ops_per_sec: 7,
          connected_clients: 4,
          uptime_in_seconds: 90_005,
        }),
      ]),
    );
    const view = deriveDashboard(samples);
    expect(view.memory).toMatchObject({ used: 2000, max: 4000, usedShare: 0.5 });
    expect(view.hitRatio).toBeCloseTo(120 / 160);
    expect(view.recentHitRatio).toBeCloseTo(30 / 60);
    expect(view.series.memory).toEqual([1000, 2000]);
    expect(view.series.opsPerSec).toEqual([5, 7]);
    expect(view.series.hitRatio).toEqual([0.5]);
    expect(view.keys).toEqual({ total: 10, withExpiry: 2 });
    expect(view.keyspace).toEqual([{ db: 0, keys: 10, expires: 2, avgTtlMs: 0 }]);
    expect(view.replication.connectedReplicas).toBe(1);
    expect(view.server).toEqual({ flavor: 'redis', version: '7.2.4', mode: 'standalone' });
    expect(formatUptime(view.uptimeSeconds!)).toBe('1 d 1 h');
  });

  it('skips the hit ratio of a window in which the counters were reset', () => {
    const before = sampleFrom(0, [info({ keyspace_hits: 500, keyspace_misses: 500 })]);
    const after = sampleFrom(5000, [info({ keyspace_hits: 3, keyspace_misses: 1 })]);
    const view = deriveDashboard([before, after]);
    expect(view.recentHitRatio).toBeUndefined();
    expect(view.hitRatio).toBeCloseTo(0.75);
  });

  it('sums every primary in Cluster mode', () => {
    const sample = sampleFrom(0, [
      info(
        {
          used_memory: 100,
          keyspace_hits: 1,
          keyspace_misses: 1,
          instantaneous_ops_per_sec: 2,
          connected_clients: 1,
        },
        'db0:keys=5,expires=0,avg_ttl=0',
      ),
      info(
        {
          used_memory: 300,
          keyspace_hits: 3,
          keyspace_misses: 0,
          instantaneous_ops_per_sec: 4,
          connected_clients: 2,
        },
        'db0:keys=7,expires=1,avg_ttl=0',
      ),
    ]);
    expect(sample.nodes).toBe(2);
    expect(sample.metrics).toMatchObject({
      usedMemory: 400,
      opsPerSec: 6,
      connectedClients: 3,
      totalKeys: 12,
      totalExpires: 1,
    });
    expect(sample.metrics.hitRatio).toBeCloseTo(4 / 5);
  });

  it('keeps a bounded history and draws sparklines', () => {
    let samples = pushSample([], sampleFrom(0, [info({})]), 2);
    samples = pushSample(samples, sampleFrom(1, [info({})]), 2);
    samples = pushSample(samples, sampleFrom(2, [info({})]), 2);
    expect(samples.map((s) => s.at)).toEqual([1, 2]);
    expect(sparklinePath([], 100, 10)).toBe('');
    expect(sparklinePath([1, 1], 100, 10)).toBe('M0.0,5.0 L100.0,5.0');
    expect(sparklinePath([0, 5, 10], 100, 10)).toBe('M0.0,10.0 L50.0,5.0 L100.0,0.0');
  });
});
