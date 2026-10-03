import { QuerybaraError, atLeast, type BrowseNode, type BrowseNodeKind } from '@querybara/core';
import { num, opt, str, type Row } from '@querybara/driver-sql-base';

import type { QueryFn } from './introspect';

/**
 * The MySQL / MariaDB object explorer tree (spec §5), loaded one level at a time:
 *
 *     database / folder / object / (columns | indexes | triggers) / item
 *
 * Folder segments are stable ids ("tables", "procedures"...); the display name is in `name`.
 * Sequences appear for MariaDB 10.3+. Object lists carry the information_schema statistics
 * (row estimate, data and index size, engine, collation, comment), which MySQL 8 caches.
 */

const SYSTEM_DATABASES = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

const FOLDERS: readonly (readonly [string, string])[] = [
  ['tables', 'Tables'],
  ['views', 'Views'],
  ['functions', 'Functions'],
  ['procedures', 'Procedures'],
  ['triggers', 'Triggers'],
  ['events', 'Events'],
  ['sequences', 'Sequences'],
];

const SUBFOLDERS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  tables: [
    ['columns', 'Columns'],
    ['indexes', 'Indexes'],
    ['triggers', 'Triggers'],
  ],
  views: [['columns', 'Columns']],
};

type Detail = Record<string, string | number | null>;

function detail(entries: Record<string, string | number | null | undefined>): Detail {
  const out: Detail = {};
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) out[key] = value;
  return out;
}

function node(
  kind: BrowseNodeKind,
  name: string,
  path: readonly string[],
  hasChildren: boolean,
  extra?: Detail,
): BrowseNode {
  return {
    kind,
    name,
    path,
    hasChildren,
    ...(extra && Object.keys(extra).length > 0 ? { detail: extra } : {}),
  };
}

function numberOrNull(row: Row, key: string): number | null {
  const value = row[key];
  return value === null || value === undefined ? null : num(row, key);
}

/** Children of `path` in the MySQL / MariaDB tree; `[]` lists databases. */
export async function browseMysql(
  query: QueryFn,
  mariadb: boolean,
  serverVersion: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  if (path.length === 0) {
    const rows = await query(
      `SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
       FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME`,
    );
    return rows
      .map((row) =>
        node(
          'database',
          str(row, 'name'),
          [str(row, 'name')],
          true,
          detail({
            charset: opt(row, 'charset'),
            collation: opt(row, 'collation'),
            system: SYSTEM_DATABASES.has(str(row, 'name')) ? 1 : 0,
          }),
        ),
      )
      .sort((a, b) => Number(a.detail?.['system'] ?? 0) - Number(b.detail?.['system'] ?? 0));
  }
  const [db, folder, object, subfolder] = path as [string, string?, string?, string?];
  if (path.length === 1) {
    const sequences = mariadb && atLeast(serverVersion, '10.3.0');
    return FOLDERS.filter(([id]) => id !== 'sequences' || sequences).map(([id, name]) =>
      node('folder', name, [db, id], true),
    );
  }
  if (path.length === 2) {
    switch (folder) {
      case 'tables':
        return listTables(query, db, path);
      case 'views':
        return listViews(query, db, path);
      case 'functions':
      case 'procedures':
        return listRoutines(query, db, path, folder === 'procedures');
      case 'triggers':
        return listTriggers(query, db, path);
      case 'events':
        return listEvents(query, db, path);
      case 'sequences':
        return listSequences(query, db, path);
      default:
        throw notFound(path);
    }
  }
  const subfolders = SUBFOLDERS[folder ?? ''];
  if (!subfolders) throw notFound(path);
  if (path.length === 3)
    return subfolders.map(([id, name]) => node('folder', name, [...path, id], true));
  if (path.length === 4) {
    switch (subfolder) {
      case 'columns':
        return listColumns(query, db, object!, path);
      case 'indexes':
        return listIndexes(query, db, object!, path);
      case 'triggers':
        return listTriggers(query, db, path, object);
      default:
        throw notFound(path);
    }
  }
  return [];
}

function notFound(path: readonly string[]): QuerybaraError {
  return new QuerybaraError({
    code: 'NOT_FOUND',
    message: `Nothing to browse at ${path.join(' / ')}`,
  });
}

async function listTables(
  query: QueryFn,
  db: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS table_rows, DATA_LENGTH AS data_size,
       INDEX_LENGTH AS index_size, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment,
       AUTO_INCREMENT AS auto_increment, CREATE_TIME AS created, UPDATE_TIME AS updated, TABLE_TYPE AS type
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')
     ORDER BY TABLE_NAME`,
    [db],
  );
  return rows.map((row) =>
    node(
      'table',
      str(row, 'name'),
      [...path, str(row, 'name')],
      true,
      detail({
        rows: numberOrNull(row, 'table_rows'),
        dataSize: numberOrNull(row, 'data_size'),
        indexSize: numberOrNull(row, 'index_size'),
        engine: opt(row, 'engine'),
        collation: opt(row, 'collation'),
        autoIncrement:
          row['auto_increment'] === null ? undefined : numberOrNull(row, 'auto_increment'),
        created: opt(row, 'created'),
        updated: opt(row, 'updated'),
        systemVersioned: str(row, 'type') === 'SYSTEM VERSIONED' ? 1 : undefined,
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listViews(
  query: QueryFn,
  db: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT TABLE_NAME AS name, IS_UPDATABLE AS updatable, DEFINER AS definer, SECURITY_TYPE AS security
     FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [db],
  );
  return rows.map((row) =>
    node(
      'view',
      str(row, 'name'),
      [...path, str(row, 'name')],
      true,
      detail({
        updatable: str(row, 'updatable') === 'YES' ? 1 : 0,
        definer: opt(row, 'definer'),
        security: opt(row, 'security'),
      }),
    ),
  );
}

async function listRoutines(
  query: QueryFn,
  db: string,
  path: readonly string[],
  procedures: boolean,
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT ROUTINE_NAME AS name, DTD_IDENTIFIER AS returns, DEFINER AS definer,
       ROUTINE_COMMENT AS comment, CREATED AS created, LAST_ALTERED AS modified
     FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ?
     ORDER BY ROUTINE_NAME`,
    [db, procedures ? 'PROCEDURE' : 'FUNCTION'],
  );
  return rows.map((row) =>
    node(
      procedures ? 'procedure' : 'function',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        returns: procedures ? undefined : opt(row, 'returns'),
        definer: opt(row, 'definer'),
        created: opt(row, 'created'),
        modified: opt(row, 'modified'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listTriggers(
  query: QueryFn,
  db: string,
  path: readonly string[],
  table?: string,
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, ACTION_TIMING AS timing,
       EVENT_MANIPULATION AS event, DEFINER AS definer
     FROM information_schema.TRIGGERS
     WHERE TRIGGER_SCHEMA = ? ${table !== undefined ? 'AND EVENT_OBJECT_TABLE = ?' : ''}
     ORDER BY TRIGGER_NAME`,
    table !== undefined ? [db, table] : [db],
  );
  return rows.map((row) =>
    node(
      'trigger',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        table: opt(row, 'tbl'),
        timing: opt(row, 'timing'),
        event: opt(row, 'event'),
        definer: opt(row, 'definer'),
      }),
    ),
  );
}

async function listEvents(
  query: QueryFn,
  db: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT EVENT_NAME AS name, STATUS AS status, EVENT_TYPE AS type, INTERVAL_VALUE AS every,
       INTERVAL_FIELD AS unit, EXECUTE_AT AS execute_at, LAST_EXECUTED AS last_executed,
       EVENT_COMMENT AS comment
     FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`,
    [db],
  );
  return rows.map((row) =>
    node(
      'event',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        status: opt(row, 'status'),
        schedule:
          str(row, 'type') === 'RECURRING'
            ? `EVERY ${str(row, 'every')} ${str(row, 'unit')}`
            : opt(row, 'execute_at') !== undefined
              ? `AT ${str(row, 'execute_at')}`
              : undefined,
        lastExecuted: opt(row, 'last_executed'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listSequences(
  query: QueryFn,
  db: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'SEQUENCE' ORDER BY TABLE_NAME`,
    [db],
  );
  return rows.map((row) =>
    node(
      'sequence',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({ comment: opt(row, 'comment') }),
    ),
  );
}

async function listColumns(
  query: QueryFn,
  db: string,
  table: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS column_default,
       COLUMN_KEY AS column_key, EXTRA AS extra, COLLATION_NAME AS collation, COLUMN_COMMENT AS comment
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [db, table],
  );
  return rows.map((row) =>
    node(
      'column',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        type: str(row, 'type'),
        nullable: str(row, 'nullable') === 'YES' ? 1 : 0,
        default: opt(row, 'column_default') ?? null,
        primaryKey: str(row, 'column_key') === 'PRI' ? 1 : undefined,
        extra: opt(row, 'extra'),
        collation: opt(row, 'collation'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listIndexes(
  query: QueryFn,
  db: string,
  table: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, INDEX_TYPE AS index_type,
       GROUP_CONCAT(COALESCE(COLUMN_NAME, '(expression)') ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS columns,
       MAX(CARDINALITY) AS cardinality, MAX(INDEX_COMMENT) AS comment
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE ORDER BY INDEX_NAME`,
    [db, table],
  );
  return rows.map((row) =>
    node(
      'index',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        unique: num(row, 'non_unique') === 0 ? 1 : 0,
        primary: str(row, 'name') === 'PRIMARY' ? 1 : 0,
        method: opt(row, 'index_type'),
        columns: opt(row, 'columns'),
        cardinality: numberOrNull(row, 'cardinality'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}
