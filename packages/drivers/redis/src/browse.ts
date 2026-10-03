import { QuerybaraError, type BrowseNode } from '@querybara/core';
import {
  concatBytes,
  displayBytes,
  escapeGlob,
  groupLevel,
  namespacePrefix,
  parseDisplayBytes,
  parseKeyspace,
  parseInfo,
  utf8Bytes,
} from '@querybara/redis-tools';
import type { Redis } from 'ioredis';

import { addressOf, type Arg } from './client';
import type { RedisContext } from './context';
import { asArray, asBytes, asNumber, asText } from './replies';

/**
 * The object explorer tree (spec §5): logical databases (or Cluster primaries) at the root,
 * then a namespace tree split on the key delimiter. Each expand scans only the keys under its
 * prefix (SCAN MATCH <prefix><delimiter>*) with bounded work: when the budget runs out the
 * children found so far are returned with `partial: 1` in their detail, plus a marker node.
 *
 * Path segments are display text (see `displayBytes`), so binary key names round-trip.
 */

export interface BrowseBudget {
  /** SCAN round trips per expand. */
  readonly maxCalls: number;
  /** SCAN COUNT per call. */
  readonly count: number;
  readonly timeMs: number;
  /** Leaf keys listed per level (their TYPE is fetched). */
  readonly maxLeaves: number;
}

export const DEFAULT_BROWSE_BUDGET: BrowseBudget = {
  maxCalls: 100,
  count: 1000,
  timeMs: 1500,
  maxLeaves: 1000,
};

const MANY_DATABASES = 64;

function dbName(db: number): string {
  return `db${db}`;
}

function parseDb(segment: string): number | undefined {
  const match = /^db(\d+)$/.exec(segment);
  return match ? Number(match[1]) : undefined;
}

async function rootNodes(ctx: RedisContext): Promise<BrowseNode[]> {
  if (ctx.conn.isCluster) {
    return Promise.all(
      ctx.conn.primaries().map(async (node): Promise<BrowseNode> => {
        const address = addressOf(node);
        const keys = asNumber(await ctx.call(['dbsize'], node).catch(() => null));
        return {
          kind: 'node',
          name: address,
          path: [address],
          hasChildren: (keys ?? 1) > 0,
          detail: { role: 'primary', keys },
        };
      }),
    );
  }
  const info = parseInfo(asText(await ctx.call(['info', 'keyspace'])) ?? '');
  const keyspace = new Map(parseKeyspace(info).map((k) => [k.db, k]));
  const count = ctx.server.databases;
  const dbs =
    count <= MANY_DATABASES
      ? Array.from({ length: count }, (_, i) => i)
      : [...new Set([0, ctx.database, ...keyspace.keys()])].sort((a, b) => a - b);
  return dbs.map((db): BrowseNode => {
    const k = keyspace.get(db);
    return {
      kind: 'database',
      name: dbName(db),
      path: [dbName(db)],
      hasChildren: (k?.keys ?? 0) > 0,
      detail: {
        keys: k?.keys ?? 0,
        expires: k?.expires ?? 0,
        avgTtlMs: k?.avgTtlMs ?? 0,
        ...(db === ctx.database ? { current: 1 } : {}),
      },
    };
  });
}

/** Where a path's keys live: a logical database (standalone) or a node (Cluster). */
interface Scope {
  readonly db?: number;
  readonly node?: Redis;
}

function scopeOf(ctx: RedisContext, root: string): Scope {
  if (ctx.conn.isCluster) return { node: ctx.nodeFor(root) };
  const db = parseDb(root);
  if (db === undefined) {
    throw new QuerybaraError({
      code: 'NOT_FOUND',
      message: `"${root}" is not a database of this server`,
    });
  }
  return { db };
}

async function run(
  ctx: RedisContext,
  scope: Scope,
  commands: readonly (readonly Arg[])[],
): Promise<unknown[]> {
  if (scope.db !== undefined && scope.db !== ctx.database)
    return ctx.inDatabase(scope.db, commands);
  return Promise.all(commands.map((c) => ctx.call(c, scope.node)));
}

/** Children of a tree path; `[]` is the root. */
export async function browseRedis(
  ctx: RedisContext,
  path: readonly string[],
  budget: BrowseBudget = DEFAULT_BROWSE_BUDGET,
): Promise<BrowseNode[]> {
  if (path.length === 0) return rootNodes(ctx);
  const [root, ...segments] = path as [string, ...string[]];
  const scope = scopeOf(ctx, root);
  const delimiter = utf8Bytes(ctx.keyDelimiter);
  const prefix = namespacePrefix(segments.map(parseDisplayBytes), delimiter);
  const match = prefix.length > 0 ? concatBytes(escapeGlob(prefix), utf8Bytes('*')) : undefined;

  const keys: Uint8Array[] = [];
  const deadline = performance.now() + budget.timeMs;
  let cursor = '0';
  let calls = 0;
  do {
    const args: Arg[] = ['scan', cursor];
    if (match) args.push('MATCH', match);
    args.push('COUNT', budget.count);
    const [reply] = await run(ctx, scope, [args]);
    const [next, found] = asArray(reply);
    cursor = asText(next) ?? '0';
    for (const key of asArray(found)) keys.push(asBytes(key)!);
    calls += 1;
  } while (cursor !== '0' && calls < budget.maxCalls && performance.now() < deadline);
  const partial = cursor !== '0';

  const level = groupLevel(keys, prefix, delimiter);
  const mark: Record<string, number> = partial ? { partial: 1 } : {};
  const nodes: BrowseNode[] = level.namespaces.map((ns) => {
    const name = displayBytes(ns.segment);
    return {
      kind: 'namespace',
      name,
      path: [...path, name],
      hasChildren: true,
      detail: {
        keys: ns.count,
        prefix: displayBytes(concatBytes(prefix, ns.segment, delimiter)),
        ...mark,
      },
    };
  });
  const leaves = level.keys.slice(0, budget.maxLeaves);
  const types =
    leaves.length > 0
      ? await run(
          ctx,
          scope,
          leaves.map((k) => ['type', k]),
        )
      : [];
  leaves.forEach((key, i) => {
    const name = displayBytes(key.subarray(prefix.length));
    nodes.push({
      kind: 'key',
      name,
      path: [...path, name],
      hasChildren: false,
      detail: { type: asText(types[i]) ?? null, key: displayBytes(key), ...mark },
    });
  });
  if (partial || leaves.length < level.keys.length) {
    nodes.push({
      kind: 'other',
      name: partial
        ? `Scan stopped after ${keys.length} keys; open the key browser for the rest`
        : `${level.keys.length - leaves.length} more keys; open the key browser for the rest`,
      path: [...path, '…'],
      hasChildren: false,
      detail: { partial: 1, scannedKeys: keys.length, cursor, scanCalls: calls },
    });
  }
  return nodes;
}
