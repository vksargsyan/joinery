import { QuerybaraError, newId } from '@querybara/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { notFound, parseOrThrow } from '../internal/errors';
import { readNullableText, readNumber, readText } from '../internal/rows';
import { checkVersion, type WriteOptions } from '../internal/versioning';
import type { SqlRow, SqliteDatabase } from '../sqlite';
import type { ProfileRepository } from './profiles';

const timestampSchema = z.iso.datetime({ offset: true });
const folderNameSchema = z.string().trim().min(1).max(200);

/** A folder in the connection tree (spec §4, "Organisation"). Folders nest. */
export const folderSchema = z.object({
  id: z.string().min(1),
  /** The containing folder, or null at the root. */
  parentId: z.string().min(1).nullable(),
  name: folderNameSchema,
  /** Position among siblings; ties sort by name. */
  sortOrder: z.number().int(),
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Folder = z.infer<typeof folderSchema>;

const folderCreateSchema = z.object({
  id: z.string().min(1).optional(),
  name: folderNameSchema,
  parentId: z.string().min(1).nullable().default(null),
  sortOrder: z.number().int().default(0),
});
export type FolderCreateInput = z.input<typeof folderCreateSchema>;

const folderPatchSchema = z.object({
  name: folderNameSchema.optional(),
  parentId: z.string().min(1).nullable().optional(),
  sortOrder: z.number().int().optional(),
});
export type FolderPatch = z.input<typeof folderPatchSchema>;

export class FolderRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;
  readonly #profiles: ProfileRepository;

  constructor(context: RepositoryContext, profiles: ProfileRepository) {
    this.#db = context.db;
    this.#now = context.now;
    this.#profiles = profiles;
  }

  get(id: string): Folder | undefined {
    const row = this.#db.get('SELECT * FROM folders WHERE id = ?', [id]);
    return row ? toFolder(row) : undefined;
  }

  /** Folders ordered by sort order, then name; filter by parent (null: top-level folders). */
  list(filter: { readonly parentId?: string | null } = {}): Folder[] {
    const order = 'ORDER BY sort_order, name COLLATE NOCASE, id';
    const rows =
      filter.parentId === undefined
        ? this.#db.all(`SELECT * FROM folders ${order}`)
        : filter.parentId === null
          ? this.#db.all(`SELECT * FROM folders WHERE parent_id IS NULL ${order}`)
          : this.#db.all(`SELECT * FROM folders WHERE parent_id = ? ${order}`, [filter.parentId]);
    return rows.map(toFolder);
  }

  create(input: FolderCreateInput): Folder {
    const folder = parseOrThrow(folderCreateSchema, input, 'folder');
    return this.#db.transaction(() => {
      const id = folder.id ?? newId();
      if (this.get(id)) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Folder ${id} already exists`,
        });
      }
      if (folder.parentId !== null) this.#requireFolder(folder.parentId);
      const now = this.#now();
      this.#db.run(
        `INSERT INTO folders (id, parent_id, name, sort_order, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [id, folder.parentId, folder.name, folder.sortOrder, now, now],
      );
      return this.#require(id);
    });
  }

  /** Renames, reorders or moves a folder. Moving a folder into its own subtree is refused. */
  update(id: string, patch: FolderPatch, options: WriteOptions = {}): Folder {
    const changes = parseOrThrow(folderPatchSchema, patch, 'folder');
    return this.#db.transaction(() => {
      const current = this.#require(id);
      checkVersion('Folder', id, options.expectedVersion, current.version);
      const parentId = changes.parentId === undefined ? current.parentId : changes.parentId;
      if (parentId !== null && parentId !== current.parentId) {
        this.#requireFolder(parentId);
        if (this.#isSelfOrDescendant(parentId, id)) {
          throw new QuerybaraError({
            code: 'VALIDATION_FAILED',
            message: 'A folder cannot be moved into itself or one of its subfolders',
          });
        }
      }
      this.#db.run(
        `UPDATE folders SET parent_id = ?, name = ?, sort_order = ?, version = version + 1,
           updated_at = ? WHERE id = ?`,
        [
          parentId,
          changes.name ?? current.name,
          changes.sortOrder ?? current.sortOrder,
          this.#now(),
          id,
        ],
      );
      return this.#require(id);
    });
  }

  /**
   * Deletes a folder but keeps its contents: its subfolders and profiles move up to its parent
   * (or the root), each with a version bump so sync sees the move.
   */
  delete(id: string): boolean {
    return this.#db.transaction(() => {
      const folder = this.get(id);
      if (!folder) return false;
      this.#db.run(
        `UPDATE folders SET parent_id = ?, version = version + 1, updated_at = ?
         WHERE parent_id = ?`,
        [folder.parentId, this.#now(), id],
      );
      for (const profile of this.#profiles.list({ folderId: id })) {
        this.#profiles.move(profile.id, folder.parentId);
      }
      this.#db.run('DELETE FROM folders WHERE id = ?', [id]);
      return true;
    });
  }

  #require(id: string): Folder {
    const folder = this.get(id);
    if (!folder) throw notFound('Folder', id);
    return folder;
  }

  #requireFolder(id: string): void {
    if (!this.#db.get('SELECT 1 AS found FROM folders WHERE id = ?', [id])) {
      throw notFound('Folder', id);
    }
  }

  /** True when `candidate` is `folderId` or lies somewhere below it. */
  #isSelfOrDescendant(candidate: string, folderId: string): boolean {
    const row = this.#db.get(
      `WITH RECURSIVE ancestors (id, parent_id) AS (
         SELECT id, parent_id FROM folders WHERE id = ?
         UNION
         SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id
       )
       SELECT 1 AS found FROM ancestors WHERE id = ?`,
      [candidate, folderId],
    );
    return row !== undefined;
  }
}

function toFolder(row: SqlRow): Folder {
  return {
    id: readText(row, 'id'),
    parentId: readNullableText(row, 'parent_id'),
    name: readText(row, 'name'),
    sortOrder: readNumber(row, 'sort_order'),
    version: readNumber(row, 'version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  };
}
