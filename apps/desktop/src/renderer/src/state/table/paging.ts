import { QuerybaraError, type CellValue } from '@querybara/core';
import {
  buildBrowseQuery,
  pageAfter,
  pageBefore,
  rowKeyAt,
  type BrowseOptions,
  type BrowsePage,
  type BrowseQuery,
  type RowKey,
} from '@querybara/table-data';

import type { LoadedRows } from './grid-model';

/**
 * Pages of the table data grid, as Navicat pages them (spec §7): one page of rows at a time,
 * with first, previous, next and last, and a page chosen by number. Page boundaries are those of
 * LIMIT and OFFSET; how a page is read depends on the move. The next and previous pages continue
 * from the first or last row the server returned for this one, by key when the table has one
 * (keyset paging, cheap on any page); a page chosen by number, and every move of a keyless
 * table, reads at its offset. A reset (new sort, filter or page size) bumps the generation, so a
 * page still in flight for the old query is dropped when it arrives.
 */

/** Runs one browse query and returns its rows in server order. */
export type PageFetcher = (query: BrowseQuery, signal: AbortSignal) => Promise<CellValue[][]>;

/** What to query: everything of BrowseOptions except the page and its size. */
export type PagingOptions = Omit<BrowseOptions, 'page' | 'limit'>;

export interface PagingState extends LoadedRows {
  readonly paging: 'keyset' | 'offset' | undefined;
  readonly offsetReason: string | undefined;
  /** The page shown, from 1. */
  readonly page: number;
  readonly pageSize: number;
  /** A next page may exist: this one is full. */
  readonly hasNext: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  /** Bumps whenever the rows change. */
  readonly version: number;
}

/** Where to go: a page by number, or a step from the page shown. */
export type PageMove = 'first' | 'previous' | 'next' | number;

/** Rows per page, as Navicat's default. */
export const DEFAULT_TABLE_PAGE = 1000;

/** Page sizes the settings offer. */
export const PAGE_SIZES = [100, 500, 1000, 5000, 10000] as const;

export class PagingController {
  readonly #fetch: PageFetcher;
  readonly #onChange: () => void;
  #pageSize: number;
  #options: PagingOptions | undefined;
  #query: BrowseQuery | undefined;
  #rows: CellValue[][] = [];
  #keys: (RowKey | null)[] = [];
  /** The first and last rows the server returned for the page, for keyset steps. */
  #edges: { first: readonly CellValue[]; last: readonly CellValue[] } | undefined;
  #page = 1;
  #hasNext = false;
  #loading = false;
  #error: unknown = undefined;
  #generation = 0;
  #version = 0;
  #inFlight: AbortController | undefined;

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
      page: this.#page,
      pageSize: this.#pageSize,
      hasNext: this.#hasNext,
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

  /** The number of rows before the page shown. */
  get offset(): number {
    return (this.#page - 1) * this.#pageSize;
  }

  /**
   * Starts over with new options (sort, filter, identity), and a new page size when given, on
   * the first page. Rejects with VALIDATION_FAILED when the options do not make a query; a failed
   * fetch is kept in `state.error` instead.
   */
  async reset(options: PagingOptions, pageSize?: number): Promise<void> {
    this.#abort();
    this.#generation++;
    this.#options = options;
    if (pageSize !== undefined) this.#pageSize = pageSize;
    this.#rows = [];
    this.#keys = [];
    this.#edges = undefined;
    this.#page = 1;
    this.#hasNext = false;
    this.#error = undefined;
    this.#query = undefined;
    this.#loading = false;
    this.#version++;
    try {
      this.#query = this.#build({ kind: 'first' });
    } catch (error) {
      this.#error = error;
      this.#onChange();
      throw error;
    }
    await this.#load(this.#query, 1, 'replace');
  }

  /**
   * Shows another page. A step past the last page keeps the page shown (it was the last one);
   * a page by number past the end shows an empty page, as the server has no rows there.
   */
  async goTo(move: PageMove): Promise<void> {
    const options = this.#options;
    const first = this.#query;
    if (!options || !first) return;
    const target =
      move === 'first'
        ? 1
        : move === 'previous'
          ? this.#page - 1
          : move === 'next'
            ? this.#page + 1
            : Math.floor(move);
    if (target < 1 || (move === 'next' && !this.#hasNext)) return;
    const keyset = first.paging === 'keyset' && this.#edges !== undefined;
    let page: BrowsePage;
    if (target === 1) page = { kind: 'first' };
    else if (keyset && target === this.#page + 1) page = pageAfter(first, this.#edges!.last);
    else if (keyset && target === this.#page - 1) page = pageBefore(first, this.#edges!.first);
    else page = { kind: 'offset', offset: (target - 1) * this.#pageSize };
    await this.#load(this.#build(page), target, move === 'next' ? 'unless-empty' : 'replace');
  }

  /**
   * Replaces the page's rows after Apply merged its results in (inserted rows join the page,
   * deleted ones leave it).
   */
  replaceRows(rows: CellValue[][], keys: (RowKey | null)[]): void {
    this.#rows = rows;
    this.#keys = keys;
    this.#version++;
    this.#onChange();
  }

  /** Stops a page in flight (the panel closed). */
  dispose(): void {
    this.#generation++;
    this.#abort();
  }

  #build(page: BrowsePage): BrowseQuery {
    return buildBrowseQuery({ ...this.#options!, limit: this.#pageSize, page });
  }

  #abort(): void {
    this.#inFlight?.abort();
    this.#inFlight = undefined;
  }

  /**
   * Reads one page and shows it as page `target`. With 'unless-empty' an empty answer (the page
   * shown was the last, exactly full) keeps the page shown and marks it the last.
   */
  async #load(query: BrowseQuery, target: number, mode: 'replace' | 'unless-empty'): Promise<void> {
    this.#abort();
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#inFlight = controller;
    this.#loading = true;
    this.#onChange();
    try {
      const fetched = await this.#fetch(query, controller.signal);
      if (generation !== this.#generation) return;
      const rows = query.reversed ? fetched.reverse() : fetched;
      if (rows.length === 0 && mode === 'unless-empty') {
        this.#hasNext = false;
      } else {
        const identity = this.#options!.identity;
        this.#rows = rows;
        this.#keys = rows.map((row) => rowKeyAt(identity, query.columns, row));
        this.#edges = rows.length > 0 ? { first: rows[0]!, last: rows.at(-1)! } : undefined;
        this.#page = target;
        this.#hasNext = rows.length >= query.limit;
        this.#version++;
      }
      this.#error = undefined;
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#error =
        error instanceof QuerybaraError && error.code === 'CANCELLED' ? undefined : error;
    } finally {
      if (generation === this.#generation) {
        this.#loading = false;
        this.#inFlight = undefined;
        this.#onChange();
      }
    }
  }
}
