import { atLeast } from '@querybara/core';
import type { ColumnDef, SqlEngineId, TableDef } from '@querybara/core';

import { maxIdentifierLength } from './names';
import { renameIdentifiers } from './prepare';

/**
 * Starting points for the designer: a new table, a new column row, a duplicate of an existing
 * table, and the table options each engine offers (spec §8: options tab — engine, charset,
 * collation, tablespace...).
 */

/**
 * A new, empty table: no columns yet, MySQL/MariaDB on InnoDB with the database's charset and
 * collation when given (the designer fills them in from the snapshot otherwise).
 */
export function emptyTable(
  engine: SqlEngineId,
  name: string,
  defaults: { readonly charset?: string; readonly collation?: string } = {},
): TableDef {
  const options: Record<string, string> =
    engine === 'postgres'
      ? {}
      : {
          engine: 'InnoDB',
          ...(defaults.charset !== undefined ? { charset: defaults.charset } : {}),
          ...(defaults.collation !== undefined ? { collation: defaults.collation } : {}),
        };
  return {
    name,
    kind: 'table',
    columns: [],
    uniques: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    triggers: [],
    options,
  };
}

/**
 * A column row to append: a nullable text column with a name not yet used in the table
 * ("column1", "column2", ...), positioned last.
 */
export function newColumn(engine: SqlEngineId, table: TableDef, name?: string): ColumnDef {
  const taken = new Set(table.columns.map((c) => c.name.toLowerCase()));
  let chosen = name;
  for (
    let n = table.columns.length + 1;
    chosen === undefined || taken.has(chosen.toLowerCase());
    n++
  ) {
    chosen = `column${n}`;
  }
  return {
    name: chosen,
    ordinal: table.columns.length + 1,
    dataType: engine === 'postgres' ? 'character varying(255)' : 'varchar(255)',
    nullable: true,
    default: null,
    autoIncrement: false,
  };
}

function derivedName(name: string, from: string, to: string, engine: SqlEngineId): string {
  const index = name.indexOf(from);
  const renamed =
    index !== -1
      ? `${name.slice(0, index)}${to}${name.slice(index + from.length)}`
      : `${to}_${name}`;
  return renamed.slice(0, maxIdentifierLength(engine));
}

/**
 * A copy of a table under a new name, for "Duplicate table" (default `<name>_copy`). Names the
 * engine requires to be unique beyond the table are derived from the new table name:
 * PostgreSQL primary key, unique constraint, index and partition names (they are relations),
 * MySQL/MariaDB foreign key, check (MySQL) and trigger names (unique per database). Trigger
 * definitions follow the new name; PostgreSQL serial defaults become serial types so the copy
 * gets its own sequence; the MySQL AUTO_INCREMENT counter is not copied.
 */
export function cloneTable(
  table: TableDef,
  engine: SqlEngineId,
  name = `${table.name}_copy`,
): TableDef {
  const copy = structuredClone(table);
  const pg = engine === 'postgres';
  const derive = (n: string): string => derivedName(n, table.name, name, engine);
  const renames = new Map<string, string>([[table.name, name]]);
  const columns = copy.columns.map((c): ColumnDef => {
    const serial = pg && c.default !== null && /^nextval\(/i.test(c.default.trim());
    if (!serial) return c;
    const base = c.dataType.trim().toLowerCase();
    const type = base === 'bigint' ? 'bigserial' : base === 'smallint' ? 'smallserial' : 'serial';
    return { ...c, dataType: type, default: null };
  });
  const options = { ...copy.options };
  delete options.autoIncrement;
  const triggers = copy.triggers.map((t) => {
    const newName = pg ? t.name : derive(t.name);
    const map = new Map(renames);
    if (newName !== t.name) map.set(t.name, newName);
    return { ...t, name: newName, definition: renameIdentifiers(t.definition, engine, map) };
  });
  const result: TableDef = {
    ...copy,
    name,
    columns,
    ...(copy.primaryKey !== undefined
      ? {
          primaryKey: {
            ...copy.primaryKey,
            name: pg ? derive(copy.primaryKey.name) : copy.primaryKey.name,
          },
        }
      : {}),
    uniques: copy.uniques.map((u) => ({ ...u, name: pg ? derive(u.name) : u.name })),
    // PostgreSQL definitions name the old table and index: the copy renders from structure.
    indexes: copy.indexes.map(({ definition: _definition, ...rest }) => ({
      ...rest,
      name: pg ? derive(rest.name) : rest.name,
    })),
    foreignKeys: copy.foreignKeys.map((fk) => ({
      ...fk,
      name: pg ? fk.name : derive(fk.name),
      ...(fk.refSchema === undefined && fk.refTable === table.name ? { refTable: name } : {}),
    })),
    checks: copy.checks.map((c) => ({
      ...c,
      name: engine === 'mysql' ? derive(c.name) : c.name,
    })),
    triggers,
    options,
    ...(copy.partitioning !== undefined
      ? {
          partitioning: {
            ...copy.partitioning,
            partitions: copy.partitioning.partitions.map((pt) => ({
              ...pt,
              name: pg ? derive(pt.name) : pt.name,
            })),
          },
        }
      : {}),
  };
  delete (result as { owner?: string }).owner;
  return result;
}

/** One option of the options tab. `key` is the `TableDef.options` key. */
export interface TableOptionInfo {
  readonly key: string;
  readonly label: string;
  readonly kind: 'choice' | 'text' | 'integer' | 'number' | 'boolean';
  /** Suggested values for choices (the server may accept others). */
  readonly values?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly description: string;
}

/**
 * The table options the designer edits for an engine and version. The table comment is
 * `TableDef.comment`, edited on its own tab, and not listed here.
 */
export function tableOptionCatalog(engine: SqlEngineId, serverVersion?: string): TableOptionInfo[] {
  if (engine === 'postgres') {
    return [
      {
        key: 'tablespace',
        label: 'Tablespace',
        kind: 'text',
        description: 'Where the table is stored; empty for the database default',
      },
      {
        key: 'fillfactor',
        label: 'Fill factor',
        kind: 'integer',
        min: 10,
        max: 100,
        description: 'Percentage of each page filled by inserts (100 = full)',
      },
      {
        key: 'autovacuum_enabled',
        label: 'Autovacuum',
        kind: 'boolean',
        description: 'Let autovacuum process the table',
      },
      {
        key: 'parallel_workers',
        label: 'Parallel workers',
        kind: 'integer',
        min: 0,
        max: 1024,
        description: 'Workers for parallel scans of the table',
      },
      {
        key: 'toast_tuple_target',
        label: 'TOAST tuple target',
        kind: 'integer',
        min: 128,
        max: 8160,
        description: 'Row size (bytes) above which values are moved to TOAST',
      },
      {
        key: 'autovacuum_vacuum_scale_factor',
        label: 'Vacuum scale factor',
        kind: 'number',
        min: 0,
        max: 100,
        description: 'Fraction of the table changed before autovacuum runs',
      },
      {
        key: 'autovacuum_analyze_scale_factor',
        label: 'Analyze scale factor',
        kind: 'number',
        min: 0,
        max: 100,
        description: 'Fraction of the table changed before autoanalyze runs',
      },
    ];
  }
  const mariadb = engine === 'mariadb';
  const engines = mariadb
    ? ['InnoDB', 'Aria', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE', 'BLACKHOLE']
    : ['InnoDB', 'MyISAM', 'MEMORY', 'CSV', 'ARCHIVE', 'BLACKHOLE'];
  const rowFormats = [
    'DEFAULT',
    'DYNAMIC',
    'COMPACT',
    'REDUNDANT',
    'COMPRESSED',
    ...(mariadb ? ['PAGE', 'FIXED'] : []),
  ];
  const charsets = [
    'utf8mb4',
    'utf8mb3',
    'latin1',
    'ascii',
    'binary',
    'utf16',
    'utf32',
    'ucs2',
    'cp1250',
    'cp1251',
    'gbk',
    'big5',
    'sjis',
  ];
  const utf8mb4Default = mariadb
    ? serverVersion === undefined || atLeast(serverVersion, '11.4.5')
      ? 'utf8mb4_uca1400_ai_ci'
      : 'utf8mb4_general_ci'
    : serverVersion === undefined || atLeast(serverVersion, '8.0')
      ? 'utf8mb4_0900_ai_ci'
      : 'utf8mb4_general_ci';
  return [
    {
      key: 'engine',
      label: 'Engine',
      kind: 'choice',
      values: engines,
      description: 'Storage engine; InnoDB is the only transactional one with foreign keys',
    },
    {
      key: 'charset',
      label: 'Character set',
      kind: 'choice',
      values: charsets,
      description: 'Default character set of text columns',
    },
    {
      key: 'collation',
      label: 'Collation',
      kind: 'text',
      values: [utf8mb4Default, 'utf8mb4_bin', 'utf8mb4_unicode_ci', 'latin1_swedish_ci'],
      description: 'Default collation of text columns; must belong to the character set',
    },
    {
      key: 'rowFormat',
      label: 'Row format',
      kind: 'choice',
      values: rowFormats,
      description: 'Physical row format',
    },
    {
      key: 'autoIncrement',
      label: 'Auto increment',
      kind: 'integer',
      min: 1,
      description: 'Next AUTO_INCREMENT value (cannot go below the highest existing value + 1)',
    },
  ];
}
