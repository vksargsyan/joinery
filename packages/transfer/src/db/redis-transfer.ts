import { QuerybaraError, type Session } from '@querybara/core';

import type { RowError } from '../types';
import type { Execution, TransferUnit, UnitContext, UnitResult } from './pipeline';
import { asRedis, type DumpedKeyEntry, type RedisTransferSession } from './sessions';
import type { DbTransferOptions, DbTransferSpec, PlannedTable, TransferPlan } from './spec';

/**
 * Redis → Redis (spec §12): keys matching the patterns are SCANned on the source (every
 * primary in Cluster mode), DUMPed with their remaining time to live and RESTOREd on the target
 * (routed by hash slot in Cluster mode), a batch at a time. Without REPLACE a key that already
 * exists on the target is left as it is and counted as skipped.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A key as text for messages: UTF-8 when it is, else `\x` hex. */
export function keyText(key: Uint8Array): string {
  try {
    return decoder.decode(key);
  } catch {
    return `\\x${Buffer.from(key).toString('hex')}`;
  }
}

/**
 * Redis glob matching (the rules of SCAN MATCH and KEYS): `*`, `?`, `[abc]`, `[^a-z]` and `\`
 * escapes, on bytes. Used to skip keys an earlier pattern of the same transfer already took.
 */
export function globMatch(pattern: Uint8Array | string, key: Uint8Array | string): boolean {
  const p = typeof pattern === 'string' ? encoder.encode(pattern) : pattern;
  const k = typeof key === 'string' ? encoder.encode(key) : key;
  const match = (pi: number, ki: number, depth: number): boolean => {
    if (depth > 1000) return false;
    while (pi < p.length) {
      const c = p[pi]!;
      if (c === 0x2a /* * */) {
        while (p[pi + 1] === 0x2a) pi++;
        if (pi + 1 === p.length) return true;
        for (let i = ki; i <= k.length; i++) if (match(pi + 1, i, depth + 1)) return true;
        return false;
      }
      if (ki >= k.length) return false;
      if (c === 0x3f /* ? */) {
        pi++;
        ki++;
        continue;
      }
      if (c === 0x5b /* [ */) {
        let i = pi + 1;
        const negate = p[i] === 0x5e; /* ^ */
        if (negate) i++;
        let matched = false;
        while (i < p.length && p[i] !== 0x5d /* ] */) {
          if (p[i] === 0x5c /* \ */ && i + 1 < p.length) {
            i++;
            if (p[i] === k[ki]) matched = true;
            i++;
          } else if (i + 2 < p.length && p[i + 1] === 0x2d /* - */ && p[i + 2] !== 0x5d) {
            const [lo, hi] = p[i]! <= p[i + 2]! ? [p[i]!, p[i + 2]!] : [p[i + 2]!, p[i]!];
            if (k[ki]! >= lo && k[ki]! <= hi) matched = true;
            i += 3;
          } else {
            if (p[i] === k[ki]) matched = true;
            i++;
          }
        }
        if (negate) matched = !matched;
        if (!matched) return false;
        pi = i + 1;
        ki++;
        continue;
      }
      if (c === 0x5c /* \ */ && pi + 1 < p.length) pi++;
      if (p[pi] !== k[ki]) return false;
      pi++;
      ki++;
    }
    return ki === k.length;
  };
  return match(0, 0, 0);
}

function isBusyKey(error: unknown): boolean {
  if (error instanceof QuerybaraError && error.engineCode === 'BUSYKEY') return true;
  return /BUSYKEY/.test(error instanceof Error ? error.message : String(error));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patternUnit(pattern: string, earlier: readonly string[], label: string): TransferUnit {
  return {
    source: pattern,
    target: label,
    async load(context: UnitContext): Promise<UnitResult> {
      const source = asRedis(context.source);
      const target = asRedis(context.target);
      const { options, signal } = context;
      let read = 0;
      let written = 0;
      let skipped = 0;
      const errors: RowError[] = [];
      let cursor = '0';
      const restore = async (entries: readonly DumpedKeyEntry[]): Promise<boolean> => {
        const results = await Promise.allSettled(
          entries.map((entry) => target.restoreKeys([entry], { replace: options.replace })),
        );
        for (const [i, result] of results.entries()) {
          if (result.status === 'fulfilled') {
            if (result.value > 0) written++;
            else skipped++;
            continue;
          }
          skipped++;
          if (isBusyKey(result.reason)) continue;
          errors.push({
            row: read - entries.length + i + 1,
            message: `${keyText(entries[i]!.key)}: ${messageOf(result.reason)}`,
          });
          if (options.onError === 'stop') return false;
        }
        return true;
      };
      try {
        for (;;) {
          if (signal.aborted) return { status: 'cancelled', read, written, skipped, errors };
          const step = await source.scan({
            cursor,
            match: pattern,
            count: Math.min(options.batchSize, 5000),
          });
          cursor = step.cursor;
          const keys = step.keys.filter((key) => !earlier.some((p) => globMatch(p, key)));
          for (let i = 0; i < keys.length; i += options.batchSize) {
            if (signal.aborted) return { status: 'cancelled', read, written, skipped, errors };
            const dumped = await source.dumpKeys(keys.slice(i, i + options.batchSize));
            const entries: DumpedKeyEntry[] = [];
            for (const entry of dumped) {
              read++;
              // A key that expired or was deleted since the scan is not copied.
              if (entry.payload === null) {
                skipped++;
                continue;
              }
              entries.push(options.keepTtl ? entry : { ...entry, ttlMs: -1, expireAtMs: null });
            }
            if (!(await restore(entries)))
              return { status: 'failed', read, written, skipped, errors };
            context.progress({ read, written, skipped });
          }
          if (step.done) break;
        }
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled', read, written, skipped, errors };
        errors.push({ message: messageOf(error) });
        return { status: 'failed', read, written, skipped, errors };
      }
      return { status: 'completed', read, written, skipped, errors };
    },
  };
}

function where(session: RedisTransferSession): string {
  return session.server.clusterMode ? 'the cluster' : `database ${session.database}`;
}

/** Plans a Redis → Redis copy of the keys matching the spec's patterns. */
export async function redisExecution(
  spec: DbTransferSpec,
  options: DbTransferOptions,
  sourceSession: Session,
  targetSession: Session,
  sameConnection: boolean,
): Promise<Execution> {
  const source = asRedis(sourceSession);
  const target = asRedis(targetSession);
  const patterns = (spec.keyPatterns ?? []).filter((p) => p !== '');
  const problems: string[] = [];
  if (patterns.length === 0) problems.push('Give at least one key pattern (* for every key)');
  if (sameConnection && source.database === target.database) {
    problems.push('The source and the target are the same database');
  }
  const total = patterns.includes('*') ? await source.dbSize().catch(() => undefined) : undefined;
  const label = where(target);
  const tables: PlannedTable[] = patterns.map((pattern) => ({
    source: pattern,
    target: label,
    kind: 'keys',
    action: 'append',
    exists: true,
    ...(pattern === '*' && total !== undefined ? { rows: total } : {}),
    columns: [],
    problems: [],
    warnings: [],
  }));
  const warnings = [
    ...(options.keepTtl ? [] : ['Keys are copied without their time to live']),
    ...(options.replace ? [] : ['Keys that exist on the target are left as they are (skipped)']),
  ];
  const plan: TransferPlan = {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    sourceVersion: source.serverVersion,
    targetVersion: target.serverVersion,
    tables,
    before: [],
    after: [],
    destructive: options.replace
      ? [`Keys that exist in ${label} are overwritten (RESTORE ... REPLACE)`]
      : [],
    creates: [],
    problems,
    warnings,
  };
  return {
    plan,
    units: patterns.map((pattern, i) => patternUnit(pattern, patterns.slice(0, i), label)),
  };
}
