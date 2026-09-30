import type { SqliteDatabase } from '../sqlite';

/** What every repository needs: the database and a clock returning ISO timestamps. */
export interface RepositoryContext {
  readonly db: SqliteDatabase;
  readonly now: () => string;
}
