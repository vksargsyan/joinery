import {
  connectionProfileSchema,
  newId,
  secretRefsOf,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type EngineId,
  type Environment,
} from '@querybara/core';

import type { RepositoryContext } from '../internal/context';
import { corruptRow, notFound, parseOrThrow } from '../internal/errors';
import { readJson, readNumber, readText } from '../internal/rows';
import { checkVersion, type WriteOptions } from '../internal/versioning';
import { deleteUnreferencedSecrets } from '../secrets/secret-store';
import type { SqlValue, SqliteDatabase } from '../sqlite';

/** A profile as stored: the validated profile plus its row version. */
export type StoredProfile = ConnectionProfile & { readonly version: number };

/**
 * What `save` takes: a profile without the fields the store owns. `id` is generated when
 * absent; `createdAt` is kept from the stored row, or taken from the input for a new row
 * (imports keep their creation time); `updatedAt` is always now. Extra keys such as `version`
 * are ignored, so a `StoredProfile` can be passed back after editing.
 */
export type ProfileSaveInput = Omit<ConnectionProfileInput, 'id' | 'createdAt' | 'updatedAt'> & {
  readonly id?: string;
  readonly createdAt?: string;
};

export interface ProfileFilter {
  /** A folder id, or null for profiles at the root. */
  readonly folderId?: string | null;
  readonly engine?: EngineId;
  readonly environment?: Environment;
}

export interface ProfileRepositoryHooks {
  /** Called after a write that left secrets unreferenced (their sealed values are deleted). */
  readonly onSecretsReleased?: (ids: readonly string[]) => void;
}

/**
 * Connection profiles (spec §4). Each row holds the full validated profile as JSON plus
 * indexed copies of name, engine, folder and environment for listing and filtering.
 */
export class ProfileRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;
  readonly #hooks: ProfileRepositoryHooks;

  constructor(context: RepositoryContext, hooks: ProfileRepositoryHooks = {}) {
    this.#db = context.db;
    this.#now = context.now;
    this.#hooks = hooks;
  }

  get(id: string): StoredProfile | undefined {
    const row = this.#db.get('SELECT id, data, version FROM profiles WHERE id = ?', [id]);
    return row ? toProfile(row) : undefined;
  }

  /**
   * Profiles ordered by folder, then name (case-insensitive): root profiles first, then each
   * folder's profiles in the folders' own order (sort order, then name).
   */
  list(filter: ProfileFilter = {}): StoredProfile[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.folderId === null) where.push('p.folder_id IS NULL');
    else if (filter.folderId !== undefined) {
      where.push('p.folder_id = ?');
      params.push(filter.folderId);
    }
    if (filter.engine !== undefined) {
      where.push('p.engine = ?');
      params.push(filter.engine);
    }
    if (filter.environment !== undefined) {
      where.push('p.environment = ?');
      params.push(filter.environment);
    }
    const rows = this.#db.all(
      `SELECT p.id, p.data, p.version FROM profiles p LEFT JOIN folders f ON f.id = p.folder_id
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.folder_id IS NOT NULL, f.sort_order, f.name COLLATE NOCASE, f.id,
         p.name COLLATE NOCASE, p.id`,
      params,
    );
    return rows.map(toProfile);
  }

  count(): number {
    const row = this.#db.get('SELECT count(*) AS n FROM profiles');
    return row ? readNumber(row, 'n') : 0;
  }

  /**
   * Creates or replaces a profile, bumping `updatedAt` and the row version. Secrets the previous
   * version referenced and no profile references any more are deleted.
   */
  save(input: ProfileSaveInput, options: WriteOptions = {}): StoredProfile {
    let released: string[] = [];
    const saved = this.#db.transaction(() => {
      const id = input.id ?? newId();
      const existing = this.#db.get('SELECT version, created_at FROM profiles WHERE id = ?', [id]);
      const currentVersion = existing ? readNumber(existing, 'version') : 0;
      checkVersion('Profile', id, options.expectedVersion, currentVersion);
      const now = this.#now();
      const profile = parseOrThrow(
        connectionProfileSchema,
        {
          ...input,
          id,
          createdAt: existing ? readText(existing, 'created_at') : (input.createdAt ?? now),
          updatedAt: now,
        },
        'connection profile',
      );
      const folderId = profile.presentation.folderId;
      if (
        folderId !== null &&
        !this.#db.get('SELECT 1 AS found FROM folders WHERE id = ?', [folderId])
      ) {
        throw notFound('Folder', folderId);
      }
      const version = currentVersion + 1;
      this.#db.run(
        `INSERT INTO profiles
           (id, name, engine, folder_id, environment, data, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name, engine = excluded.engine, folder_id = excluded.folder_id,
           environment = excluded.environment, data = excluded.data, version = excluded.version,
           updated_at = excluded.updated_at`,
        [
          id,
          profile.name,
          profile.engine,
          folderId,
          profile.presentation.environment,
          JSON.stringify(profile),
          version,
          profile.createdAt,
          profile.updatedAt,
        ],
      );
      released = this.#syncSecretRefs(id, profile);
      return { ...profile, version };
    });
    this.#release(released);
    return saved;
  }

  /** Moves a profile into a folder (null: the root). */
  move(id: string, folderId: string | null, options: WriteOptions = {}): StoredProfile {
    return this.#db.transaction(() => {
      const current = this.get(id);
      if (!current) throw notFound('Profile', id);
      return this.save(
        { ...current, presentation: { ...current.presentation, folderId } },
        options,
      );
    });
  }

  /**
   * Deletes a profile with everything that belongs to it: its query history, metadata cache,
   * connection-scoped saved queries and the secrets no other profile references. Saved queries
   * that also belong to a project stay in the project, detached from the connection.
   */
  delete(id: string): boolean {
    let released: string[] = [];
    const deleted = this.#db.transaction(() => {
      const refs = this.#secretIdsOf(id);
      this.#db.run('DELETE FROM saved_queries WHERE profile_id = ? AND project_id IS NULL', [id]);
      this.#db.run(
        `UPDATE saved_queries SET profile_id = NULL, version = version + 1, updated_at = ?
         WHERE profile_id = ?`,
        [this.#now(), id],
      );
      // History, metadata cache and secret links go with the row (ON DELETE CASCADE).
      if (this.#db.run('DELETE FROM profiles WHERE id = ?', [id]).changes === 0) return false;
      released = deleteUnreferencedSecrets(this.#db, refs);
      return true;
    });
    this.#release(released);
    return deleted;
  }

  #secretIdsOf(profileId: string): string[] {
    return this.#db
      .all('SELECT secret_id FROM profile_secrets WHERE profile_id = ?', [profileId])
      .map((row) => readText(row, 'secret_id'));
  }

  #syncSecretRefs(profileId: string, profile: ConnectionProfile): string[] {
    const previous = this.#secretIdsOf(profileId);
    const next = new Set(secretRefsOf(profile).map((ref) => ref.id));
    const dropped = previous.filter((id) => !next.has(id));
    for (const secretId of dropped) {
      this.#db.run('DELETE FROM profile_secrets WHERE profile_id = ? AND secret_id = ?', [
        profileId,
        secretId,
      ]);
    }
    for (const secretId of next) {
      this.#db.run('INSERT OR IGNORE INTO profile_secrets (profile_id, secret_id) VALUES (?, ?)', [
        profileId,
        secretId,
      ]);
    }
    return deleteUnreferencedSecrets(this.#db, dropped);
  }

  #release(ids: readonly string[]): void {
    if (ids.length > 0) this.#hooks.onSecretsReleased?.(ids);
  }
}

function toProfile(row: Readonly<Record<string, SqlValue>>): StoredProfile {
  const id = readText(row, 'id');
  const parsed = connectionProfileSchema.safeParse(readJson(row, 'data'));
  if (!parsed.success) throw corruptRow('profile', id, parsed.error);
  return { ...parsed.data, version: readNumber(row, 'version') };
}
