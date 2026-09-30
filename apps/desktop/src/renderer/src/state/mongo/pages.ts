/**
 * Pages of a collection view's find() (spec §9), as the table view's (ADR 0030): each page is a
 * find with its own skip and limit, inside the skip and limit typed in the query bar. Limit 0 is
 * no limit; a negative limit takes its size, as MongoDB drivers read it.
 */

/** Documents per page, as the settings offer them. */
export const DOCUMENT_PAGE_SIZES = [50, 100, 500, 1000] as const;

export const DEFAULT_DOCUMENT_PAGE = 100;

interface Bounds {
  readonly skip?: number | undefined;
  readonly limit?: number | undefined;
}

function capOf(limit: number | undefined): number | undefined {
  return limit === undefined || limit === 0 ? undefined : Math.abs(limit);
}

/**
 * The skip and limit that read page `page` (from 1) of `size` documents; undefined when the page
 * lies past the query's own limit.
 */
export function pageWindow(
  page: number,
  size: number,
  query: Bounds,
): { readonly skip: number; readonly limit: number } | undefined {
  const start = (page - 1) * size;
  const cap = capOf(query.limit);
  if (cap !== undefined && start >= cap) return undefined;
  return {
    skip: (query.skip ?? 0) + start,
    limit: cap === undefined ? size : Math.min(size, cap - start),
  };
}

/** The documents the query returns, from the number its filter matches. */
export function queryTotal(matching: number, query: Bounds): number {
  const past = Math.max(0, matching - (query.skip ?? 0));
  const cap = capOf(query.limit);
  return cap === undefined ? past : Math.min(past, cap);
}

/** The last page of `total` documents (1 when there are none). */
export function lastPage(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}
