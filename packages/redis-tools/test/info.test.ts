import { describe, expect, it } from 'vitest';

import {
  infoField,
  infoMetrics,
  parseCommandStats,
  parseErrorStats,
  parseInfo,
  parseKeyspace,
  parseLatencyStats,
  parseReplication,
  serverIdentity,
} from '../src';
import { recordedText } from './fixtures';

const standalone = parseInfo(recordedText('info-standalone-7.0.resp'));

const HAND_WRITTEN = `# Server\r
redis_version:7.2.4\r
server_name:valkey\r
valkey_version:8.0.1\r
redis_mode:cluster\r
uptime_in_seconds:3600\r
\r
# Stats\r
instantaneous_ops_per_sec:125\r
keyspace_hits:90\r
keyspace_misses:10\r
\r
# Keyspace\r
db0:keys=12,expires=3,avg_ttl=1500\r
db5:keys=1,expires=0,avg_ttl=0,subexpiry=0\r
\r
# Latencystats\r
latency_percentiles_usec_get:p50=1.003,p99=3.007,p99.9=10.015\r
`;

describe('parseInfo', () => {
  it('parses a real Redis 7.0 INFO everything', () => {
    expect(Object.keys(standalone)).toEqual(
      expect.arrayContaining([
        'server',
        'clients',
        'memory',
        'stats',
        'replication',
        'cpu',
        'commandstats',
        'errorstats',
        'keyspace',
      ]),
    );
    expect(standalone['server']!['redis_version']).toBe('7.0.15');
    expect(infoField(standalone, 'tcp_port')).toBe('63790');
    expect(serverIdentity(standalone)).toEqual({
      flavor: 'redis',
      version: '7.0.15',
      redisVersion: '7.0.15',
      mode: 'standalone',
    });
  });

  it('reads replication of a primary and of a replica', () => {
    expect(parseReplication(standalone)).toMatchObject({
      role: 'master',
      isReplica: false,
      connectedReplicas: 1,
      replicas: [{ ip: '127.0.0.1', port: 63792, state: 'online', lag: 0 }],
    });
    const replica = parseReplication(parseInfo(recordedText('info-replica-7.0.resp')));
    expect(replica).toMatchObject({
      role: 'slave',
      isReplica: true,
      master: { host: '127.0.0.1', port: 63790, linkStatus: 'up', syncInProgress: false },
    });
  });

  it('reads command and error stats', () => {
    const stats = parseCommandStats(standalone);
    const get = stats.find((s) => s.command === 'get')!;
    expect(get.calls).toBeGreaterThan(0);
    expect(get.usecPerCall).toBeGreaterThan(0);
    expect(stats.some((s) => s.command === 'command|docs')).toBe(true);
    expect(stats[0]!.calls).toBeGreaterThanOrEqual(stats[stats.length - 1]!.calls);
    expect(parseErrorStats(standalone)).toMatchObject({ ERR: 4, NOAUTH: 1 });
  });

  it('reads keyspace, latency stats, Valkey identity and dashboard metrics', () => {
    const info = parseInfo(HAND_WRITTEN);
    expect(parseKeyspace(info)).toEqual([
      { db: 0, keys: 12, expires: 3, avgTtlMs: 1500 },
      { db: 5, keys: 1, expires: 0, avgTtlMs: 0 },
    ]);
    expect(parseKeyspace(standalone)).toEqual([]);
    expect(parseLatencyStats(info)).toEqual({ get: { p50: 1.003, p99: 3.007, 'p99.9': 10.015 } });
    expect(serverIdentity(info)).toEqual({
      flavor: 'valkey',
      version: '8.0.1',
      redisVersion: '7.2.4',
      mode: 'cluster',
    });
    expect(infoMetrics(info)).toMatchObject({
      opsPerSec: 125,
      hitRatio: 0.9,
      totalKeys: 13,
      totalExpires: 3,
      uptimeSeconds: 3600,
    });
    expect(infoMetrics(standalone).usedMemory).toBeGreaterThan(0);
  });
});
