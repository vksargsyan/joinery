import { JoineryError, type CellValue } from '@joinery/core';
import {
  buildBrowseQuery,
  pageAfter,
  rowKeyAt,
  type BrowseOptions,
  type BrowsePage,
  type BrowseQuery,
  type RowKey,
} from '@joinery/table-data';

import type { LoadedRows } from './grid-model';

/**
 * Paging for the table data grid (spec §7: keyset paging when a key exists, OFFSET otherwise).
 * The controller holds the loaded rows and asks for the next page when the user scrolls near
 * the end. Keyset pages continue after the last row the server returned (not the last row
 * shown, which may be edited locally); offset pages continue at the number of rows read, less
 * the rows deleted since. A reset (new sort or filter) bumps the generation, so a page still in
 * flight for the old query is dropped when it arrives.
 */

/** Runs one browse query and returns its rows in server order. */
export type PageFetcher = (query: BrowseQuery, signal: AbortSignal) => Promise<CellValue[][]>;

/** What to query: everything of BrowseOptions except the page and its size. */
export type PagingOptions = Omit<BrowseOptions, 'page' | 'limit'>;

export interface PagingState extends LoadedRows {
  readonly paging: 'keyset' | 'offset' | undefined;
  readonly offsetReason: string | undefined;
  /** More rows may exist past the last loaded one. */
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  /** Bumps whenever the rows change. */
  readonly version: number;
}

export const DEFAULT_TABLE_PAGE = 500;

/** Rows from the end at which the next page is requested. */
const PREFETCH_ROWS = 150;

export class PagingController {
  readonly #fetch: PageFetcher;
  readonly #pageSize: number;
  readonly #onChange: () => void;
  #options: PagingOptions | undefined;
  #query: BrowseQuery | undefined;
  #rows: CellValue[][] = [];
  #keys: (RowKey | null)[] = [];
  #cursor: readonly CellValue[] | undefined;
  #fetched = 0;
  #hasMore = false;
  #loading = false;
  #error: unknown = undefined;
  #generation = 0;
  #version = 0;
  #inFlight: { controller: AbortController; promise: Promise<void> } | undefined;

  constructor(fetch: PageFetcher, onChange: () => void, pageSize = DEFAULT_TABLE_PAGE) {
    this.#fetch = fetch;
    this.#onChange = onChange;
    this.#pageSize = pageSize;
  }

  get state(): PagingState {
    return {
      columns: this.#query?.columns ?? [],
      rows: this.#rows,
      keys: this.#keys,
      paging: this.#query?.paging,
      offsetReason: this.#query?.offsetReason,
      hasMore: this.#hasMore,
      loading: this.#loading,
      error: this.#error,
      version: this.#version,
    };
  }

  get query(): BrowseQuery | undefined {
    return this.#query;
  }

  get pageSize(): number {
    return this.#pageSize;
  }

  /**
   * Starts over with new options (sort, filter, identity) and loads the first page. Rejects
   * with VALIDATION_FAILED when the options do not make a query; a failed fetch is kept in
   * `state.error` instead.
   */
  async reset(options: PagingOptions): Promise<void> {
    this.#inFlight?.controller.abort();
    this.#inFlight = undefined;
    this.#generation++;
    this.#options = options;
    this.#rows = [];
    this.#keys = [];
    this.#cursor = undefined;
    this.#fetched = 0;
    this.#hasMore = false;
    this.#error = undefined;
    this.#query = undefined;
    this.#loading = false;
    this.#version++;
    try {
      this.#query = buildBrowseQuery({
        ...options,
        limit: this.#pageSize,
        page: { kind: 'first' },
      });
    } catch (error) {
      this.#error = error;
      this.#onChange();
      throw error;
    }
    this.#hasMore = true;
    await this.#load(this.#query);
  }

  /** Loads the next page, unless one is loading or nothing is left. */
  async loadMore(): Promise<void> {
    if (this.#inFlight) return this.#inFlight.promise;
    const options = this.#options;
    const first = this.#query;
    if (!options || !first || !this.#hasMore) return;
    let page: BrowsePage;
    if (first.paging === 'keyset') {
      if (this.#cursor === undefined) return;
      page = pageAfter(first, this.#cursor);
    } else {
      page = { kind: 'offset', offset: this.#fetched };
    }
    await this.#load(buildBrowseQuery({ ...options, limit: this.#pageSize, page }));
  }

  /** Whether a grid showing rows up to `lastVisible` should ask for the next page. */
  shouldLoadMore(lastVisible: number): boolean {
    return (
      this.#hasMore &&
      !this.#loading &&
      this.#error === undefined &&
      lastVisible >= this.#rows.length - PREFETCH_ROWS
    );
  }

  /**
   * Replaces the loaded rows after Apply merged its results in. `removed` is the number of
   * rows the server no longer has (deletes), which moves an offset cursor back.
   */
  replaceRows(rows: CellValue[][], keys: (RowKey | null)[], removed: number): void {
    this.#rows = rows;
    this.#keys = keys;
    this.#fetched = Math.max(0, this.#fetched - removed);
    this.#version++;
    this.#onChange();
  }

  /** Stops a page in flight (the panel closed). */
  dispose(): void {
    this.#generation++;
    this.#inFlight?.controller.abort();
    this.#inFlight = undefined;
  }

  async #load(query: BrowseQuery): Promise<void> {
    const generation = this.#generation;
    const controller = new AbortController();
    this.#loading = true;
    this.#onChange();
    const promise = (async () => {
      try {
        const fetched = await this.#fetch(query, controller.signal);
        if (generation !== this.#generation) return;
        const rows = query.reversed ? fetched.reverse() : fetched;
        const identity = this.#options!.identity;
        for (const row of rows) {
          this.#rows.push(row);
          this.#keys.push(rowKeyAt(identity, query.columns, row));
        }
        this.#fetched += rows.length;
        if (rows.length > 0) this.#cursor = rows.at(-1);
        this.#hasMore = rows.length >= query.limit;
        this.#error = undefined;
        this.#version++;
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#error =
          error instanceof JoineryError && error.code === 'CANCELLED' ? undefined : error;
      } finally {
        if (generation === this.#generation) {
          this.#loading = false;
          this.#inFlight = undefined;
          this.#onChange();
        }
      }
    })();
    this.#inFlight = { controller, promise };
    await promise;
  }
}
