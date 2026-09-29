import type { PlanNode } from '@joinery/core';

/** A mutable plan node while a driver builds the tree. */
export type PlanDetail = Record<string, string | number | boolean | null>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A number from a JSON number or numeric string (MySQL reports costs as strings). */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Copies the scalar properties of a plan object into `detail`, skipping `omit`. Arrays of
 * scalars are joined with ", " (sort keys, used columns); nested objects are left to the caller.
 */
export function scalarDetail(
  source: Readonly<Record<string, unknown>>,
  omit: ReadonlySet<string> = new Set(),
  prefix = '',
): PlanDetail {
  const detail: PlanDetail = {};
  for (const [key, value] of Object.entries(source)) {
    if (omit.has(key)) continue;
    const name = prefix + key;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      detail[name] = value;
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string' || typeof item === 'number')
    ) {
      detail[name] = value.join(', ');
    }
  }
  return detail;
}

/** Drops undefined optional fields so plan nodes stay clean for structured clone and tests. */
export function planNode(node: {
  id: string;
  operation: string;
  relation?: string | undefined;
  index?: string | undefined;
  startupCost?: number | undefined;
  totalCost?: number | undefined;
  estimatedRows?: number | undefined;
  actualRows?: number | undefined;
  actualTimeMs?: number | undefined;
  loops?: number | undefined;
  detail: PlanDetail;
  children: readonly PlanNode[];
}): PlanNode {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (value !== undefined) result[key] = value;
  }
  return result as unknown as PlanNode;
}
