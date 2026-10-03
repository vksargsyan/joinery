import type { SchemaSnapshot } from '@querybara/core';

import { diffSchemas } from './diff/index';
import type { DiffSummary, SchemaComparison, SchemaDiff, SyncObjectKind } from './model';
import type { CompareOptions } from './options';

/** Counts for the compare summary bar. */
export function summarizeDiff(diff: SchemaDiff): DiffSummary {
  const byObjectKind: Partial<Record<SyncObjectKind, number>> = {};
  let create = 0;
  let alter = 0;
  let drop = 0;
  let rename = 0;
  for (const op of diff.operations) {
    byObjectKind[op.objectKind] = (byObjectKind[op.objectKind] ?? 0) + 1;
    if (op.kind === 'create') create++;
    else if (op.kind === 'alter') alter++;
    else if (op.kind === 'drop') drop++;
    else rename++;
  }
  return {
    total: diff.operations.length,
    create,
    alter,
    drop,
    rename,
    destructive: diff.operations.filter((op) => op.destructive).length,
    selected: diff.operations.filter((op) => op.selected).length,
    byObjectKind,
  };
}

/**
 * Compares two schema snapshots (spec §13): the source is the desired state, the target the
 * database to change. Returns the ordered operations and summary counts; pass the diff to
 * `generateScript` for the deployment script and to `renderHtmlReport` for the report.
 */
export function compareSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  options: CompareOptions = {},
): SchemaComparison {
  const diff = diffSchemas(source, target, options);
  return { diff, summary: summarizeDiff(diff) };
}
