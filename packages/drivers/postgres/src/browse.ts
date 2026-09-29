import { JoineryError, type BrowseNode, type BrowseNodeKind } from '@joinery/core';
import { bool, num, opt, str } from '@joinery/driver-sql-base';

import type { QueryFn } from './introspect';

/**
 * The PostgreSQL object explorer tree (spec §5), loaded one level at a time:
 *
 *     database / schema / folder / object / (columns | indexes | triggers) / item
 *
 * Folder segments are stable ids ("tables", "materialized-views"...); their display name is in
 * `name`. Functions and procedures are named with their argument types, since overloads share
 * a name. Only the connected database can be expanded: another one needs a new session.
 * Sizes and row counts come from catalog statistics (reltuples, relpages), so listing a folder
 * never takes locks or scans tables.
 */

export const PG_FOLDERS = [
  ['tables', 'Tables'],
  ['partitions', 'Partitions'],
  ['views', 'Views'],
  ['materialized-views', 'Materialized Views'],
  ['foreign-tables', 'Foreign Tables'],
  ['functions', 'Functions'],
  ['procedures', 'Procedures'],
  ['sequences', 'Sequences'],
  ['types', 'Types'],
  ['extensions', 'Extensions'],
] as const;

const RELATION_FOLDERS: Readonly<
  Record<
    string,
    {
      relkinds: string;
      partitions: boolean | null;
      kind: BrowseNodeKind;
      subfolders: readonly string[];
    }
  >
> = {
  tables: {
    relkinds: `'r','p'`,
    partitions: false,
    kind: 'table',
    subfolders: ['columns', 'indexes', 'triggers'],
  },
  partitions: {
    relkinds: `'r','p'`,
    partitions: true,
    kind: 'partition',
    subfolders: ['columns', 'indexes', 'triggers'],
  },
  views: { relkinds: `'v'`, partitions: null, kind: 'view', subfolders: ['columns', 'triggers'] },
  'materialized-views': {
    relkinds: `'m'`,
    partitions: null,
    kind: 'materialized-view',
    subfolders: ['columns', 'indexes'],
  },
  'foreign-tables': {
    relkinds: `'f'`,
    partitions: null,
    kind: 'foreign-table',
    subfolders: ['columns', 'triggers'],
  },
};

const SUBFOLDER_NAMES: Readonly<Record<string, string>> = {
  columns: 'Columns',
  indexes: 'Indexes',
  triggers: 'Triggers',
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

function notFound(path: readonly string[]): JoineryError {
  return new JoineryError({
    code: 'NOT_FOUND',
    message: `Nothing to browse at ${path.join(' / ')}`,
  });
}

async function relationOid(query: QueryFn, schema: string, name: string): Promise<number> {
  const rows = await query(
    `SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  if (rows.length === 0) throw notFound([schema, name]);
  return num(rows[0]!, 'oid');
}

/** Children of `path` in the PostgreSQL tree; `[]` lists databases. */
export async function browsePostgres(
  query: QueryFn,
  currentDatabase: string,
  path: readonly string[],
): Promise<BrowseNode[]> {
  if (path.length === 0) {
    const rows = await query(
      `SELECT d.datname AS name, pg_catalog.pg_get_userbyid(d.datdba) AS owner,
         pg_catalog.pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation,
         pg_catalog.shobj_description(d.oid, 'pg_database') AS comment
       FROM pg_catalog.pg_database d WHERE NOT d.datistemplate AND d.datallowconn ORDER BY d.datname`,
    );
    return rows.map((row) =>
      node(
        'database',
        str(row, 'name'),
        [str(row, 'name')],
        true,
        detail({
          owner: opt(row, 'owner'),
          encoding: opt(row, 'encoding'),
          collation: opt(row, 'collation'),
          comment: opt(row, 'comment'),
          current: str(row, 'name') === currentDatabase ? 1 : 0,
        }),
      ),
    );
  }

  const [database, schema, folder, object, subfolder] = path;
  if (database !== currentDatabase) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `This session is connected to "${currentDatabase}"; open a connection to "${database}" to browse it`,
    });
  }

  if (path.length === 1) {
    const rows = await query(
      `SELECT n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
         pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment,
         (n.nspname IN ('pg_catalog', 'information_schema')) AS system
       FROM pg_catalog.pg_namespace n
       WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
       ORDER BY (n.nspname IN ('pg_catalog', 'information_schema')), n.nspname`,
    );
    return rows.map((row) =>
      node(
        'schema',
        str(row, 'name'),
        [database, str(row, 'name')],
        true,
        detail({
          owner: opt(row, 'owner'),
          comment: opt(row, 'comment'),
          system: bool(row, 'system') ? 1 : 0,
        }),
      ),
    );
  }

  if (path.length === 2) {
    return PG_FOLDERS.map(([id, name]) => node('folder', name, [database, schema!, id], true));
  }

  const relationFolder = RELATION_FOLDERS[folder!];
  if (path.length === 3) {
    if (relationFolder) return listRelations(query, path, relationFolder);
    switch (folder) {
      case 'functions':
      case 'procedures':
        return listRoutines(query, path, folder === 'procedures');
      case 'sequences':
        return listSequences(query, path);
      case 'types':
        return listTypes(query, path);
      case 'extensions':
        return listExtensions(query, path);
      default:
        throw notFound(path);
    }
  }

  if (!relationFolder) throw notFound(path);
  if (path.length === 4) {
    return relationFolder.subfolders.map((id) =>
      node('folder', SUBFOLDER_NAMES[id] ?? id, [...path, id], true),
    );
  }
  if (path.length === 5) {
    const oid = await relationOid(query, schema!, object!);
    switch (subfolder) {
      case 'columns':
        return listColumns(query, path, oid);
      case 'indexes':
        return listIndexes(query, path, oid);
      case 'triggers':
        return listTriggers(query, path, oid);
      default:
        throw notFound(path);
    }
  }
  return [];
}

async function listRelations(
  query: QueryFn,
  path: readonly string[],
  folder: (typeof RELATION_FOLDERS)[string],
): Promise<BrowseNode[]> {
  const partitionFilter =
    folder.partitions === null
      ? ''
      : folder.partitions
        ? 'AND c.relispartition'
        : 'AND NOT c.relispartition';
  const rows = await query(
    `SELECT c.relname AS name, c.relkind::text AS relkind,
       CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint END AS rows,
       c.relpages::bigint * current_setting('block_size')::bigint AS data_size,
       (SELECT COALESCE(sum(ic.relpages), 0)::bigint * current_setting('block_size')::bigint
          FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
         WHERE i.indrelid = c.oid) AS index_size,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner,
       pg_catalog.obj_description(c.oid, 'pg_class') AS comment,
       CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END AS bound,
       (SELECT p.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
         WHERE i.inhrelid = c.oid AND c.relispartition LIMIT 1) AS parent
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN (${folder.relkinds}) ${partitionFilter}
     ORDER BY c.relname`,
    [path[1]],
  );
  return rows.map((row) => {
    const isView = folder.kind === 'view' || folder.kind === 'foreign-table';
    return node(
      folder.kind,
      str(row, 'name'),
      [...path, str(row, 'name')],
      true,
      detail({
        rows: isView ? undefined : row['rows'] === null ? null : num(row, 'rows'),
        dataSize: isView ? undefined : num(row, 'data_size'),
        indexSize: isView ? undefined : num(row, 'index_size'),
        partitioned: str(row, 'relkind') === 'p' ? 1 : undefined,
        parent: opt(row, 'parent'),
        bound: opt(row, 'bound'),
        owner: opt(row, 'owner'),
        comment: opt(row, 'comment'),
      }),
    );
  });
}

async function listRoutines(
  query: QueryFn,
  path: readonly string[],
  procedures: boolean,
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT p.proname AS name, pg_catalog.oidvectortypes(p.proargtypes) AS args,
       CASE WHEN p.prokind <> 'p' THEN pg_catalog.pg_get_function_result(p.oid) END AS returns,
       l.lanname AS language, p.prokind::text AS kind,
       pg_catalog.pg_get_userbyid(p.proowner) AS owner, pg_catalog.obj_description(p.oid, 'pg_proc') AS comment
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE n.nspname = $1 AND (p.prokind = 'p') = $2
     ORDER BY p.proname, 2`,
    [path[1], procedures],
  );
  return rows.map((row) => {
    const name = `${str(row, 'name')}(${str(row, 'args')})`;
    return node(
      procedures ? 'procedure' : 'function',
      name,
      [...path, name],
      false,
      detail({
        returns: opt(row, 'returns'),
        language: opt(row, 'language'),
        aggregate: str(row, 'kind') === 'a' ? 1 : undefined,
        owner: opt(row, 'owner'),
        comment: opt(row, 'comment'),
      }),
    );
  });
}

async function listSequences(query: QueryFn, path: readonly string[]): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT c.relname AS name, pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
       s.seqstart::text AS start, s.seqincrement::text AS increment,
       pg_catalog.pg_get_userbyid(c.relowner) AS owner, pg_catalog.obj_description(c.oid, 'pg_class') AS comment
     FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 ORDER BY c.relname`,
    [path[1]],
  );
  return rows.map((row) =>
    node(
      'sequence',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        dataType: opt(row, 'data_type'),
        start: opt(row, 'start'),
        increment: opt(row, 'increment'),
        owner: opt(row, 'owner'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listTypes(query: QueryFn, path: readonly string[]): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT t.typname AS name,
       CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' WHEN 'r' THEN 'range'
                      WHEN 'c' THEN 'composite' ELSE 'base' END AS type_kind,
       pg_catalog.pg_get_userbyid(t.typowner) AS owner, pg_catalog.obj_description(t.oid, 'pg_type') AS comment
     FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1
       AND (t.typtype IN ('e', 'd', 'r')
            OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid) = 'c')
            OR (t.typtype = 'b' AND t.typcategory <> 'A' AND n.nspname NOT IN ('pg_catalog', 'information_schema')))
     ORDER BY t.typname`,
    [path[1]],
  );
  return rows.map((row) =>
    node(
      'type',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        type: opt(row, 'type_kind'),
        owner: opt(row, 'owner'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listExtensions(query: QueryFn, path: readonly string[]): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT e.extname AS name, e.extversion AS version,
       pg_catalog.obj_description(e.oid, 'pg_extension') AS comment
     FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
     WHERE n.nspname = $1 ORDER BY e.extname`,
    [path[1]],
  );
  return rows.map((row) =>
    node(
      'extension',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        version: opt(row, 'version'),
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listColumns(
  query: QueryFn,
  path: readonly string[],
  oid: number,
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type,
       a.attnotnull AS notnull, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
       a.attidentity::text AS identity, a.attgenerated::text AS generated,
       pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
       EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
               WHERE con.conrelid = a.attrelid AND con.contype = 'p' AND a.attnum = ANY(con.conkey)) AS primary_key
     FROM pg_catalog.pg_attribute a
     LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [oid],
  );
  return rows.map((row) =>
    node(
      'column',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        type: str(row, 'type'),
        nullable: bool(row, 'notnull') ? 0 : 1,
        default: opt(row, 'default_expr') ?? null,
        identity:
          opt(row, 'identity') === 'a'
            ? 'always'
            : opt(row, 'identity') === 'd'
              ? 'by default'
              : undefined,
        generated: opt(row, 'generated') !== undefined ? 'stored' : undefined,
        primaryKey: bool(row, 'primary_key') ? 1 : undefined,
        comment: opt(row, 'comment'),
      }),
    ),
  );
}

async function listIndexes(
  query: QueryFn,
  path: readonly string[],
  oid: number,
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT ic.relname AS name, i.indisunique AS is_unique, i.indisprimary AS is_primary, am.amname AS method,
       pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
       ic.relpages::bigint * current_setting('block_size')::bigint AS size
     FROM pg_catalog.pg_index i
     JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
     JOIN pg_catalog.pg_am am ON am.oid = ic.relam
     WHERE i.indrelid = $1 ORDER BY ic.relname`,
    [oid],
  );
  return rows.map((row) =>
    node(
      'index',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        unique: bool(row, 'is_unique') ? 1 : 0,
        primary: bool(row, 'is_primary') ? 1 : 0,
        method: opt(row, 'method'),
        size: num(row, 'size'),
        definition: opt(row, 'definition'),
      }),
    ),
  );
}

async function listTriggers(
  query: QueryFn,
  path: readonly string[],
  oid: number,
): Promise<BrowseNode[]> {
  const rows = await query(
    `SELECT t.tgname AS name, t.tgenabled::text AS enabled, pg_catalog.pg_get_triggerdef(t.oid) AS definition
     FROM pg_catalog.pg_trigger t WHERE t.tgrelid = $1 AND NOT t.tgisinternal ORDER BY t.tgname`,
    [oid],
  );
  return rows.map((row) =>
    node(
      'trigger',
      str(row, 'name'),
      [...path, str(row, 'name')],
      false,
      detail({
        enabled: str(row, 'enabled') === 'D' ? 0 : 1,
        definition: opt(row, 'definition'),
      }),
    ),
  );
}
