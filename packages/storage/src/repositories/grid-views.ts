import { JoineryError, newId } from '@joinery/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNullableText, readNumber, readText } from '../internal/rows';
import { checkVersion, type WriteOptions } from '../internal/versioning';
import type { SqlRow, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });
const nameSchema = z.string().trim().min(1).max(200);

/** The longest serialised filter kept with a view. */
export const MAX_FILTER_TEXT = 100_000;

/** One column of a saved layout, keyed by column name, in display order. */
export const gridColumnStateSchema = z.object({
  name: z.string().min(1).max(1024),
  width: z.number().int().min(20).max(4000).optional(),
  hidden: z.boolean().optional(),
  /** Frozen at the left; pinned columns come first in the list. */
  pinned: z.boolean().optional(),
});
export type GridColumnState = z.infer<typeof gridColumnStateSchema>;

/** A column layout: every known column in display order, with its width, visibility and pin. */
export const gridLayoutSchema = z.object({
  columns: z.array(gridColumnStateSchema).max(4096),
});
export type GridLayout = z.infer<typeof gridLayoutSchema>;

export const gridSortTermSchema = z.object({
  column: z.string().min(1).max(1024),
  direction: z.enum(['asc', 'desc']),
  nulls: z.enum(['first', 'last']).optional(),
});
export type GridSortTerm = z.infer<typeof gridSortTermSchema>;

/** Which table a view belongs to. `database` is null for the profile's default database. */
export const gridViewTableSchema = z.object({
  profileId: z.string().min(1),
  database: z.string().nullable(),
  schema: z.string(),
  table: z.string().min(1),
});
export type GridViewTable = z.infer<typeof gridViewTableSchema>;

/**
 * A saved table view (spec §7, "save views per table"): the column layout, the server-side sort
 * and the filter bar's state, under a name. At most one view per table is its default, applied
 * when the table opens. `filter` is the app's own serialised filter state, which the app
 * validates when it reads it back.
 */
export const gridViewSchema = gridViewTableSchema.extend({
  id: z.string().min(1),
  name: nameSchema,
  isDefault: z.boolean(),
  layout: gridLayoutSchema,
  sort: z.array(gridSortTermSchema).max(64),
  filter: z.string().max(MAX_FILTER_TEXT).nullable(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type GridView = z.infer<typeof gridViewSchema>;

const saveSchema = gridViewTableSchema.extend({
  /** Updates this view when it exists; creates one (with this id, or a new one) otherwise. */
  id: z.string().min(1).optional(),
  name: nameSchema,
  isDefault: z.boolean().default(false),
  layout: gridLayoutSchema,
  sort: z.array(gridSortTermSchema).max(64).default([]),
  filter: z.string().max(MAX_FILTER_TEXT).nullable().default(null),
});
export type GridViewSaveInput = z.input<typeof saveSchema>;

export class GridViewRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  get(id: string): GridView | undefined {
    const row = this.#db.get('SELECT * FROM grid_views WHERE id = ?', [id]);
    return row ? toGridView(row) : undefined;
  }

  /** The views of one table: the default first, then by name (case-insensitive). */
  list(table: GridViewTable): GridView[] {
    const key = parseOrThrow(gridViewTableSchema, table, 'grid view table');
    return this.#db
      .all(
        `SELECT * FROM grid_views
         WHERE profile_id = ? AND database_name = ? AND schema_name = ? AND table_name = ?
         ORDER BY is_default DESC, name COLLATE NOCASE, id`,
        [key.profileId, key.database ?? '', key.schema, key.table],
      )
      .map(toGridView);
  }

  /** The table's default view, if it has one. */
  defaultFor(table: GridViewTable): GridView | undefined {
    return this.list(table).find((view) => view.isDefault);
  }

  /**
   * Creates or updates a view. Names are unique per table (case-insensitive); making a view the
   * default takes the flag from the table's previous default in the same transaction.
   */
  save(input: GridViewSaveInput, options: WriteOptions = {}): GridView {
    const view = parseOrThrow(saveSchema, input, 'grid view');
    return this.#db.transaction(() => {
      const current = view.id === undefined ? undefined : this.get(view.id);
      if (current) checkVersion('Grid view', current.id, options.expectedVersion, current.version);
      else if (options.expectedVersion !== undefined && options.expectedVersion !== 0) {
        throw notFound('Grid view', view.id ?? '');
      }
      if (!this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [view.profileId])) {
        throw notFound('Profile', view.profileId);
      }
      const database = view.database ?? '';
      const id = current?.id ?? view.id ?? newId();
      const clash = this.#db.get(
        `SELECT id FROM grid_views
         WHERE profile_id = ? AND database_name = ? AND schema_name = ? AND table_name = ?
           AND name = ? COLLATE NOCASE AND id <> ?`,
        [view.profileId, database, view.schema, view.table, view.name, id],
      );
      if (clash) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: `A view named "${view.name}" already exists for this table`,
        });
      }
      if (view.isDefault) {
        this.#db.run(
          `UPDATE grid_views SET is_default = 0
           WHERE profile_id = ? AND database_name = ? AND schema_name = ? AND table_name = ?
             AND is_default = 1 AND id <> ?`,
          [view.profileId, database, view.schema, view.table, id],
        );
      }
      const now = this.#now();
      const values = [
        view.name,
        view.isDefault ? 1 : 0,
        JSON.stringify(view.layout),
        JSON.stringify(view.sort),
        view.filter,
      ];
      if (current) {
        this.#db.run(
          `UPDATE grid_views SET profile_id = ?, database_name = ?, schema_name = ?,
             table_name = ?, name = ?, is_default = ?, layout = ?, sort = ?, filter = ?,
             version = version + 1, updated_at = ?
           WHERE id = ?`,
          [view.profileId, database, view.schema, view.table, ...values, now, id],
        );
      } else {
        this.#db.run(
          `INSERT INTO grid_views (id, profile_id, database_name, schema_name, table_name, name,
             is_default, layout, sort, filter, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          [id, view.profileId, database, view.schema, view.table, ...values, now, now],
        );
      }
      return this.#require(id);
    });
  }

  /** Makes `id` the table's default view, or clears the default when `id` is null. */
  setDefault(table: GridViewTable, id: string | null): void {
    const key = parseOrThrow(gridViewTableSchema, table, 'grid view table');
    this.#db.transaction(() => {
      const scope = [key.profileId, key.database ?? '', key.schema, key.table];
      if (id !== null) {
        const view = this.#require(id);
        if (
          view.profileId !== key.profileId ||
          (view.database ?? '') !== (key.database ?? '') ||
          view.schema !== key.schema ||
          view.table !== key.table
        ) {
          throw notFound('Grid view', id);
        }
      }
      const now = this.#now();
      this.#db.run(
        `UPDATE grid_views SET is_default = 0, version = version + 1, updated_at = ?
         WHERE profile_id = ? AND database_name = ? AND schema_name = ? AND table_name = ?
           AND is_default = 1`,
        [now, ...scope],
      );
      if (id !== null) {
        this.#db.run(
          `UPDATE grid_views SET is_default = 1, version = version + 1, updated_at = ?
           WHERE id = ?`,
          [now, id],
        );
      }
    });
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM grid_views WHERE id = ?', [id]).changes > 0;
  }

  #require(id: string): GridView {
    const view = this.get(id);
    if (!view) throw notFound('Grid view', id);
    return view;
  }
}

function toGridView(row: SqlRow): GridView {
  const id = readText(row, 'id');
  const database = readText(row, 'database_name');
  const parsed = gridViewSchema.safeParse({
    id,
    profileId: readText(row, 'profile_id'),
    database: database === '' ? null : database,
    schema: readText(row, 'schema_name'),
    table: readText(row, 'table_name'),
    name: readText(row, 'name'),
    isDefault: readNumber(row, 'is_default') === 1,
    layout: readJson(row, 'layout'),
    sort: readJson(row, 'sort'),
    filter: readNullableText(row, 'filter'),
    version: readNumber(row, 'version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  });
  if (!parsed.success) throw corruptRow('grid view', id, parsed.error);
  return parsed.data;
}
