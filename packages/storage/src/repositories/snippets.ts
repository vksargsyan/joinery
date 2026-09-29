import { JoineryError, engineIdSchema, newId, type EngineId } from '@joinery/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNullableText, readNumber, readText } from '../internal/rows';
import { checkVersion, definedOnly, type WriteOptions } from '../internal/versioning';
import type { SqlRow, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });
const enginesSchema = z.array(engineIdSchema);

/**
 * A snippet in the user's library (spec §6). `body` is editor snippet text with template
 * variables (`${1:table}`, `${name}`), expanded by the editor, not by the store.
 */
export const snippetSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200),
  /** Autocomplete trigger word. */
  prefix: z.string().trim().min(1).nullable(),
  description: z.string().nullable(),
  body: z.string().min(1),
  /** Engines the snippet applies to; empty means every engine. */
  engines: enginesSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Snippet = z.infer<typeof snippetSchema>;

const createSchema = z.object({
  id: z.string().min(1).optional(),
  name: snippetSchema.shape.name,
  prefix: snippetSchema.shape.prefix.default(null),
  description: z.string().nullable().default(null),
  body: snippetSchema.shape.body,
  engines: enginesSchema.default([]),
});
export type SnippetCreateInput = z.input<typeof createSchema>;

const patchSchema = z.object({
  name: snippetSchema.shape.name.optional(),
  prefix: snippetSchema.shape.prefix.optional(),
  description: z.string().nullable().optional(),
  body: snippetSchema.shape.body.optional(),
  engines: enginesSchema.optional(),
});
export type SnippetPatch = z.input<typeof patchSchema>;

export class SnippetRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  get(id: string): Snippet | undefined {
    const row = this.#db.get('SELECT * FROM snippets WHERE id = ?', [id]);
    return row ? toSnippet(row) : undefined;
  }

  /** Snippets ordered by name; with `engine`, only those that apply to it. */
  list(filter: { readonly engine?: EngineId } = {}): Snippet[] {
    const rows =
      filter.engine === undefined
        ? this.#db.all('SELECT * FROM snippets ORDER BY name COLLATE NOCASE, id')
        : this.#db.all(
            `SELECT * FROM snippets
             WHERE engines = '[]'
               OR EXISTS (SELECT 1 FROM json_each(snippets.engines) WHERE value = ?)
             ORDER BY name COLLATE NOCASE, id`,
            [filter.engine],
          );
    return rows.map(toSnippet);
  }

  create(input: SnippetCreateInput): Snippet {
    const snippet = parseOrThrow(createSchema, input, 'snippet');
    return this.#db.transaction(() => {
      const id = snippet.id ?? newId();
      if (this.get(id)) {
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: `Snippet ${id} already exists`,
        });
      }
      const now = this.#now();
      this.#db.run(
        `INSERT INTO snippets (id, name, prefix, description, body, engines, version, created_at,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          id,
          snippet.name,
          snippet.prefix,
          snippet.description,
          snippet.body,
          JSON.stringify(snippet.engines),
          now,
          now,
        ],
      );
      return this.#require(id);
    });
  }

  update(id: string, patch: SnippetPatch, options: WriteOptions = {}): Snippet {
    const changes = parseOrThrow(patchSchema, patch, 'snippet');
    return this.#db.transaction(() => {
      const current = this.#require(id);
      checkVersion('Snippet', id, options.expectedVersion, current.version);
      const next = { ...current, ...definedOnly(changes) };
      this.#db.run(
        `UPDATE snippets SET name = ?, prefix = ?, description = ?, body = ?, engines = ?,
           version = version + 1, updated_at = ?
         WHERE id = ?`,
        [
          next.name,
          next.prefix,
          next.description,
          next.body,
          JSON.stringify(next.engines),
          this.#now(),
          id,
        ],
      );
      return this.#require(id);
    });
  }

  delete(id: string): boolean {
    return this.#db.run('DELETE FROM snippets WHERE id = ?', [id]).changes > 0;
  }

  #require(id: string): Snippet {
    const snippet = this.get(id);
    if (!snippet) throw notFound('Snippet', id);
    return snippet;
  }
}

function toSnippet(row: SqlRow): Snippet {
  const id = readText(row, 'id');
  const engines = enginesSchema.safeParse(readJson(row, 'engines'));
  if (!engines.success) throw corruptRow('snippet', id, engines.error);
  return {
    id,
    name: readText(row, 'name'),
    prefix: readNullableText(row, 'prefix'),
    description: readNullableText(row, 'description'),
    body: readText(row, 'body'),
    engines: engines.data,
    version: readNumber(row, 'version'),
    createdAt: readText(row, 'created_at'),
    updatedAt: readText(row, 'updated_at'),
  };
}
