import type { ErrorData } from '@joinery/core';
import type { DataLossSeverity, TableDesign } from '@joinery/sync';

/**
 * The designer's save review (spec §8: Save shows the ALTER script first; risky changes show a
 * data-loss warning): the script's warnings grouped by severity, each data-loss or may-fail item
 * with the queries that count and list the rows it affects, and how a failed run is reported.
 */

export interface ReviewItem {
  readonly id: string;
  readonly severity: DataLossSeverity;
  readonly message: string;
  /** Designer path of the object, to point at it. */
  readonly path?: string;
  /** Counts the affected rows: one row, one number. */
  readonly checkQuery?: string;
  /** Lists up to 100 of the affected rows. */
  readonly findQuery?: string;
}

export interface ReviewGroup {
  readonly severity: DataLossSeverity;
  readonly title: string;
  readonly items: readonly ReviewItem[];
}

const TITLES: Readonly<Record<DataLossSeverity, string>> = {
  'data-loss': 'Data loss',
  'may-fail': 'May fail on existing data',
  info: 'Notes',
};

/**
 * The review's warning groups, most severe first: the data-loss analysis, then the script's own
 * warnings (non-transactional DDL, rebuilt objects, unsupported changes) by their code. The
 * analysis covers every operation the script's data-loss and may-fail notes are about, with row
 * counts, so those notes only show when the analysis found nothing.
 */
export function reviewGroups(design: TableDesign): ReviewGroup[] {
  const items: ReviewItem[] = [];
  const seen = new Set<string>();
  const add = (item: Omit<ReviewItem, 'id'>): void => {
    const key = `${item.severity}\u0000${item.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ ...item, id: `r${items.length}` });
  };
  for (const warning of design.dataLoss) {
    add({
      severity: warning.severity,
      message: warning.message,
      ...(warning.path !== undefined ? { path: warning.path } : {}),
      ...(warning.checkQuery !== undefined ? { checkQuery: warning.checkQuery } : {}),
      ...(warning.findQuery !== undefined ? { findQuery: warning.findQuery } : {}),
    });
  }
  const analysed = design.dataLoss.length > 0;
  for (const warning of design.warnings) {
    if (analysed && (warning.code === 'data-loss' || warning.code === 'may-fail')) continue;
    const severity: DataLossSeverity =
      warning.code === 'data-loss'
        ? 'data-loss'
        : warning.code === 'may-fail'
          ? 'may-fail'
          : 'info';
    add({ severity, message: warning.message });
  }
  const order: DataLossSeverity[] = ['data-loss', 'may-fail', 'info'];
  return order
    .map((severity) => ({
      severity,
      title: TITLES[severity],
      items: items.filter((item) => item.severity === severity),
    }))
    .filter((group) => group.items.length > 0);
}

/** Whether the review needs the user's attention before running (anything but notes). */
export function hasRisks(design: TableDesign): boolean {
  return reviewGroups(design).some((group) => group.severity !== 'info');
}

/** The number a check query returned (its first cell), or null when it is not a count. */
export function countFrom(rows: readonly (readonly unknown[])[]): number | null {
  const cell = rows[0]?.[0];
  if (typeof cell === 'number') return cell;
  if (typeof cell === 'bigint') return Number(cell);
  if (typeof cell === 'string' && /^\d+$/.test(cell.trim())) return Number(cell);
  return null;
}

/**
 * What the designer says when statement `index` of `total` failed. PostgreSQL ran the script in
 * one transaction, so nothing changed; MySQL and MariaDB commit each DDL statement, so the ones
 * before it stay applied.
 */
export function describeScriptFailure(
  index: number,
  total: number,
  transactional: boolean,
  error: ErrorData,
): string {
  const which = total > 1 ? `Statement ${index + 1} of ${total} failed: ` : '';
  const outcome = transactional
    ? 'The transaction was rolled back; the table was not changed.'
    : index === 0
      ? 'Nothing was changed.'
      : `The ${index === 1 ? 'first statement was' : `first ${index} statements were`} applied and cannot be rolled back (MySQL and MariaDB commit DDL at once).`;
  return `${which}${error.message}. ${outcome}`;
}
