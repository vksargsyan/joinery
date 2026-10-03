import type { SortTerm } from '@querybara/table-data';

/**
 * Server-side sort from header clicks (spec §7): a click sorts by that column ascending, then
 * descending, then not at all; with Shift (`additive`) the column is added to or cycled within
 * the existing sort instead of replacing it.
 */
export function nextSort(sort: readonly SortTerm[], column: string, additive: boolean): SortTerm[] {
  const current = sort.find((term) => term.column === column);
  const cycled: SortTerm | undefined =
    current === undefined
      ? { column, direction: 'asc' }
      : current.direction === 'asc'
        ? { column, direction: 'desc' }
        : undefined;
  if (!additive) return cycled ? [cycled] : [];
  if (current === undefined) return [...sort, cycled!];
  return sort.flatMap((term) => (term.column !== column ? [term] : cycled ? [cycled] : []));
}

/** The header decoration of a column: ▲/▼ and its position when several columns sort. */
export function sortMark(sort: readonly SortTerm[], column: string): string {
  const at = sort.findIndex((term) => term.column === column);
  if (at < 0) return '';
  const arrow = sort[at]!.direction === 'asc' ? '▲' : '▼';
  return sort.length > 1 ? `${arrow}${at + 1}` : arrow;
}
