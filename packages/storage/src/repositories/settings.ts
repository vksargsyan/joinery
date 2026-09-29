import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { parseOrThrow } from '../internal/errors';
import { readJson, readNumber, readText } from '../internal/rows';
import type { SqlRow, SqliteDatabase } from '../sqlite';

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const keySchema = z.string().trim().min(1).max(200);
const jsonValueSchema = z.json();

export interface SettingEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly version: number;
  readonly updatedAt: string;
}

/** App settings and UI preferences: key -> JSON value, versioned for sync (spec §16). */
export class SettingsRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  /**
   * The stored value, or undefined. With `schema`, a stored value that no longer matches (an
   * older app wrote it) also reads as undefined, so the caller falls back to its default.
   */
  get(key: string): JsonValue | undefined;
  get<S extends z.ZodType>(key: string, schema: S): z.output<S> | undefined;
  get(key: string, schema?: z.ZodType): unknown {
    const row = this.#db.get('SELECT value FROM settings WHERE key = ?', [key]);
    if (!row) return undefined;
    const value = readJson(row, 'value');
    if (!schema) return value;
    const parsed = schema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }

  set(key: string, value: JsonValue): SettingEntry {
    const validKey = parseOrThrow(keySchema, key, 'setting key');
    const json = parseOrThrow(jsonValueSchema, value, `value for setting "${validKey}"`);
    const now = this.#now();
    this.#db.run(
      `INSERT INTO settings (key, value, version, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value, version = version + 1, updated_at = excluded.updated_at`,
      [validKey, JSON.stringify(json), now],
    );
    const row = this.#db.get('SELECT * FROM settings WHERE key = ?', [validKey]);
    return row ? toEntry(row) : { key: validKey, value: json, version: 1, updatedAt: now };
  }

  delete(key: string): boolean {
    return this.#db.run('DELETE FROM settings WHERE key = ?', [key]).changes > 0;
  }

  /** Every setting, ordered by key. */
  list(): SettingEntry[] {
    return this.#db.all('SELECT * FROM settings ORDER BY key').map(toEntry);
  }
}

function toEntry(row: SqlRow): SettingEntry {
  return {
    key: readText(row, 'key'),
    value: jsonValueSchema.parse(readJson(row, 'value')),
    version: readNumber(row, 'version'),
    updatedAt: readText(row, 'updated_at'),
  };
}
