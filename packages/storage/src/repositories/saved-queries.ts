import { QuerybaraError, newId } from '@querybara/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNullableText, readNumber, readText } from '../internal/rows';
import { checkVersion, definedOnly, type WriteOptions } from '../internal/versioning';
import type { SqlRow, SqlValue, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });
const nameSchema = z.string().trim().min(1).max(200);
const tagsSchema = z.array(z.string().trim().min(1));

/**
 * A saved query (spec §6), scoped to a connection, a project, both, or neither (global).
 * Projects are identified by id only; the project model lives elsewhere.
 */
export const savedQuerySchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  text: z.string(),
  description: z.string().nullable(),
  profileId: z.string().min(1).nullable(),
  projectId: z.string().min(1).nullable(),
  /** Database to switch to before running. */
  database: z.string().nullable(),
  tags: tagsSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

const createSchema = z.object({
  id: z.string().min(1).optional(),
  name: nameSchema,
  text: z.string(),
  description: z.string().nullable().default(null),
  profileId: z.string().min(1).nullable().default(null),
  projectId: z.string().min(1).nullable().default(null),
  database: z.string().nullable().default(null),
  tags: tagsSchema.default([]),
});
export type SavedQueryCreateInput = z.input<typeof createSchema>;

const patchSchema = z.object({
  name: nameSchema.optional(),
  text: z.string().optional(),
  description: z.string().nullable().optional(),
  profileId: z.string().min(1).nullable().optional(),
  projectId: z.string().min(1).nullable().optional(),
  database: z.string().nullable().optional(),
  tags: tagsSchema.optional(),
});
export type SavedQueryPatch = z.input<typeof patchSchema>;

export interface SavedQueryFilter {
  /** A profile id, or null for queries not tied to a connection. */
  readonly profileId?: string | null;
  /** A project id, or null for queries outside any project. */
  readonly projectId?: string | null;
}

export class SavedQueryRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  get(id: string): SavedQuery | undefined {
    const row = this.#db.get('SELECT * FROM saved_queries WHERE id = ?', [id]);
    return row ? toSavedQuery(row) : undefined;
  }

  /** Saved queries ordered by name (case-insensitive). */
  list(filter: SavedQueryFilter = {}): SavedQuery[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    for (const [column, value] of [
      ['profile_id', filter.profileId],
      ['project_id', filter.projectId],
    ] as const) {
      if (value === null) where.push(`${column} IS NULL`);
      else if (value !== undefined) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    return this.#db
      .all(
        `SELECT * FROM saved_queries ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY name COLLATE NOCASE, id`,
        params,
      )
      .map(toSavedQuery);
  }

  create(input: SavedQueryCreateInput): SavedQuery {
    const query = parseOrThrow(createSchema, input, 'saved query');
    return this.#db.transaction(() => {
      const id = query.id ?? newId();
      if (this.get(id)) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Saved query ${id} already exists`,
        });
      }
      this.#requireProfile(query.profileId);
      const now = this.#now();
      this.#db.run(
        `INSERT INTO saved_queries (id, profile_id, project_id, name, description, database_name,
           text, tags, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          query.profileId,
          query.projectId,
          query.name,
          query.description,
          query.database,
          query.text,
          JSON.stringify(query.tags),
          now,
          now,
        ],
      );
      return this.#require(id);
    });
  }

  /** Changes the given fields and bumps the version. */
  update(id: string, patch: SavedQueryPatch, options: WriteOptions = {}): SavedQuery {
    const changes = parseOrThrow(patchSchema, patch, 'saved query');
    return this.#db.transaction(() => {
      const current = this.#require(id);
      checkVersion('Saved query', id, options.expectedVersion, current.version);
      const next = { ...current, ...definedOnly(changes) };
      if (next.profileId !== current.profileId) this.#requireProfile(next.profileId);
      this.#db.run(
        `UPDATE saved_queries SET profile_id = ?, project_id = ?, name = ?, description = ?,
           database_name = ?, text = ?, tags = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [
          next.profileId,
          next.projectId,
          next.name,
          next.description,
          next.database,
          next.text,
          JSON.stringify(next.tags),
          this.#now(),
          id,
        ],
      );
      return this.#require(id);
    });
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM saved_queries WHERE id = ?', [id]).changes > 0;
  }

  #require(id: string): SavedQuery {
    const query = this.get(id);
    if (!query) throw notFound('Saved query', id);
    return query;
  }

  #requireProfile(profileId: string | null): void {
    if (
      profileId !== null &&
      !this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [profileId])
    ) {
      throw notFound('Profile', profileId);
    }
  }
}

function toSavedQuery(row: SqlRow): SavedQuery {
  const id = readText(row, 'id');
  const tags = tagsSchema.safeParse(readJson(row, 'tags'));
  if (!tags.success) throw corruptRow('saved query', id, tags.error);
  return {
    id,
    name: readText(row, 'name'),
    text: readText(row, 'text'),
    description: readNullableText(row, 'description'),
    profileId: readNullableText(row, 'profile_id'),
    projectId: readNullableText(row, 'project_id'),
    database: readNullableText(row, 'database_name'),
    tags: tags.data,
    version: readNumber(row, 'version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  };
}
