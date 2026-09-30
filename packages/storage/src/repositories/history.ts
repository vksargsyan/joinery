import { JoineryError, newId } from '@joinery/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { notFound, parseOrThrow } from '../internal/errors';
import { readNullableNumber, readNullableText, readNumber, readText } from '../internal/rows';
import { HISTORY_FTS_TABLE } from '../migrations';
import type { SqlRow, SqlValue, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });

export const queryStatusSchema = z.enum(['success', 'error', 'cancelled']);
export type QueryStatus = z.infer<typeof queryStatusSchema>;

/** One run of a statement (spec §6: text, connection, database, duration, rows, status). */
export const historyEntrySchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  /** The database (or MongoDB database, Redis DB index...) the statement ran in. */
  database: z.string().nullable(),
  text: z.string().min(1),
  status: queryStatusSchema,
  /** The error message for failed runs. */
  error: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  /** Rows returned, or rows affected for writes. */
  rowCount: z.number().int().nonnegative().nullable(),
  executedAt: timestampSchema,
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

const historyInputSchema = z.object({
  profileId: z.string().min(1),
  database: z.string().nullable().default(null),
  text: z.string().min(1),
  status: queryStatusSchema,
  error: z.string().nullable().default(null),
  durationMs: z.number().nonnegative().nullable().default(null),
  rowCount: z.number().int().nonnegative().nullable().default(null),
  /** Defaults to now. */
  executedAt: timestampSchema.optional(),
});
export type HistoryEntryInput = z.input<typeof historyInputSchema>;

export interface HistoryPageOptions {
  readonly profileId?: string;
  /** Page size, 1 to 1000; default 100. */
  readonly limit?: number;
  /** `nextCursor` from the previous page. */
  readonly cursor?: string;
}

export interface HistoryPage {
  /** Newest first. */
  readonly entries: HistoryEntry[];
  /** Pass as `cursor` to get the next (older) page; null on the last page. */
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const MAX_SEARCH_TERMS = 16;
/** The trigram tokenizer can only match terms of at least three characters. */
const MIN_FTS_TERM_LENGTH = 3;

/**
 * Query history. Entries are append-only and ordered by insertion; paging uses a keyset cursor
 * so new runs arriving between pages never shift or duplicate entries.
 */
export class QueryHistoryRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;
  #fullText: boolean | undefined;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  /** True when search uses the FTS5 trigram index; false means a LIKE scan. */
  get fullTextSearch(): boolean {
    this.#fullText ??=
      this.#db.get("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", [
        HISTORY_FTS_TABLE,
      ]) !== undefined;
    return this.#fullText;
  }

  append(input: HistoryEntryInput): HistoryEntry {
    const parsed = parseOrThrow(historyInputSchema, input, 'history entry');
    if (!this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [parsed.profileId])) {
      throw notFound('Profile', parsed.profileId);
    }
    const entry: HistoryEntry = {
      id: newId(),
      profileId: parsed.profileId,
      database: parsed.database,
      text: parsed.text,
      status: parsed.status,
      error: parsed.error,
      durationMs: parsed.durationMs,
      rowCount: parsed.rowCount,
      executedAt: parsed.executedAt ?? this.#now(),
    };
    this.#db.run(
      `INSERT INTO query_history (id, profile_id, database_name, text, status, error, duration_ms,
         row_count, executed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.profileId,
        entry.database,
        entry.text,
        entry.status,
        entry.error,
        entry.durationMs,
        entry.rowCount,
        entry.executedAt,
      ],
    );
    return entry;
  }

  get(id: string): HistoryEntry | undefined {
    const row = this.#db.get('SELECT * FROM query_history WHERE id = ?', [id]);
    return row ? toEntry(row) : undefined;
  }

  /** Entries newest first, for one profile or all of them. */
  list(options: HistoryPageOptions = {}): HistoryPage {
    return this.#page([], [], options);
  }

  /**
   * Entries whose text contains every whitespace-separated term, case-insensitively, newest
   * first. Terms of three or more characters use the trigram index; shorter ones a LIKE scan.
   */
  search(query: string, options: HistoryPageOptions = {}): HistoryPage {
    const terms = [
      ...new Set(
        query
          .trim()
          .split(/\s+/)
          .filter((term) => term !== ''),
      ),
    ].slice(0, MAX_SEARCH_TERMS);
    if (terms.length === 0) return this.list(options);
    const where: string[] = [];
    const params: SqlValue[] = [];
    const indexed = this.fullTextSearch
      ? terms.filter((term) => [...term].length >= MIN_FTS_TERM_LENGTH)
      : [];
    if (indexed.length > 0) {
      where.push(
        `h.seq IN (SELECT rowid FROM ${HISTORY_FTS_TABLE} WHERE ${HISTORY_FTS_TABLE} MATCH ?)`,
      );
      // Each term becomes a quoted phrase: implicit AND, no FTS query syntax from user input.
      params.push(indexed.map((term) => `"${term.replaceAll('"', '""')}"`).join(' '));
    }
    for (const term of terms) {
      if (indexed.includes(term)) continue;
      where.push("h.text LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLike(term)}%`);
    }
    return this.#page(where, params, options);
  }

  count(profileId?: string): number {
    const row =
      profileId === undefined
        ? this.#db.get('SELECT count(*) AS n FROM query_history')
        : this.#db.get('SELECT count(*) AS n FROM query_history WHERE profile_id = ?', [profileId]);
    return row ? readNumber(row, 'n') : 0;
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM query_history WHERE id = ?', [id]).changes > 0;
  }

  /** Deletes all history, or one profile's. Returns the number of entries deleted. */
  clear(profileId?: string): number {
    return profileId === undefined
      ? this.#db.run('DELETE FROM query_history').changes
      : this.#db.run('DELETE FROM query_history WHERE profile_id = ?', [profileId]).changes;
  }

  /**
   * Keeps only the newest `maxPerProfile` entries of each profile (or of one profile) and
   * returns the number deleted.
   */
  prune(maxPerProfile: number, options: { readonly profileId?: string } = {}): number {
    if (!Number.isInteger(maxPerProfile) || maxPerProfile < 0) {
      throw new RangeError('maxPerProfile must be a non-negative integer');
    }
    if (options.profileId !== undefined) {
      return this.#db.run(
        `DELETE FROM query_history WHERE profile_id = ? AND seq NOT IN (
           SELECT seq FROM query_history WHERE profile_id = ? ORDER BY seq DESC LIMIT ?
         )`,
        [options.profileId, options.profileId, maxPerProfile],
      ).changes;
    }
    return this.#db.run(
      `DELETE FROM query_history WHERE seq IN (
         SELECT seq FROM (
           SELECT seq, row_number() OVER (PARTITION BY profile_id ORDER BY seq DESC) AS position
           FROM query_history
         ) WHERE position > ?
       )`,
      [maxPerProfile],
    ).changes;
  }

  #page(where: string[], params: SqlValue[], options: HistoryPageOptions): HistoryPage {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
    }
    if (options.profileId !== undefined) {
      where.push('h.profile_id = ?');
      params.push(options.profileId);
    }
    if (options.cursor !== undefined) {
      where.push('h.seq < ?');
      params.push(parseCursor(options.cursor));
    }
    const rows = this.#db.all(
      `SELECT h.* FROM query_history h
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY h.seq DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      entries: page.map(toEntry),
      nextCursor: rows.length > limit && last ? String(readNumber(last, 'seq')) : null,
    };
  }
}

function parseCursor(cursor: string): number {
  if (!/^[1-9]\d{0,15}$/.test(cursor)) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Invalid history cursor' });
  }
  return Number(cursor);
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function toEntry(row: SqlRow): HistoryEntry {
  return {
    id: readText(row, 'id'),
    profileId: readText(row, 'profile_id'),
    database: readNullableText(row, 'database_name'),
    text: readText(row, 'text'),
    status: queryStatusSchema.parse(readText(row, 'status')),
    error: readNullableText(row, 'error'),
    durationMs: readNullableNumber(row, 'duration_ms'),
    rowCount: readNullableNumber(row, 'row_count'),
    executedAt: readText(row, 'executed_at'),
  };
}
