import type { BackupObjectKind } from './archive/manifest';
import type { ObjectRef } from './types';

/**
 * Object selection for backups and selective restores. The user picks top-level objects; the
 * selection is closed over dependencies (a view brings its tables, a column its type, a trigger
 * its function) and each chosen table brings the objects attached to it. Foreign keys are the
 * exception: one is kept only when every table it links is chosen, since pulling in whole
 * tables for a constraint would surprise more than leaving the constraint out.
 */

export interface Selectable {
  readonly id: string;
  readonly kind: BackupObjectKind;
  readonly schema?: string;
  readonly name: string;
  readonly qualifiedName: string;
  /** Id of the object this one is attached to (a table's foreign keys, triggers, indexes). */
  readonly parent?: string;
  readonly dependsOn: readonly string[];
}

export interface SelectionRules {
  /** Objects chosen directly (default: all). */
  readonly include?: (object: Selectable) => boolean;
  /** Objects left out, with whatever needs them. */
  readonly exclude?: (object: Selectable) => boolean;
}

export interface SelectionResult {
  /** Chosen ids, in the input order. */
  readonly ids: readonly string[];
  /** Ids chosen because something chosen needs them. */
  readonly added: readonly string[];
  /** Ids left out although wanted, and why. */
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
}

/** Kinds kept only when everything they reference is chosen. */
const OPTIONAL_KINDS: ReadonlySet<BackupObjectKind> = new Set(['foreign-key']);

/** True when `ref` names the object. Routines match every overload of the name. */
export function refMatches(object: Selectable, ref: ObjectRef): boolean {
  if (object.name !== ref.name) return false;
  if (ref.schema !== undefined && object.schema !== undefined && ref.schema !== object.schema) {
    return false;
  }
  if (ref.kind === object.kind) return true;
  return (
    (ref.kind === 'view' && object.kind === 'materialized-view') ||
    (ref.kind === 'materialized-view' && object.kind === 'view')
  );
}

export function resolveSelection(
  objects: readonly Selectable[],
  rules: SelectionRules = {},
): SelectionResult {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const label = (id: string): string => byId.get(id)?.qualifiedName ?? id;
  const direct = (o: Selectable): boolean => rules.include === undefined || rules.include(o);

  // Exclusions, and whatever cannot exist without an excluded object.
  const removed = new Map<string, string | undefined>();
  if (rules.exclude) {
    for (const o of objects) if (rules.exclude(o)) removed.set(o.id, undefined);
  }
  for (let grew = removed.size > 0; grew;) {
    grew = false;
    for (const o of objects) {
      if (removed.has(o.id)) continue;
      const needs = [...o.dependsOn, ...(o.parent !== undefined ? [o.parent] : [])];
      const missing = needs.find((d) => removed.has(d));
      if (missing === undefined) continue;
      removed.set(o.id, missing);
      grew = true;
    }
  }

  const chosen = new Set<string>();
  const picked = new Set<string>();
  for (const o of objects) {
    if (!removed.has(o.id) && direct(o)) {
      chosen.add(o.id);
      picked.add(o.id);
    }
  }
  const children = new Map<string, Selectable[]>();
  for (const o of objects) {
    if (o.parent === undefined) continue;
    children.set(o.parent, [...(children.get(o.parent) ?? []), o]);
  }

  // Close over dependencies and attached objects until nothing changes.
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...chosen]) {
      const o = byId.get(id)!;
      if (!OPTIONAL_KINDS.has(o.kind)) {
        for (const dep of o.dependsOn) {
          if (chosen.has(dep) || removed.has(dep) || !byId.has(dep)) continue;
          chosen.add(dep);
          changed = true;
        }
      }
      for (const child of children.get(id) ?? []) {
        if (chosen.has(child.id) || removed.has(child.id)) continue;
        if (OPTIONAL_KINDS.has(child.kind) && !child.dependsOn.every((d) => chosen.has(d))) {
          continue;
        }
        chosen.add(child.id);
        changed = true;
      }
    }
  }

  const skipped: { id: string; reason: string }[] = [];
  for (const o of objects) {
    const attachedToChosen = o.parent !== undefined && chosen.has(o.parent);
    if (OPTIONAL_KINDS.has(o.kind) && (chosen.has(o.id) || attachedToChosen)) {
      const missing = o.dependsOn.find((d) => !chosen.has(d));
      if (missing !== undefined) {
        chosen.delete(o.id);
        skipped.push({ id: o.id, reason: `links to ${label(missing)}, which is not selected` });
      }
      continue;
    }
    const cause = removed.get(o.id);
    // A left-out table's keys and triggers go with it, as expected; no need to say so.
    const followsParent = o.parent !== undefined && removed.has(o.parent);
    if (cause !== undefined && !followsParent && (direct(o) || attachedToChosen)) {
      skipped.push({ id: o.id, reason: `needs ${label(cause)}, which is left out` });
    }
  }

  const ids = objects.filter((o) => chosen.has(o.id)).map((o) => o.id);
  const added =
    rules.include === undefined
      ? []
      : ids.filter((id) => !picked.has(id) && byId.get(id)!.parent === undefined);
  return { ids, added, skipped };
}
