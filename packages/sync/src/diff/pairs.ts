import type { SchemaDef, TableDef, ViewDef } from '@querybara/core';

import { nameKey } from '../normalize';
import type { ResolvedCompareOptions } from '../options';
import { findRename } from './context';

/** A schema present in the source, the target or both. */
export interface SchemaPair {
  readonly source?: SchemaDef;
  readonly target?: SchemaDef;
  /** Name for statements: the target's when it exists. */
  readonly name: string;
  /** Object-key segment: the schema name for PostgreSQL, '' for MySQL/MariaDB. */
  readonly key: string;
}

/** A table present in the source, the target or both. */
export interface TablePair {
  readonly schema: SchemaPair;
  readonly source?: TableDef;
  readonly target?: TableDef;
  /** Name in statements that run before renames (the target's, or the source's for new tables). */
  readonly before: string;
  /** Name after renames. */
  readonly after: string;
  readonly renamed: boolean;
  /** Target column name → source column name, for user-mapped column renames. */
  readonly columnRenames: ReadonlyMap<string, string>;
}

export interface ViewPair {
  readonly schema: SchemaPair;
  readonly source?: ViewDef;
  readonly target?: ViewDef;
  readonly before: string;
  readonly after: string;
  readonly renamed: boolean;
}

/**
 * Matches items by folded name, after applying user renames (target `from` → source `to`).
 * Returns pairs in source order followed by target-only items.
 */
export function pairByName<T extends { name: string }>(
  sources: readonly T[],
  targets: readonly T[],
  options: ResolvedCompareOptions,
  renameOf: (target: T) => string | undefined = () => undefined,
): { source?: T; target?: T; renamed: boolean }[] {
  const sourceByKey = new Map(sources.map((s) => [nameKey(s.name, options), s]));
  const matchedTargets = new Map<T, T>();
  const renamedTargets = new Set<T>();
  const takenSources = new Set<T>();
  for (const target of targets) {
    const to = renameOf(target);
    if (to === undefined) continue;
    const source = sourceByKey.get(nameKey(to, options));
    if (source === undefined || takenSources.has(source)) continue;
    if (targets.some((t) => t !== target && nameKey(t.name, options) === nameKey(to, options)))
      continue;
    matchedTargets.set(source, target);
    renamedTargets.add(target);
    takenSources.add(source);
  }
  const targetByKey = new Map<string, T>();
  for (const target of targets) {
    if (!renamedTargets.has(target)) targetByKey.set(nameKey(target.name, options), target);
  }
  const result: { source?: T; target?: T; renamed: boolean }[] = [];
  const usedTargets = new Set<T>(renamedTargets);
  for (const source of sources) {
    const renamedTarget = matchedTargets.get(source);
    if (renamedTarget !== undefined) {
      result.push({ source, target: renamedTarget, renamed: true });
      continue;
    }
    const target = targetByKey.get(nameKey(source.name, options));
    if (target !== undefined && !usedTargets.has(target)) {
      usedTargets.add(target);
      result.push({ source, target, renamed: false });
    } else {
      result.push({ source, renamed: false });
    }
  }
  for (const target of targets)
    if (!usedTargets.has(target)) result.push({ target, renamed: false });
  return result;
}

/** Names of PostgreSQL partitions: handled through their parent's partitioning, not as tables. */
export function partitionNames(schema: SchemaDef | undefined): Set<string> {
  const names = new Set<string>();
  for (const table of schema?.tables ?? []) {
    for (const partition of table.partitioning?.partitions ?? []) names.add(partition.name);
  }
  return names;
}

export function pairTables(
  schema: SchemaPair,
  options: ResolvedCompareOptions,
  pg: boolean,
): TablePair[] {
  const sourceTables = (schema.source?.tables ?? []).filter(
    (t) => !(pg && partitionNames(schema.source).has(t.name)),
  );
  const targetTables = (schema.target?.tables ?? []).filter(
    (t) => !(pg && partitionNames(schema.target).has(t.name)),
  );
  const schemaName = pg ? schema.name : undefined;
  const pairs = pairByName(
    sourceTables,
    targetTables,
    options,
    (target) => findRename(options.renames, 'table', schemaName, target.name)?.to,
  );
  return pairs.map(({ source, target, renamed }) => {
    const columnRenames = new Map<string, string>();
    if (source !== undefined && target !== undefined) {
      const tableNames = [source.name, target.name];
      for (const column of target.columns) {
        const rule = findRename(options.renames, 'column', schemaName, column.name, tableNames);
        if (rule === undefined) continue;
        const exists = source.columns.some(
          (c) => nameKey(c.name, options) === nameKey(rule.to, options),
        );
        const clash = target.columns.some(
          (c) => nameKey(c.name, options) === nameKey(rule.to, options),
        );
        if (exists && !clash) columnRenames.set(column.name, rule.to);
      }
    }
    const before = target?.name ?? source!.name;
    const after = renamed ? source!.name : before;
    return {
      schema,
      ...(source !== undefined ? { source } : {}),
      ...(target !== undefined ? { target } : {}),
      before,
      after,
      renamed,
      columnRenames,
    };
  });
}

export function pairViews(
  schema: SchemaPair,
  options: ResolvedCompareOptions,
  pg: boolean,
): ViewPair[] {
  const schemaName = pg ? schema.name : undefined;
  return pairByName(
    schema.source?.views ?? [],
    schema.target?.views ?? [],
    options,
    (target) => findRename(options.renames, 'view', schemaName, target.name)?.to,
  ).map(({ source, target, renamed }) => {
    const before = target?.name ?? source!.name;
    return {
      schema,
      ...(source !== undefined ? { source } : {}),
      ...(target !== undefined ? { target } : {}),
      before,
      after: renamed ? source!.name : before,
      renamed,
    };
  });
}
