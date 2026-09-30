import type { SqlDialect } from '@joinery/core';

import {
  buildCatalog,
  complete,
  type Catalog,
  type CompletionItem,
  type CompletionOptions,
  type CompletionResult,
} from '../../src';
import { mysqlSnapshots, postgresSnapshot } from './fixtures';

export const DIALECTS: readonly SqlDialect[] = ['postgres', 'mysql', 'mariadb'];

export const CATALOGS: Readonly<Record<SqlDialect, Catalog>> = {
  postgres: buildCatalog([postgresSnapshot()]),
  mysql: buildCatalog(mysqlSnapshots('mysql')),
  mariadb: buildCatalog(mysqlSnapshots('mariadb')),
};

/** Text and offset from SQL with a `|` cursor marker. */
export function cursor(sql: string): { text: string; offset: number } {
  const offset = sql.indexOf('|');
  if (offset < 0) throw new Error(`no cursor in ${sql}`);
  return { text: sql.slice(0, offset) + sql.slice(offset + 1), offset };
}

export function run(
  dialect: SqlDialect,
  sql: string,
  options?: CompletionOptions,
): CompletionResult & { labels: string[]; item: (label: string) => CompletionItem | undefined } {
  const { text, offset } = cursor(sql);
  const result = complete(text, offset, dialect, CATALOGS[dialect], options);
  return {
    ...result,
    labels: result.items.map((item) => item.label),
    item: (label) => result.items.find((item) => item.label === label),
  };
}
