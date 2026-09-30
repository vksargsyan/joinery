import type { SchemaDiff, SyncOperation } from './model';

/**
 * Ticking and unticking operations (spec §13, step 5). Unticking an operation unticks every
 * operation that depends on it; ticking one ticks what it depends on. Both return a new diff.
 */
export function setOperationSelected(diff: SchemaDiff, id: string, selected: boolean): SchemaDiff {
  const byId = new Map(diff.operations.map((op) => [op.id, op]));
  if (!byId.has(id)) return diff;
  const dependents = new Map<string, string[]>();
  for (const op of diff.operations) {
    for (const dep of op.dependsOn) {
      let list = dependents.get(dep);
      if (!list) dependents.set(dep, (list = []));
      list.push(op.id);
    }
  }
  const changed = new Set<string>();
  const stack = [id];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (changed.has(current)) continue;
    changed.add(current);
    const next = selected ? (byId.get(current)?.dependsOn ?? []) : (dependents.get(current) ?? []);
    stack.push(...next);
  }
  return {
    ...diff,
    operations: diff.operations.map((op) => (changed.has(op.id) ? { ...op, selected } : op)),
  };
}

/** Ticks or unticks every operation matching the filter (all by default), keeping dependencies consistent. */
export function setAllSelected(
  diff: SchemaDiff,
  selected: boolean,
  filter: (op: SyncOperation) => boolean = () => true,
): SchemaDiff {
  let result = diff;
  for (const op of diff.operations) {
    if (filter(op)) result = setOperationSelected(result, op.id, selected);
  }
  return result;
}

/**
 * Included operations whose dependencies are not included — possible when a caller sets
 * `selected` directly. The script still includes them; its warnings name the gap.
 */
export function missingDependencies(
  diff: SchemaDiff,
  isIncluded: (op: SyncOperation) => boolean = (op) => op.selected,
): { operationId: string; missing: string[] }[] {
  const byId = new Map(diff.operations.map((op) => [op.id, op]));
  const result: { operationId: string; missing: string[] }[] = [];
  for (const op of diff.operations) {
    if (!isIncluded(op)) continue;
    const missing = op.dependsOn.filter((dep) => {
      const other = byId.get(dep);
      return other !== undefined && !isIncluded(other);
    });
    if (missing.length > 0) result.push({ operationId: op.id, missing });
  }
  return result;
}
