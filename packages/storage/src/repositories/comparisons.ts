import { QuerybaraError, newId } from '@querybara/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNullableText, readNumber, readText } from '../internal/rows';
import { checkVersion, definedOnly, type WriteOptions } from '../internal/versioning';
import type { SqlRow, SqlValue, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });
const nameSchema = z.string().trim().min(1).max(200);
const kindSchema = z.enum(['structure', 'data']);
const definitionSchema = z.record(z.string(), z.json());

/**
 * A saved structure or data comparison (spec §13: comparisons save as profiles, to reopen and,
 * later, to schedule). The two connections are columns (a deleted connection clears its side);
 * the databases, schemas, options and rename mapping are the `definition` JSON object, whose
 * shape the desktop app validates, as it does for settings.
 */
export const savedComparisonRecordSchema = z.object({
  id: z.string().min(1),
  name: nameSchema,
  kind: kindSchema,
  sourceProfileId: z.string().min(1).nullable(),
  targetProfileId: z.string().min(1).nullable(),
  definition: definitionSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type SavedComparisonRecord = z.infer<typeof savedComparisonRecordSchema>;

const createSchema = z.object({
  id: z.string().min(1).optional(),
  name: nameSchema,
  kind: kindSchema,
  sourceProfileId: z.string().min(1).nullable().default(null),
  targetProfileId: z.string().min(1).nullable().default(null),
  definition: definitionSchema.default({}),
});
export type SavedComparisonCreateInput = z.input<typeof createSchema>;

const patchSchema = z.object({
  name: nameSchema.optional(),
  sourceProfileId: z.string().min(1).nullable().optional(),
  targetProfileId: z.string().min(1).nullable().optional(),
  definition: definitionSchema.optional(),
});
export type SavedComparisonPatch = z.input<typeof patchSchema>;

export interface SavedComparisonFilter {
  readonly kind?: 'structure' | 'data';
  /** Comparisons with this connection on either side. */
  readonly profileId?: string;
}

export class SavedComparisonRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  get(id: string): SavedComparisonRecord | undefined {
    const row = this.#db.get('SELECT * FROM saved_comparisons WHERE id = ?', [id]);
    return row ? toRecord(row) : undefined;
  }

  /** Saved comparisons ordered by name (case-insensitive). */
  list(filter: SavedComparisonFilter = {}): SavedComparisonRecord[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.kind !== undefined) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    if (filter.profileId !== undefined) {
      where.push('(source_profile_id = ? OR target_profile_id = ?)');
      params.push(filter.profileId, filter.profileId);
    }
    return this.#db
      .all(
        `SELECT * FROM saved_comparisons ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY name COLLATE NOCASE, id`,
        params,
      )
      .map(toRecord);
  }

  create(input: SavedComparisonCreateInput): SavedComparisonRecord {
    const comparison = parseOrThrow(createSchema, input, 'saved comparison');
    return this.#db.transaction(() => {
      const id = comparison.id ?? newId();
      if (this.get(id)) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Saved comparison ${id} already exists`,
        });
      }
      this.#requireProfile(comparison.sourceProfileId);
      this.#requireProfile(comparison.targetProfileId);
      const now = this.#now();
      this.#db.run(
        `INSERT INTO saved_comparisons (id, name, kind, source_profile_id, target_profile_id,
           definition, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          comparison.name,
          comparison.kind,
          comparison.sourceProfileId,
          comparison.targetProfileId,
          JSON.stringify(comparison.definition),
          now,
          now,
        ],
      );
      return this.#require(id);
    });
  }

  /** Changes the given fields and bumps the version. The kind never changes. */
  update(
    id: string,
    patch: SavedComparisonPatch,
    options: WriteOptions = {},
  ): SavedComparisonRecord {
    const changes = parseOrThrow(patchSchema, patch, 'saved comparison');
    return this.#db.transaction(() => {
      const current = this.#require(id);
      checkVersion('Saved comparison', id, options.expectedVersion, current.version);
      const next = { ...current, ...definedOnly(changes) };
      if (next.sourceProfileId !== current.sourceProfileId) {
        this.#requireProfile(next.sourceProfileId);
      }
      if (next.targetProfileId !== current.targetProfileId) {
        this.#requireProfile(next.targetProfileId);
      }
      this.#db.run(
        `UPDATE saved_comparisons SET name = ?, source_profile_id = ?, target_profile_id = ?,
           definition = ?, version = version + 1, updated_at = ?
         WHERE id = ?`,
        [
          next.name,
          next.sourceProfileId,
          next.targetProfileId,
          JSON.stringify(next.definition),
          this.#now(),
          id,
        ],
      );
      return this.#require(id);
    });
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM saved_comparisons WHERE id = ?', [id]).changes > 0;
  }

  #require(id: string): SavedComparisonRecord {
    const comparison = this.get(id);
    if (!comparison) throw notFound('Saved comparison', id);
    return comparison;
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

function toRecord(row: SqlRow): SavedComparisonRecord {
  const id = readText(row, 'id');
  const kind = kindSchema.safeParse(readText(row, 'kind'));
  if (!kind.success) throw corruptRow('saved comparison', id, kind.error);
  const definition = definitionSchema.safeParse(readJson(row, 'definition'));
  if (!definition.success) throw corruptRow('saved comparison', id, definition.error);
  return {
    id,
    name: readText(row, 'name'),
    kind: kind.data,
    sourceProfileId: readNullableText(row, 'source_profile_id'),
    targetProfileId: readNullableText(row, 'target_profile_id'),
    definition: definition.data,
    version: readNumber(row, 'version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  };
}
