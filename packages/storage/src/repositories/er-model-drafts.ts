import { QuerybaraError } from '@querybara/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNumber, readText } from '../internal/rows';
import type { SqlRow, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });
const documentSchema = z.record(z.string(), z.json());

/** The largest draft kept, as JSON text (the model and the schema it started from). */
export const MAX_ER_DRAFT_TEXT = 32_000_000;

/**
 * Where a draft belongs: one schema (PostgreSQL) or database (MySQL, MariaDB) of a
 * connection. `database` is the database's name as the server reports it.
 */
export const erModelDraftKeySchema = z.object({
  profileId: z.string().min(1),
  database: z.string().max(1024),
  schema: z.string().max(1024),
});
export type ErModelDraftKey = z.infer<typeof erModelDraftKeySchema>;

/**
 * An ER model's unapplied changes (spec §8, forward engineering): kept as the user edits, so
 * closing the diagram or the app loses nothing, and removed when the changes are applied or
 * discarded. The model itself is the `document` JSON object, whose shape the desktop app
 * validates (it holds schema snapshots, which this package does not interpret); `changes`
 * counts the changed tables for summaries.
 */
export const erModelDraftSchema = erModelDraftKeySchema.extend({
  document: documentSchema,
  changes: z.number().int().nonnegative(),
  savedAt: timestampSchema,
});
export type ErModelDraft = z.infer<typeof erModelDraftSchema>;

export type ErModelDraftSummary = Omit<ErModelDraft, 'document'>;

const inputSchema = erModelDraftKeySchema.extend({
  document: documentSchema,
  changes: z.number().int().nonnegative(),
});
export type ErModelDraftInput = z.input<typeof inputSchema>;

export class ErModelDraftRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  get(key: ErModelDraftKey): ErModelDraft | undefined {
    const { profileId, database, schema } = parseOrThrow(erModelDraftKeySchema, key, 'draft key');
    const row = this.#db.get(
      `SELECT * FROM er_model_drafts
       WHERE profile_id = ? AND database_name = ? AND schema_name = ?`,
      [profileId, database, schema],
    );
    return row ? toDraft(row) : undefined;
  }

  /** The drafts of a connection (of one database when given), newest first, without models. */
  list(filter: { readonly profileId: string; readonly database?: string }): ErModelDraftSummary[] {
    const params = [filter.profileId, ...(filter.database === undefined ? [] : [filter.database])];
    return this.#db
      .all(
        `SELECT profile_id, database_name, schema_name, changes, saved_at FROM er_model_drafts
         WHERE profile_id = ?${filter.database === undefined ? '' : ' AND database_name = ?'}
         ORDER BY saved_at DESC, schema_name`,
        params,
      )
      .map(toSummary);
  }

  /** Writes a draft, replacing the one kept for the same place. */
  put(input: ErModelDraftInput): ErModelDraft {
    const draft = parseOrThrow(inputSchema, input, 'ER model draft');
    const text = JSON.stringify(draft.document);
    if (text.length > MAX_ER_DRAFT_TEXT) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'The ER model is too large to keep as a draft',
        hint: 'Save it to a file instead.',
      });
    }
    return this.#db.transaction(() => {
      if (!this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [draft.profileId])) {
        throw notFound('Profile', draft.profileId);
      }
      this.#db.run(
        `INSERT INTO er_model_drafts (profile_id, database_name, schema_name, document, changes,
           saved_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, database_name, schema_name) DO UPDATE SET
           document = excluded.document, changes = excluded.changes, saved_at = excluded.saved_at`,
        [draft.profileId, draft.database, draft.schema, text, draft.changes, this.#now()],
      );
      return this.get(draft)!;
    });
  }

  delete(key: ErModelDraftKey): boolean {
    const { profileId, database, schema } = parseOrThrow(erModelDraftKeySchema, key, 'draft key');
    return (
      this.#db.run(
        `DELETE FROM er_model_drafts
         WHERE profile_id = ? AND database_name = ? AND schema_name = ?`,
        [profileId, database, schema],
      ).changes > 0
    );
  }
}

function toSummary(row: SqlRow): ErModelDraftSummary {
  return {
    profileId: readText(row, 'profile_id'),
    database: readText(row, 'database_name'),
    schema: readText(row, 'schema_name'),
    changes: readNumber(row, 'changes'),
    savedAt: readText(row, 'saved_at'),
  };
}

function toDraft(row: SqlRow): ErModelDraft {
  const summary = toSummary(row);
  const document = documentSchema.safeParse(readJson(row, 'document'));
  if (!document.success) {
    throw corruptRow('ER model draft', `${summary.database}/${summary.schema}`, document.error);
  }
  return { ...summary, document: document.data };
}
