import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { parseOrThrow } from '../internal/errors';
import { readNullableNumber, readNullableText, readNumber, readText } from '../internal/rows';
import type { SqlRow, SqliteDatabase } from '../sqlite';

const timestampSchema = z.iso.datetime({ offset: true });

/**
 * Editors whose buffers autosave: SQL query tabs, the MongoDB console, shell and SQL tabs, the
 * Redis CLI.
 */
export const AUTOSAVE_KINDS = [
  'sql',
  'mongo-console',
  'mongo-shell',
  'mongo-sql',
  'redis-cli',
] as const;
export type AutosaveKind = (typeof AUTOSAVE_KINDS)[number];

/** The largest buffer kept, in UTF-16 code units (a big script, not a data dump). */
export const MAX_AUTOSAVE_TEXT = 8_000_000;

/**
 * An editor tab's unsaved buffer and the context it runs in (spec §18: unsaved editor tabs
 * autosave every few seconds and come back after a crash). Only what the user typed and where
 * it runs: never results, never secrets.
 */
export const autosaveEntrySchema = z.object({
  /** The tab's id. */
  id: z.string().min(1).max(128),
  kind: z.enum(AUTOSAVE_KINDS),
  profileId: z.string().min(1),
  /** The database (MongoDB database, Redis DB index...) the editor runs in; null for the default. */
  database: z.string().max(1024).nullable(),
  title: z.string().max(500),
  text: z.string().max(MAX_AUTOSAVE_TEXT),
  /** Caret offset in `text`. */
  cursor: z.number().int().nonnegative().nullable(),
  /** Tab order: restored tabs open in this order. */
  position: z.number().int().nonnegative(),
  savedAt: timestampSchema,
});
export type AutosaveEntry = z.infer<typeof autosaveEntrySchema>;

const inputSchema = autosaveEntrySchema.omit({ savedAt: true }).extend({
  database: z.string().max(1024).nullable().default(null),
  cursor: z.number().int().nonnegative().nullable().default(null),
});
export type AutosaveEntryInput = z.input<typeof inputSchema>;

/** How the previous run of the app ended, as `startRun` found it. */
export interface PreviousRun {
  /** `none` on the first run with this store. */
  readonly ended: 'none' | 'clean' | 'unclean';
  readonly startedAt: string | null;
}

/**
 * Editor autosave and the app's run marker. `save` upserts and removes buffers in one
 * transaction; buffers of a profile deleted meanwhile are skipped (and go with the profile).
 * `startRun` / `finishRun` bracket a desktop session, so the next start knows whether the last
 * one crashed.
 */
export class EditorAutosaveRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  /**
   * Every saved buffer, in tab order. A row this build cannot read (a kind a newer Joinery
   * wrote) is left out rather than failing the whole restore.
   */
  list(): AutosaveEntry[] {
    return this.#db
      .all('SELECT * FROM editor_autosave ORDER BY position, saved_at')
      .flatMap((row) => toEntry(row) ?? []);
  }

  get(id: string): AutosaveEntry | undefined {
    const row = this.#db.get('SELECT * FROM editor_autosave WHERE id = ?', [id]);
    return row ? toEntry(row) : undefined;
  }

  /** Writes `upsert` and deletes `remove`, atomically; returns the ids written. */
  save(changes: {
    readonly upsert?: readonly AutosaveEntryInput[];
    readonly remove?: readonly string[];
  }): string[] {
    const entries = (changes.upsert ?? []).map((entry) =>
      parseOrThrow(inputSchema, entry, 'autosave entry'),
    );
    return this.#db.transaction(() => {
      for (const id of changes.remove ?? []) {
        this.#db.run('DELETE FROM editor_autosave WHERE id = ?', [id]);
      }
      const written: string[] = [];
      const savedAt = this.#now();
      for (const entry of entries) {
        if (!this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [entry.profileId])) {
          continue;
        }
        this.#db.run(
          `INSERT INTO editor_autosave (id, kind, profile_id, database_name, title, text, cursor,
             position, saved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             kind = excluded.kind, profile_id = excluded.profile_id,
             database_name = excluded.database_name, title = excluded.title,
             text = excluded.text, cursor = excluded.cursor, position = excluded.position,
             saved_at = excluded.saved_at`,
          [
            entry.id,
            entry.kind,
            entry.profileId,
            entry.database,
            entry.title,
            entry.text,
            entry.cursor,
            entry.position,
            savedAt,
          ],
        );
        written.push(entry.id);
      }
      return written;
    });
  }

  /** Deletes buffers (their tabs were closed on purpose); returns how many existed. */
  discard(ids: readonly string[]): number {
    return this.#db.transaction(() =>
      ids.reduce(
        (count, id) =>
          count + this.#db.run('DELETE FROM editor_autosave WHERE id = ?', [id]).changes,
        0,
      ),
    );
  }

  /**
   * Marks the app as running and reports how the previous run ended: `unclean` when it never
   * called `finishRun` (a crash, a kill, a power cut).
   */
  startRun(): PreviousRun {
    return this.#db.transaction(() => {
      const row = this.#db.get('SELECT started_at, ended_at FROM app_runs WHERE id = 1');
      const previous: PreviousRun = row
        ? {
            ended: readNullableText(row, 'ended_at') === null ? 'unclean' : 'clean',
            startedAt: readText(row, 'started_at'),
          }
        : { ended: 'none', startedAt: null };
      this.#db.run(
        `INSERT INTO app_runs (id, started_at, ended_at) VALUES (1, ?, NULL)
         ON CONFLICT (id) DO UPDATE SET started_at = excluded.started_at, ended_at = NULL`,
        [this.#now()],
      );
      return previous;
    });
  }

  /** Marks the current run as ended cleanly. */
  finishRun(): void {
    this.#db.run('UPDATE app_runs SET ended_at = ? WHERE id = 1', [this.#now()]);
  }
}

function toEntry(row: SqlRow): AutosaveEntry | undefined {
  const parsed = autosaveEntrySchema.safeParse({
    id: readText(row, 'id'),
    kind: readText(row, 'kind'),
    profileId: readText(row, 'profile_id'),
    database: readNullableText(row, 'database_name'),
    title: readText(row, 'title'),
    text: readText(row, 'text'),
    cursor: readNullableNumber(row, 'cursor'),
    position: readNumber(row, 'position'),
    savedAt: readText(row, 'saved_at'),
  });
  return parsed.success ? parsed.data : undefined;
}
