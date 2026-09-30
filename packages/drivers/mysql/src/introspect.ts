import {
  JoineryError,
  atLeast,
  schemaSnapshotSchema,
  type CheckDef,
  type ColumnDef,
  type EngineId,
  type EventDef,
  type ForeignKeyDef,
  type IndexColumn,
  type IndexDef,
  type IntrospectScope,
  type ReferentialAction,
  type RoutineDef,
  type SchemaObjectKind,
  type SchemaSnapshot,
  type SequenceDef,
  type TableDef,
  type TriggerDef,
  type ViewDef,
} from '@joinery/core';
import { byName, num, opt, str, type Row } from '@joinery/driver-sql-base';
import { quoteQualified } from '@joinery/sql-tools';

import {
  normaliseColumnDefault,
  onUpdateOf,
  removeDatabaseQualifier,
  stripDefiner,
} from './dialect';

/**
 * MySQL / MariaDB introspection into a SchemaSnapshot, following the producer conventions in
 * @joinery/core schema.ts: one schema named after the database; COLUMN_TYPE as the data type;
 * defaults normalised to DEFAULT expression text (see normaliseColumnDefault); column charset
 * and collation only when they differ from the table's; unique keys as unique indexes;
 * routines, triggers and events from SHOW CREATE with the DEFINER clause stripped; and no
 * definition qualified with the database's own name.
 *
 * Partitions keep their definition order (RANGE partitions must be listed in order).
 */

export type QueryFn = (sql: string, values?: unknown[]) => Promise<Row[]>;

export interface MysqlIntrospectTarget {
  readonly database: string;
  readonly mariadb: boolean;
  readonly engine: EngineId;
  readonly serverVersion: string;
}

const ACTIONS: ReadonlySet<string> = new Set([
  'NO ACTION',
  'RESTRICT',
  'CASCADE',
  'SET NULL',
  'SET DEFAULT',
]);

function action(value: string): ReferentialAction {
  return ACTIONS.has(value) ? (value as ReferentialAction) : 'NO ACTION';
}

function group(rows: Row[], key = 'tbl'): Map<string, Row[]> {
  const map = new Map<string, Row[]>();
  for (const row of rows) {
    const name = str(row, key);
    const list = map.get(name);
    if (list) list.push(row);
    else map.set(name, [row]);
  }
  return map;
}

/** "row_format=COMPACT stats_persistent=1" → "COMPACT". */
function rowFormatOf(createOptions: string): string | undefined {
  return /\brow_format=(\w+)/i.exec(createOptions)?.[1]?.toUpperCase();
}

/** A partition bound clause from I_S.PARTITIONS. */
export function partitionBound(
  method: string,
  description: string | undefined,
): string | undefined {
  if (description === undefined) return undefined;
  if (method.startsWith('RANGE')) {
    return description === 'MAXVALUE'
      ? 'VALUES LESS THAN MAXVALUE'
      : `VALUES LESS THAN (${description})`;
  }
  if (method.startsWith('LIST')) return `VALUES IN (${description})`;
  return undefined;
}

/** Introspects one database. `query` runs SQL on the caller's connection. */
export async function introspectMysql(
  query: QueryFn,
  target: MysqlIntrospectTarget,
  scope: IntrospectScope,
): Promise<SchemaSnapshot> {
  const { database: db, mariadb } = target;
  const wants = (kind: SchemaObjectKind): boolean => !scope.include || scope.include.includes(kind);
  const clean = (sql: string): string => removeDatabaseQualifier(stripDefiner(sql), db);
  const showCreate = async (kind: string, name: string, column: string): Promise<string> => {
    const [row] = await query(`SHOW CREATE ${kind} ${quoteQualified([db, name], 'mysql')}`);
    return row ? clean(str(row, column)) : '';
  };

  const [schemaRow] = await query(
    `SELECT DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation
     FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
    [db],
  );
  if (!schemaRow) {
    throw new JoineryError({ code: 'NOT_FOUND', message: `Database "${db}" does not exist` });
  }

  // MariaDB 10.10+ lists UCA 14.0 collations without a character set (uca1400_ai_ci for
  // utf8mb4_uca1400_ai_ci), so the join finds nothing; charset names hold no underscore.
  const relationRows = await query(
    `SELECT t.TABLE_NAME AS name, t.TABLE_TYPE AS type, t.ENGINE AS engine,
       t.TABLE_COLLATION AS collation,
       COALESCE(c.CHARACTER_SET_NAME, SUBSTRING_INDEX(t.TABLE_COLLATION, '_', 1)) AS charset,
       t.AUTO_INCREMENT AS auto_increment, t.CREATE_OPTIONS AS create_options, t.TABLE_COMMENT AS comment
     FROM information_schema.TABLES t
     LEFT JOIN information_schema.COLLATIONS c ON c.COLLATION_NAME = t.TABLE_COLLATION
     WHERE t.TABLE_SCHEMA = ?`,
    [db],
  );
  const tableRows = relationRows.filter((r) =>
    ['BASE TABLE', 'SYSTEM VERSIONED'].includes(str(r, 'type')),
  );
  const sequenceNames = relationRows
    .filter((r) => str(r, 'type') === 'SEQUENCE')
    .map((r) => str(r, 'name'));

  const tables: TableDef[] = [];
  const views: ViewDef[] = [];
  const needColumns = wants('table') || wants('view');
  const columnRows = needColumns
    ? await query(
        `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, ORDINAL_POSITION AS ordinal,
           COLUMN_TYPE AS column_type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS column_default,
           EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation,
           COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generation
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
         ORDER BY TABLE_NAME, ORDINAL_POSITION`,
        [db],
      )
    : [];
  const columnsByTable = group(columnRows);

  if (wants('table')) {
    const visibility = mariadb
      ? atLeast(target.serverVersion, '10.6.0')
        ? ', IGNORED AS ignored'
        : ''
      : atLeast(target.serverVersion, '8.0.13')
        ? ', IS_VISIBLE AS visible, EXPRESSION AS expression'
        : '';
    const indexRows = await query(
      `SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq,
         COLUMN_NAME AS column_name, COLLATION AS collation, SUB_PART AS sub_part,
         INDEX_TYPE AS index_type, INDEX_COMMENT AS comment${visibility}
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
      [db],
    );
    const fkRows = await query(
      `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS column_name,
         k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table,
         k.REFERENCED_COLUMN_NAME AS ref_column, r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [db],
    );
    const checkRows = mariadb
      ? await query(
          `SELECT TABLE_NAME AS tbl, CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause
           FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`,
          [db],
        )
      : atLeast(target.serverVersion, '8.0.16')
        ? await query(
            `SELECT tc.TABLE_NAME AS tbl, cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
             FROM information_schema.CHECK_CONSTRAINTS cc
             JOIN information_schema.TABLE_CONSTRAINTS tc
               ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
              AND tc.CONSTRAINT_TYPE = 'CHECK'
             WHERE cc.CONSTRAINT_SCHEMA = ?`,
            [db],
          )
        : [];
    const triggerRows = wants('trigger')
      ? await query(
          `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl, EVENT_MANIPULATION AS event,
             ACTION_TIMING AS timing
           FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`,
          [db],
        )
      : [];
    const partitionRows = await query(
      `SELECT TABLE_NAME AS tbl, PARTITION_NAME AS name, PARTITION_METHOD AS method,
         PARTITION_EXPRESSION AS expression, PARTITION_DESCRIPTION AS description
       FROM information_schema.PARTITIONS
       WHERE TABLE_SCHEMA = ? AND PARTITION_NAME IS NOT NULL
         AND (SUBPARTITION_ORDINAL_POSITION IS NULL OR SUBPARTITION_ORDINAL_POSITION = 1)
       ORDER BY TABLE_NAME, PARTITION_ORDINAL_POSITION`,
      [db],
    );
    const indexesByTable = group(indexRows);
    const fksByTable = group(fkRows);
    const checksByTable = group(checkRows);
    const triggersByTable = group(triggerRows);
    const partitionsByTable = group(partitionRows);
    const triggerDefinitions = new Map<string, string>();
    for (const row of triggerRows) {
      triggerDefinitions.set(
        str(row, 'name'),
        await showCreate('TRIGGER', str(row, 'name'), 'SQL Original Statement'),
      );
    }

    for (const row of tableRows) {
      const name = str(row, 'name');
      const tableCollation = opt(row, 'collation');
      const tableCharset = opt(row, 'charset');
      const table: { -readonly [K in keyof TableDef]: TableDef[K] } = {
        name,
        kind: 'table',
        columns: (columnsByTable.get(name) ?? []).map((column) =>
          columnDef(column, db, mariadb, tableCharset, tableCollation),
        ),
        uniques: [],
        indexes: [],
        foreignKeys: [],
        checks: [],
        triggers: [],
        options: {},
      };
      const options = table.options;
      const engine = opt(row, 'engine');
      if (engine !== undefined) options['engine'] = engine;
      if (tableCharset !== undefined) options['charset'] = tableCharset;
      if (tableCollation !== undefined) options['collation'] = tableCollation;
      const autoIncrement = row['auto_increment'];
      if (autoIncrement !== null && autoIncrement !== undefined)
        options['autoIncrement'] = String(autoIncrement);
      const rowFormat = rowFormatOf(str(row, 'create_options'));
      if (rowFormat !== undefined) options['rowFormat'] = rowFormat;
      const comment = opt(row, 'comment');
      if (comment !== undefined) table.comment = comment;

      const { primaryKey, indexes } = indexDefs(indexesByTable.get(name) ?? []);
      if (primaryKey) table.primaryKey = primaryKey;
      table.indexes = indexes;
      table.columns = await exactBinaryDefaults(query, db, name, table.columns);
      table.foreignKeys = foreignKeyDefs(fksByTable.get(name) ?? [], db);
      table.checks = (checksByTable.get(name) ?? [])
        .map((check): CheckDef => ({
          name: str(check, 'name'),
          expression: removeDatabaseQualifier(str(check, 'clause'), db),
        }))
        .sort(byName);
      table.triggers = (triggersByTable.get(name) ?? [])
        .map((trigger): TriggerDef => ({
          name: str(trigger, 'name'),
          timing: str(trigger, 'timing') === 'BEFORE' ? 'BEFORE' : 'AFTER',
          events: [str(trigger, 'event') as TriggerDef['events'][number]],
          definition: triggerDefinitions.get(str(trigger, 'name')) ?? '',
        }))
        .sort(byName);
      const partitions = partitionsByTable.get(name);
      if (partitions && partitions.length > 0) {
        const method = str(partitions[0]!, 'method');
        table.partitioning = {
          method,
          key: removeDatabaseQualifier(str(partitions[0]!, 'expression'), db),
          partitions: partitions.map((p) => {
            const bound = partitionBound(method, opt(p, 'description'));
            return { name: str(p, 'name'), ...(bound !== undefined ? { bound } : {}) };
          }),
        };
      }
      tables.push(table);
    }
  }

  if (wants('view')) {
    const viewRows = await query(
      `SELECT TABLE_NAME AS name, VIEW_DEFINITION AS definition, CHECK_OPTION AS check_option,
         DEFINER AS definer, SECURITY_TYPE AS security
       FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?`,
      [db],
    );
    for (const row of viewRows) {
      const name = str(row, 'name');
      const create = await showCreate('VIEW', name, 'Create View');
      const algorithm = /\bALGORITHM\s*=\s*(\w+)/i.exec(create)?.[1]?.toUpperCase();
      const options: Record<string, string> = {};
      if (algorithm !== undefined) options['algorithm'] = algorithm;
      const security = opt(row, 'security');
      if (security !== undefined) options['security'] = security;
      const definer = opt(row, 'definer');
      if (definer !== undefined) options['definer'] = definer;
      const view: { -readonly [K in keyof ViewDef]: ViewDef[K] } = {
        name,
        materialized: false,
        definition: removeDatabaseQualifier(str(row, 'definition'), db),
        columns: (columnsByTable.get(name) ?? []).map((c) => str(c, 'name')),
        options,
        indexes: [],
      };
      const checkOption = str(row, 'check_option');
      if (checkOption === 'LOCAL' || checkOption === 'CASCADED') view.checkOption = checkOption;
      views.push(view);
    }
  }

  const routines: RoutineDef[] = [];
  if (wants('routine')) {
    const routineRows = await query(
      `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, DTD_IDENTIFIER AS returns,
         DEFINER AS definer, ROUTINE_COMMENT AS comment
       FROM information_schema.ROUTINES
       WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE IN ('FUNCTION', 'PROCEDURE')`,
      [db],
    );
    for (const row of routineRows) {
      const kind = str(row, 'type') === 'FUNCTION' ? 'function' : 'procedure';
      const name = str(row, 'name');
      const routine: { -readonly [K in keyof RoutineDef]: RoutineDef[K] } = {
        name,
        kind,
        signature: '',
        language: 'SQL',
        definition: await showCreate(
          kind === 'function' ? 'FUNCTION' : 'PROCEDURE',
          name,
          kind === 'function' ? 'Create Function' : 'Create Procedure',
        ),
      };
      const returns = kind === 'function' ? opt(row, 'returns') : undefined;
      if (returns !== undefined) routine.returns = returns;
      const definer = opt(row, 'definer');
      if (definer !== undefined) routine.definer = definer;
      const comment = opt(row, 'comment');
      if (comment !== undefined) routine.comment = comment;
      routines.push(routine);
    }
  }

  const events: EventDef[] = [];
  if (wants('event')) {
    const eventRows = await query(
      `SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`,
      [db],
    );
    for (const row of eventRows) {
      events.push({
        name: str(row, 'name'),
        definition: await showCreate('EVENT', str(row, 'name'), 'Create Event'),
        enabled: str(row, 'status') === 'ENABLED',
      });
    }
  }

  const sequences: SequenceDef[] = [];
  if (wants('sequence') && mariadb) {
    for (const name of sequenceNames) {
      const [row] = await query(
        `SELECT start_value AS start, minimum_value AS min_value, maximum_value AS max_value,
           increment, cache_size AS cache, cycle_option AS cycle
         FROM ${quoteQualified([db, name], 'mariadb')}`,
      );
      if (!row) continue;
      sequences.push({
        name,
        start: str(row, 'start'),
        increment: str(row, 'increment'),
        minValue: str(row, 'min_value'),
        maxValue: str(row, 'max_value'),
        cache: str(row, 'cache'),
        cycle: num(row, 'cycle') === 1,
      });
    }
  }

  const options: Record<string, string> = {};
  const charset = opt(schemaRow, 'charset');
  if (charset !== undefined) options['charset'] = charset;
  const collation = opt(schemaRow, 'collation');
  if (collation !== undefined) options['collation'] = collation;

  return schemaSnapshotSchema.parse({
    engine: target.engine,
    serverVersion: target.serverVersion,
    database: db,
    options,
    schemas: [
      {
        name: db,
        tables: tables.sort(byName),
        views: views.sort(byName),
        routines: routines.sort(byName),
        sequences: sequences.sort(byName),
        types: [],
        events: events.sort(byName),
      },
    ],
    extensions: [],
    capturedAt: new Date().toISOString(),
  });
}

const BINARY_TYPE = /^(?:binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/i;

/**
 * information_schema mangles bytes of a binary column's default that are not valid UTF-8:
 * MariaDB turns them into '?' and MySQL cuts its hex literal short ("0x"); MariaDB 11.8 writes
 * them as x'..' literals. So literal defaults of binary columns are read back exactly with
 * DEFAULT() and written as hex literals. Expression defaults are left alone: DEFAULT() refuses
 * them.
 */
async function exactBinaryDefaults(
  query: QueryFn,
  db: string,
  table: string,
  columns: ColumnDef[],
): Promise<ColumnDef[]> {
  const binary = columns.filter(
    (c) =>
      BINARY_TYPE.test(c.dataType) &&
      c.default !== null &&
      (c.default.startsWith("'") || /^0x/i.test(c.default) || /^x'/i.test(c.default)),
  );
  if (binary.length === 0) return columns;
  const list = binary
    .map((c, i) => `HEX(DEFAULT(t.${quoteQualified([c.name], 'mariadb')})) AS d${i}`)
    .join(', ');
  const [row] = await query(
    `SELECT ${list} FROM (SELECT 1) AS joinery_one LEFT JOIN ${quoteQualified([db, table], 'mariadb')} AS t ON FALSE`,
  );
  if (!row) return columns;
  const exact = new Map(
    binary.map((c, i) => {
      const hex = opt(row, `d${i}`) ?? '';
      return [c, hex === '' ? "''" : `0x${hex}`] as const;
    }),
  );
  return columns.map((c) => {
    const value = exact.get(c);
    return value === undefined ? c : { ...c, default: value };
  });
}

function columnDef(
  row: Row,
  db: string,
  mariadb: boolean,
  tableCharset: string | undefined,
  tableCollation: string | undefined,
): ColumnDef {
  const extra = str(row, 'extra');
  const columnType = str(row, 'column_type');
  const generation = opt(row, 'generation');
  const generatedKind = /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i
    .exec(extra)?.[1]
    ?.toUpperCase();
  const column: { -readonly [K in keyof ColumnDef]: ColumnDef[K] } = {
    name: str(row, 'name'),
    ordinal: num(row, 'ordinal'),
    dataType: columnType,
    nullable: str(row, 'nullable') === 'YES',
    default: null,
    autoIncrement: /\bauto_increment\b/i.test(extra),
  };
  if (generatedKind !== undefined && generation !== undefined) {
    column.generated = {
      expression: removeDatabaseQualifier(
        mariadb ? generation : generation.replace(/\\'/g, "'"),
        db,
      ),
      stored: generatedKind !== 'VIRTUAL',
    };
  } else {
    const rawDefault = row['column_default'];
    const normalised = normaliseColumnDefault(
      typeof rawDefault === 'string'
        ? rawDefault
        : rawDefault === null || rawDefault === undefined
          ? null
          : String(rawDefault),
      extra,
      columnType,
      mariadb,
    );
    // MariaDB qualifies sequences in defaults: DEFAULT nextval(`db`.`seq`).
    column.default = normalised === null ? null : removeDatabaseQualifier(normalised, db);
  }
  const onUpdate = onUpdateOf(extra);
  if (onUpdate !== undefined) column.onUpdate = onUpdate;
  const charset = opt(row, 'charset');
  const collation = opt(row, 'collation');
  if (charset !== undefined && charset !== tableCharset) {
    column.charset = charset;
    if (collation !== undefined) column.collation = collation;
  } else if (collation !== undefined && collation !== tableCollation) {
    column.collation = collation;
  }
  const comment = opt(row, 'comment');
  if (comment !== undefined) column.comment = comment;
  return column;
}

function indexDefs(rows: Row[]): { primaryKey?: TableDef['primaryKey']; indexes: IndexDef[] } {
  const byIndex = group(rows, 'name');
  let primaryKey: TableDef['primaryKey'];
  const indexes: IndexDef[] = [];
  for (const [name, parts] of byIndex) {
    parts.sort((a, b) => num(a, 'seq') - num(b, 'seq'));
    if (name === 'PRIMARY') {
      primaryKey = { name, columns: parts.map((p) => str(p, 'column_name')) };
      continue;
    }
    // MariaDB reports SUB_PART 32 for SPATIAL keys, which take no prefix length.
    const spatial = str(parts[0]!, 'index_type').toUpperCase() === 'SPATIAL';
    const columns = parts.map((part): IndexColumn => {
      const columnName = opt(part, 'column_name');
      const expression = opt(part, 'expression');
      const column: { -readonly [K in keyof IndexColumn]: IndexColumn[K] } = {
        name: columnName ?? null,
        order: str(part, 'collation') === 'D' ? 'desc' : 'asc',
      };
      if (columnName === undefined && expression !== undefined) column.expression = expression;
      const subPart = part['sub_part'];
      if (subPart !== null && subPart !== undefined && !spatial) column.length = Number(subPart);
      return column;
    });
    const first = parts[0]!;
    const index: { -readonly [K in keyof IndexDef]: IndexDef[K] } = {
      name,
      columns,
      unique: num(first, 'non_unique') === 0,
      method: str(first, 'index_type').toLowerCase(),
      include: [],
      invisible: str(first, 'visible') === 'NO' || str(first, 'ignored') === 'YES',
    };
    const comment = opt(first, 'comment');
    if (comment !== undefined) index.comment = comment;
    indexes.push(index);
  }
  return { ...(primaryKey ? { primaryKey } : {}), indexes: indexes.sort(byName) };
}

function foreignKeyDefs(rows: Row[], db: string): ForeignKeyDef[] {
  const keys: ForeignKeyDef[] = [];
  for (const [name, parts] of group(rows, 'name')) {
    const first = parts[0]!;
    const refSchema = str(first, 'ref_schema');
    keys.push({
      name,
      columns: parts.map((p) => str(p, 'column_name')),
      ...(refSchema !== db && refSchema !== '' ? { refSchema } : {}),
      refTable: str(first, 'ref_table'),
      refColumns: parts.map((p) => str(p, 'ref_column')),
      onUpdate: action(str(first, 'on_update')),
      onDelete: action(str(first, 'on_delete')),
    });
  }
  return keys.sort(byName);
}
