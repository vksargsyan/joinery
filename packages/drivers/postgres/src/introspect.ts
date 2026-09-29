import {
  schemaSnapshotSchema,
  type CheckDef,
  type ColumnDef,
  type ForeignKeyDef,
  type IndexColumn,
  type IndexDef,
  type IntrospectScope,
  type KeyDef,
  type ReferentialAction,
  type RoutineDef,
  type SchemaObjectKind,
  type SchemaSnapshot,
  type SequenceDef,
  type TableDef,
  type TriggerDef,
  type TypeDef,
  type ViewDef,
} from '@joinery/core';
import { bool, byName, json, num, opt, str, type Row } from '@joinery/driver-sql-base';
import { quoteIdent, quoteQualified, quoteString } from '@joinery/sql-tools';

/**
 * PostgreSQL introspection into a SchemaSnapshot, following the producer conventions in
 * @joinery/core schema.ts. The caller runs it in one snapshot with an empty search_path, so
 * everything PostgreSQL prints (defaults, view bodies, trigger and index definitions, type
 * names) is schema-qualified and does not depend on the session.
 *
 * - Extension-owned objects, system schemas and internal triggers are skipped.
 * - Partitions are not listed as tables: their parent's `partitioning.partitions` names them
 *   with their bounds (sub-partitioning is not represented).
 * - Constraints cloned onto partitions (conparentid) and inherited ones are skipped.
 * - PostgreSQL 18 NOT NULL constraints (contype 'n') are skipped; NOT NULL is `nullable`.
 * - Exclusion constraints and view triggers have no place in the snapshot and are omitted.
 */

export type QueryFn = (text: string, values?: unknown[]) => Promise<Row[]>;

const notExtensionMember = (catalog: string, oid: string): string =>
  `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep WHERE dep.classid = '${catalog}'::regclass AND dep.objid = ${oid} AND dep.deptype = 'e')`;

const DATABASE_SQL = `SELECT pg_catalog.current_database() AS name,
  pg_catalog.pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collation, d.datctype AS ctype
FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()`;

const SCHEMAS_SQL = `SELECT n.oid, n.nspname AS name, pg_catalog.pg_get_userbyid(n.nspowner) AS owner,
  pg_catalog.obj_description(n.oid, 'pg_namespace') AS comment
FROM pg_catalog.pg_namespace n
WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
  AND ${notExtensionMember('pg_namespace', 'n.oid')}
  AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
ORDER BY n.nspname`;

const RELATIONS_SQL = `SELECT c.oid, c.relnamespace AS nsp, c.relname AS name, c.relkind::text AS kind,
  c.relispartition AS is_partition, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
  pg_catalog.obj_description(c.oid, 'pg_class') AS comment, ts.spcname AS tablespace,
  pg_catalog.to_json(c.reloptions)::text AS reloptions,
  CASE WHEN c.relkind = 'p' THEN pg_catalog.pg_get_partkeydef(c.oid) END AS partkey,
  CASE WHEN c.relispartition THEN pg_catalog.pg_get_expr(c.relpartbound, c.oid) END AS partbound,
  (SELECT i.inhparent FROM pg_catalog.pg_inherits i WHERE i.inhrelid = c.oid AND c.relispartition LIMIT 1) AS parent,
  CASE WHEN c.relkind IN ('v', 'm') THEN pg_catalog.pg_get_viewdef(c.oid) END AS viewdef
FROM pg_catalog.pg_class c
LEFT JOIN pg_catalog.pg_tablespace ts ON ts.oid = c.reltablespace
WHERE c.relnamespace = ANY($1::oid[]) AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
  AND ${notExtensionMember('pg_class', 'c.oid')}
ORDER BY c.relname`;

const COLUMNS_SQL = `SELECT a.attrelid AS rel, a.attnum, a.attname AS name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
  a.attidentity::text AS identity, a.attgenerated::text AS generated,
  pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr,
  CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN co.collname END AS collation,
  pg_catalog.col_description(a.attrelid, a.attnum) AS comment,
  (SELECT pg_catalog.json_build_object('start', s.seqstart::text, 'increment', s.seqincrement::text)
     FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_sequence s ON s.seqrelid = d.objid
    WHERE a.attidentity <> '' AND d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid = a.attrelid AND d.refobjsubid = a.attnum AND d.deptype = 'i' LIMIT 1)::text AS identity_seq
FROM pg_catalog.pg_attribute a
JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
WHERE c.relnamespace = ANY($1::oid[]) AND c.relkind IN ('r', 'p', 'f', 'v', 'm')
  AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attrelid, a.attnum`;

const CONSTRAINTS_SQL = `SELECT con.conrelid AS rel, con.conname AS name, con.contype::text AS type,
  pg_catalog.to_json(ARRAY(SELECT a.attname FROM pg_catalog.unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord))::text AS columns,
  fc.relnamespace AS ref_nsp, fn.nspname AS ref_schema, fc.relname AS ref_table,
  pg_catalog.to_json(ARRAY(SELECT a.attname FROM pg_catalog.unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord))::text AS ref_columns,
  con.confupdtype::text AS on_update, con.confdeltype::text AS on_delete, con.confmatchtype::text AS match,
  con.condeferrable AS deferrable, con.condeferred AS deferred,
  pg_catalog.pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
LEFT JOIN pg_catalog.pg_class fc ON fc.oid = con.confrelid
LEFT JOIN pg_catalog.pg_namespace fn ON fn.oid = fc.relnamespace
WHERE c.relnamespace = ANY($1::oid[]) AND con.contype IN ('p', 'u', 'f', 'c')
  AND con.conparentid = 0 AND con.conislocal
ORDER BY con.conrelid, con.conname`;

const INDEXES_SQL = `SELECT i.indrelid AS rel, ic.relname AS name, i.indisunique AS is_unique, am.amname AS method,
  pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
  pg_catalog.pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indnkeyatts AS nkey,
  pg_catalog.obj_description(i.indexrelid, 'pg_class') AS comment,
  pg_catalog.to_json(ARRAY(
    SELECT pg_catalog.json_build_object(
      'attname', att.attname,
      'expr', CASE WHEN i.indkey[k - 1] = 0 THEN pg_catalog.pg_get_indexdef(i.indexrelid, k, true) END,
      'option', i.indoption[k - 1],
      'collation', CASE WHEN i.indcollation[k - 1] <> 0
                         AND i.indcollation[k - 1] <> COALESCE(att.attcollation, 100)
                        THEN (SELECT co.collname FROM pg_catalog.pg_collation co WHERE co.oid = i.indcollation[k - 1]) END,
      'opclass', CASE WHEN k <= i.indnkeyatts AND NOT opc.opcdefault THEN opc.opcname END)
    FROM pg_catalog.generate_series(1, i.indnatts) k
    LEFT JOIN pg_catalog.pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = i.indkey[k - 1] AND i.indkey[k - 1] <> 0
    LEFT JOIN pg_catalog.pg_opclass opc ON opc.oid = i.indclass[k - 1]
    ORDER BY k))::text AS parts
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
JOIN pg_catalog.pg_am am ON am.oid = ic.relam
WHERE c.relnamespace = ANY($1::oid[]) AND c.relkind IN ('r', 'p', 'm')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint con
                  WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype IN ('p', 'u', 'x'))
ORDER BY i.indrelid, ic.relname`;

const TRIGGERS_SQL = `SELECT t.tgrelid AS rel, t.tgname AS name, t.tgtype AS type,
  pg_catalog.pg_get_triggerdef(t.oid) AS definition
FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
WHERE c.relnamespace = ANY($1::oid[]) AND NOT t.tgisinternal AND t.tgparentid = 0
ORDER BY t.tgrelid, t.tgname`;

const ROUTINES_SQL = `SELECT p.oid, p.pronamespace AS nsp, n.nspname AS schema, p.proname AS name, p.prokind::text AS kind,
  pg_catalog.oidvectortypes(p.proargtypes) AS signature,
  CASE WHEN p.prokind <> 'p' THEN pg_catalog.pg_get_function_result(p.oid) END AS returns,
  l.lanname AS language, pg_catalog.pg_get_userbyid(p.proowner) AS owner,
  pg_catalog.obj_description(p.oid, 'pg_proc') AS comment,
  CASE WHEN p.prokind <> 'a' THEN pg_catalog.pg_get_functiondef(p.oid) END AS definition,
  CASE WHEN p.prokind = 'a' THEN (
    SELECT pg_catalog.json_build_object(
      'sfunc', a.aggtransfn::regproc::text,
      'stype', pg_catalog.format_type(a.aggtranstype, NULL),
      'finalfunc', CASE WHEN a.aggfinalfn <> 0 THEN a.aggfinalfn::regproc::text END,
      'combinefunc', CASE WHEN a.aggcombinefn <> 0 THEN a.aggcombinefn::regproc::text END,
      'initcond', a.agginitval)
    FROM pg_catalog.pg_aggregate a WHERE a.aggfnoid = p.oid)::text END AS aggregate
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
WHERE p.pronamespace = ANY($1::oid[]) AND ${notExtensionMember('pg_proc', 'p.oid')}
  -- range and multirange constructors belong to their type
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend dep
                  WHERE dep.classid = 'pg_proc'::regclass AND dep.objid = p.oid AND dep.deptype = 'i')
ORDER BY p.proname, 6`;

const SEQUENCES_SQL = `SELECT c.relnamespace AS nsp, c.relname AS name,
  pg_catalog.format_type(s.seqtypid, NULL) AS data_type, s.seqstart::text AS start,
  s.seqincrement::text AS increment, s.seqmin::text AS min_value, s.seqmax::text AS max_value,
  s.seqcache::text AS cache, s.seqcycle AS cycle, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
  (SELECT pg_catalog.json_build_object('deptype', d.deptype::text, 'nsp', tc.relnamespace,
            'schema', tn.nspname, 'table', tc.relname, 'column', a.attname)
     FROM pg_catalog.pg_depend d
     JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid
     JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass
      AND d.deptype IN ('a', 'i') AND d.refobjsubid > 0 LIMIT 1)::text AS owned
FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid = s.seqrelid
WHERE c.relnamespace = ANY($1::oid[]) AND ${notExtensionMember('pg_class', 'c.oid')}
ORDER BY c.relname`;

const TYPES_SQL = `SELECT t.typnamespace AS nsp, n.nspname AS schema, t.typname AS name, t.typtype::text AS type,
  pg_catalog.pg_get_userbyid(t.typowner) AS owner, pg_catalog.obj_description(t.oid, 'pg_type') AS comment,
  CASE WHEN t.typtype = 'e' THEN (SELECT pg_catalog.to_json(pg_catalog.array_agg(e.enumlabel ORDER BY e.enumsortorder))
                                    FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid)::text END AS labels,
  CASE WHEN t.typtype = 'c' THEN (
    SELECT pg_catalog.to_json(pg_catalog.array_agg(pg_catalog.json_build_object(
             'name', a.attname, 'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
             'collation', CASE WHEN a.attcollation <> 0 AND a.attcollation <> at.typcollation THEN co.collname END)
           ORDER BY a.attnum))
      FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_type at ON at.oid = a.atttypid
      LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
     WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped)::text END AS attributes,
  CASE WHEN t.typtype = 'd' THEN pg_catalog.format_type(t.typbasetype, t.typtypmod) END AS base_type,
  t.typnotnull AS not_null, t.typdefault AS default_expr,
  CASE WHEN t.typtype = 'd' AND t.typcollation <> 0 AND t.typcollation <> bt.typcollation
       THEN (SELECT co.collname FROM pg_catalog.pg_collation co WHERE co.oid = t.typcollation) END AS collation,
  CASE WHEN t.typtype = 'd' THEN (
    SELECT pg_catalog.to_json(pg_catalog.array_agg(pg_catalog.json_build_object(
             'name', con.conname, 'definition', pg_catalog.pg_get_constraintdef(con.oid)) ORDER BY con.conname))
      FROM pg_catalog.pg_constraint con WHERE con.contypid = t.oid AND con.contype = 'c')::text END AS checks,
  CASE WHEN t.typtype = 'r' THEN (
    SELECT pg_catalog.json_build_object(
             'subtype', pg_catalog.format_type(r.rngsubtype, NULL),
             'opclass', CASE WHEN NOT opc.opcdefault THEN opc.opcname END,
             'subdiff', CASE WHEN r.rngsubdiff <> 0 THEN r.rngsubdiff::regproc::text END,
             'canonical', CASE WHEN r.rngcanonical <> 0 THEN r.rngcanonical::regproc::text END,
             'collation', CASE WHEN r.rngcollation <> 0 THEN (SELECT co.collname FROM pg_catalog.pg_collation co WHERE co.oid = r.rngcollation) END)
      FROM pg_catalog.pg_range r LEFT JOIN pg_catalog.pg_opclass opc ON opc.oid = r.rngsubopc
     WHERE r.rngtypid = t.oid)::text END AS range
FROM pg_catalog.pg_type t
JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
LEFT JOIN pg_catalog.pg_type bt ON bt.oid = t.typbasetype
WHERE t.typnamespace = ANY($1::oid[])
  AND (t.typtype IN ('e', 'd', 'r')
       OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = t.typrelid) = 'c'))
  AND ${notExtensionMember('pg_type', 't.oid')}
ORDER BY t.typname`;

const EXTENSIONS_SQL = `SELECT e.extname AS name, n.nspname AS schema, e.extversion AS version
FROM pg_catalog.pg_extension e JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
ORDER BY e.extname`;

const ACTIONS: Readonly<Record<string, ReferentialAction>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

const MATCH: Readonly<Record<string, 'SIMPLE' | 'FULL' | 'PARTIAL'>> = {
  s: 'SIMPLE',
  f: 'FULL',
  p: 'PARTIAL',
};

/** "fillfactor=70" entries of reloptions → record. */
function relOptions(row: Row): Record<string, string> {
  const options: Record<string, string> = {};
  for (const entry of json<string[] | null>(row, 'reloptions', null) ?? []) {
    const eq = entry.indexOf('=');
    if (eq > 0) options[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return options;
}

/** Trigger timing and events from pg_trigger.tgtype bits. */
export function triggerShape(tgtype: number): Pick<TriggerDef, 'timing' | 'events'> {
  const timing = tgtype & 2 ? 'BEFORE' : tgtype & 64 ? 'INSTEAD OF' : 'AFTER';
  const events: TriggerDef['events'][number][] = [];
  if (tgtype & 4) events.push('INSERT');
  if (tgtype & 8) events.push('DELETE');
  if (tgtype & 16) events.push('UPDATE');
  if (tgtype & 32) events.push('TRUNCATE');
  return { timing, events };
}

/** "RANGE (created_at)" → method and key. */
export function splitPartitionKey(partkey: string): { method: string; key: string } {
  const space = partkey.indexOf(' ');
  if (space < 0) return { method: partkey, key: '' };
  return { method: partkey.slice(0, space).toUpperCase(), key: partkey.slice(space + 1).trim() };
}

/** pg_get_constraintdef text of a CHECK constraint → the bare condition. */
export function checkExpression(definition: string): string {
  return definition.replace(/^CHECK\s+/, '').replace(/\s+NOT VALID$/, '');
}

interface IndexPart {
  attname: string | null;
  expr: string | null;
  option: number;
  collation: string | null;
  opclass: string | null;
}

function indexDef(row: Row): IndexDef {
  const parts = json<IndexPart[]>(row, 'parts', []);
  const nkey = num(row, 'nkey');
  const columns: IndexColumn[] = parts.slice(0, nkey).map((part) => {
    const desc = (part.option & 1) !== 0;
    const nullsFirst = (part.option & 2) !== 0;
    const column: { -readonly [K in keyof IndexColumn]: IndexColumn[K] } = {
      name: part.expr === null ? part.attname : null,
      order: desc ? 'desc' : 'asc',
    };
    if (part.expr !== null) column.expression = part.expr;
    if (desc !== nullsFirst) column.nulls = nullsFirst ? 'first' : 'last';
    if (part.collation) column.collation = part.collation;
    if (part.opclass) column.opclass = part.opclass;
    return column;
  });
  const index: { -readonly [K in keyof IndexDef]: IndexDef[K] } = {
    name: str(row, 'name'),
    columns,
    unique: bool(row, 'is_unique'),
    method: str(row, 'method'),
    include: parts.slice(nkey).map((part) => part.attname ?? part.expr ?? ''),
    invisible: false,
    definition: str(row, 'definition'),
  };
  const where = opt(row, 'predicate');
  if (where !== undefined) index.where = where;
  const comment = opt(row, 'comment');
  if (comment !== undefined) index.comment = comment;
  return index;
}

function columnDef(row: Row, ordinal: number): ColumnDef {
  const column: { -readonly [K in keyof ColumnDef]: ColumnDef[K] } = {
    name: str(row, 'name'),
    ordinal,
    dataType: str(row, 'type'),
    nullable: !bool(row, 'notnull'),
    default: null,
    autoIncrement: false,
  };
  const identity = str(row, 'identity');
  const generated = str(row, 'generated');
  const expression = opt(row, 'default_expr');
  if (identity === 'a' || identity === 'd') {
    const seq = json<{ start: string; increment: string } | null>(row, 'identity_seq', null);
    column.identity = {
      generation: identity === 'a' ? 'always' : 'by-default',
      ...(seq ? { start: seq.start, increment: seq.increment } : {}),
    };
  } else if (generated !== '' && expression !== undefined) {
    column.generated = { expression, stored: generated === 's' };
  } else if (expression !== undefined) {
    column.default = expression;
  }
  const collation = opt(row, 'collation');
  if (collation !== undefined) column.collation = collation;
  const comment = opt(row, 'comment');
  if (comment !== undefined) column.comment = comment;
  return column;
}

interface SchemaDraft {
  name: string;
  owner?: string;
  comment?: string;
  tables: TableDef[];
  views: ViewDef[];
  routines: RoutineDef[];
  sequences: SequenceDef[];
  types: TypeDef[];
}

function buildTypeDefinition(row: Row, qualified: string): string {
  const kind = str(row, 'type');
  if (kind === 'e') {
    const labels = json<string[]>(row, 'labels', []);
    return `CREATE TYPE ${qualified} AS ENUM (${labels.map((l) => quoteString(l, 'postgres')).join(', ')})`;
  }
  if (kind === 'c') {
    const attributes = json<{ name: string; type: string; collation: string | null }[]>(
      row,
      'attributes',
      [],
    );
    const body = attributes
      .map(
        (a) =>
          `${quoteIdent(a.name, 'postgres')} ${a.type}${a.collation ? ` COLLATE ${quoteIdent(a.collation, 'postgres')}` : ''}`,
      )
      .join(', ');
    return `CREATE TYPE ${qualified} AS (${body})`;
  }
  if (kind === 'd') {
    const collation = opt(row, 'collation');
    const defaultExpr = opt(row, 'default_expr');
    const checks = json<{ name: string; definition: string }[] | null>(row, 'checks', null) ?? [];
    return [
      `CREATE DOMAIN ${qualified} AS ${str(row, 'base_type')}`,
      collation ? ` COLLATE ${quoteIdent(collation, 'postgres')}` : '',
      defaultExpr !== undefined ? ` DEFAULT ${defaultExpr}` : '',
      bool(row, 'not_null') ? ' NOT NULL' : '',
      ...checks.map((c) => ` CONSTRAINT ${quoteIdent(c.name, 'postgres')} ${c.definition}`),
    ].join('');
  }
  const range = json<{
    subtype: string;
    opclass: string | null;
    subdiff: string | null;
    canonical: string | null;
    collation: string | null;
  } | null>(row, 'range', null);
  const parts = [`SUBTYPE = ${range?.subtype ?? 'unknown'}`];
  if (range?.opclass) parts.push(`SUBTYPE_OPCLASS = ${quoteIdent(range.opclass, 'postgres')}`);
  if (range?.collation) parts.push(`COLLATION = ${quoteIdent(range.collation, 'postgres')}`);
  if (range?.canonical) parts.push(`CANONICAL = ${range.canonical}`);
  if (range?.subdiff) parts.push(`SUBTYPE_DIFF = ${range.subdiff}`);
  return `CREATE TYPE ${qualified} AS RANGE (${parts.join(', ')})`;
}

function aggregateDefinition(row: Row, qualified: string): string {
  const agg = json<{
    sfunc: string;
    stype: string;
    finalfunc: string | null;
    combinefunc: string | null;
    initcond: string | null;
  } | null>(row, 'aggregate', null);
  const parts = [`SFUNC = ${agg?.sfunc ?? 'unknown'}`, `STYPE = ${agg?.stype ?? 'unknown'}`];
  if (agg?.finalfunc) parts.push(`FINALFUNC = ${agg.finalfunc}`);
  if (agg?.combinefunc) parts.push(`COMBINEFUNC = ${agg.combinefunc}`);
  if (agg?.initcond !== null && agg?.initcond !== undefined) {
    parts.push(`INITCOND = ${quoteString(agg.initcond, 'postgres')}`);
  }
  return `CREATE AGGREGATE ${qualified}(${str(row, 'signature') || '*'}) (${parts.join(', ')})`;
}

const bySignature = (a: RoutineDef, b: RoutineDef): number =>
  byName(a, b) || (a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0);

/** Introspects the current database. `query` runs catalog SQL in the caller's snapshot. */
export async function introspectPostgres(
  query: QueryFn,
  scope: IntrospectScope,
  serverVersion: string,
): Promise<SchemaSnapshot> {
  const wants = (kind: SchemaObjectKind): boolean => !scope.include || scope.include.includes(kind);
  const [database] = await query(DATABASE_SQL);
  const schemaRows = await query(SCHEMAS_SQL, [scope.schemas ? [...scope.schemas] : null]);
  const oids = schemaRows.map((row) => num(row, 'oid'));
  const schemas = new Map<number, SchemaDraft>();
  for (const row of schemaRows) {
    const draft: SchemaDraft = {
      name: str(row, 'name'),
      tables: [],
      views: [],
      routines: [],
      sequences: [],
      types: [],
    };
    const owner = opt(row, 'owner');
    if (owner !== undefined) draft.owner = owner;
    const comment = opt(row, 'comment');
    if (comment !== undefined) draft.comment = comment;
    schemas.set(num(row, 'oid'), draft);
  }
  const schemaName = (nsp: number): string => schemas.get(nsp)?.name ?? '';

  const wantTables = wants('table');
  const wantViews = wants('view');
  const wantMatviews = wants('materialized-view');
  if (oids.length > 0 && (wantTables || wantViews || wantMatviews)) {
    const relRows = await query(RELATIONS_SQL, [oids]);
    const columnRows = await query(COLUMNS_SQL, [oids]);
    const constraintRows = wantTables ? await query(CONSTRAINTS_SQL, [oids]) : [];
    const indexRows = wantTables || wantMatviews ? await query(INDEXES_SQL, [oids]) : [];
    const triggerRows = wantTables && wants('trigger') ? await query(TRIGGERS_SQL, [oids]) : [];

    const group = (rows: Row[]): Map<number, Row[]> => {
      const map = new Map<number, Row[]>();
      for (const row of rows) {
        const rel = num(row, 'rel');
        const list = map.get(rel);
        if (list) list.push(row);
        else map.set(rel, [row]);
      }
      return map;
    };
    const columnsByRel = group(columnRows);
    const constraintsByRel = group(constraintRows);
    const indexesByRel = group(indexRows);
    const triggersByRel = group(triggerRows);

    const tablesByOid = new Map<number, TableDef>();
    const partitionRows: Row[] = [];
    for (const row of relRows) {
      const oid = num(row, 'oid');
      const draft = schemas.get(num(row, 'nsp'));
      if (!draft) continue;
      const kind = str(row, 'kind');
      const columns = (columnsByRel.get(oid) ?? []).map((column, i) => columnDef(column, i + 1));
      const owner = opt(row, 'owner');
      const comment = opt(row, 'comment');

      if (kind === 'v' || kind === 'm') {
        if (kind === 'v' ? !wantViews : !wantMatviews) continue;
        const options = relOptions(row);
        const checkOption = options['check_option'];
        delete options['check_option'];
        const view: { -readonly [K in keyof ViewDef]: ViewDef[K] } = {
          name: str(row, 'name'),
          materialized: kind === 'm',
          definition: str(row, 'viewdef').trim().replace(/;$/, ''),
          columns: columns.map((c) => c.name),
          options,
          indexes: kind === 'm' ? (indexesByRel.get(oid) ?? []).map(indexDef).sort(byName) : [],
        };
        if (kind === 'm' && opt(row, 'tablespace') !== undefined)
          options['tablespace'] = str(row, 'tablespace');
        if (checkOption === 'local' || checkOption === 'cascaded') {
          view.checkOption = checkOption === 'local' ? 'LOCAL' : 'CASCADED';
        }
        if (comment !== undefined) view.comment = comment;
        if (owner !== undefined) view.owner = owner;
        draft.views.push(view);
        continue;
      }
      if (!wantTables) continue;
      if (bool(row, 'is_partition')) {
        partitionRows.push(row);
        continue;
      }

      const table: { -readonly [K in keyof TableDef]: TableDef[K] } = {
        name: str(row, 'name'),
        kind: kind === 'p' ? 'partitioned' : kind === 'f' ? 'foreign' : 'table',
        columns,
        uniques: [],
        indexes: (indexesByRel.get(oid) ?? []).map(indexDef).sort(byName),
        foreignKeys: [],
        checks: [],
        triggers: [],
        options: relOptions(row),
      };
      const tablespace = opt(row, 'tablespace');
      if (tablespace !== undefined) table.options['tablespace'] = tablespace;
      if (comment !== undefined) table.comment = comment;
      if (owner !== undefined) table.owner = owner;
      const partkey = opt(row, 'partkey');
      if (partkey !== undefined)
        table.partitioning = { ...splitPartitionKey(partkey), partitions: [] };

      const uniques: KeyDef[] = [];
      const foreignKeys: ForeignKeyDef[] = [];
      const checks: CheckDef[] = [];
      for (const con of constraintsByRel.get(oid) ?? []) {
        const name = str(con, 'name');
        const columnsOf = json<string[]>(con, 'columns', []);
        switch (str(con, 'type')) {
          case 'p':
            table.primaryKey = { name, columns: columnsOf };
            break;
          case 'u':
            uniques.push({ name, columns: columnsOf });
            break;
          case 'c':
            checks.push({ name, expression: checkExpression(str(con, 'definition')) });
            break;
          case 'f': {
            const fk: { -readonly [K in keyof ForeignKeyDef]: ForeignKeyDef[K] } = {
              name,
              columns: columnsOf,
              refTable: str(con, 'ref_table'),
              refColumns: json<string[]>(con, 'ref_columns', []),
              onUpdate: ACTIONS[str(con, 'on_update')] ?? 'NO ACTION',
              onDelete: ACTIONS[str(con, 'on_delete')] ?? 'NO ACTION',
              match: MATCH[str(con, 'match')] ?? 'SIMPLE',
              deferrable: !bool(con, 'deferrable')
                ? 'not-deferrable'
                : bool(con, 'deferred')
                  ? 'initially-deferred'
                  : 'initially-immediate',
            };
            if (num(con, 'ref_nsp') !== num(row, 'nsp')) fk.refSchema = str(con, 'ref_schema');
            foreignKeys.push(fk);
            break;
          }
        }
      }
      table.uniques = uniques.sort(byName);
      table.foreignKeys = foreignKeys.sort(byName);
      table.checks = checks.sort(byName);
      table.triggers = (triggersByRel.get(oid) ?? [])
        .map((trigger) => ({
          name: str(trigger, 'name'),
          ...triggerShape(num(trigger, 'type')),
          definition: str(trigger, 'definition'),
        }))
        .sort(byName);
      tablesByOid.set(oid, table);
      draft.tables.push(table);
    }

    const nspOf = new Map(relRows.map((r) => [num(r, 'oid'), num(r, 'nsp')]));
    for (const row of partitionRows) {
      const parent = tablesByOid.get(num(row, 'parent'));
      if (!parent?.partitioning) continue;
      const sameSchema = nspOf.get(num(row, 'parent')) === num(row, 'nsp');
      const name = sameSchema
        ? str(row, 'name')
        : `${schemaName(num(row, 'nsp'))}.${str(row, 'name')}`;
      const bound = opt(row, 'partbound');
      parent.partitioning.partitions.push({ name, ...(bound !== undefined ? { bound } : {}) });
    }
    for (const table of tablesByOid.values()) table.partitioning?.partitions.sort(byName);
  }

  if (oids.length > 0 && wants('routine')) {
    for (const row of await query(ROUTINES_SQL, [oids])) {
      const draft = schemas.get(num(row, 'nsp'));
      if (!draft) continue;
      const kind = str(row, 'kind');
      const qualified = quoteQualified([str(row, 'schema'), str(row, 'name')], 'postgres');
      const routine: { -readonly [K in keyof RoutineDef]: RoutineDef[K] } = {
        name: str(row, 'name'),
        kind: kind === 'p' ? 'procedure' : kind === 'a' ? 'aggregate' : 'function',
        signature: str(row, 'signature'),
        language: str(row, 'language'),
        definition:
          kind === 'a' ? aggregateDefinition(row, qualified) : str(row, 'definition').trimEnd(),
      };
      const returns = opt(row, 'returns');
      if (returns !== undefined) routine.returns = returns;
      const comment = opt(row, 'comment');
      if (comment !== undefined) routine.comment = comment;
      const owner = opt(row, 'owner');
      if (owner !== undefined) routine.owner = owner;
      draft.routines.push(routine);
    }
  }

  if (oids.length > 0 && wants('sequence')) {
    for (const row of await query(SEQUENCES_SQL, [oids])) {
      const draft = schemas.get(num(row, 'nsp'));
      if (!draft) continue;
      const owned = json<{
        deptype: string;
        nsp: number;
        schema: string;
        table: string;
        column: string;
      } | null>(row, 'owned', null);
      if (owned?.deptype === 'i') continue;
      const sequence: { -readonly [K in keyof SequenceDef]: SequenceDef[K] } = {
        name: str(row, 'name'),
        dataType: str(row, 'data_type'),
        start: str(row, 'start'),
        increment: str(row, 'increment'),
        minValue: str(row, 'min_value'),
        maxValue: str(row, 'max_value'),
        cache: str(row, 'cache'),
        cycle: bool(row, 'cycle'),
      };
      if (owned) {
        sequence.ownedBy =
          Number(owned.nsp) === num(row, 'nsp')
            ? `${owned.table}.${owned.column}`
            : `${owned.schema}.${owned.table}.${owned.column}`;
      }
      const owner = opt(row, 'owner');
      if (owner !== undefined) sequence.owner = owner;
      draft.sequences.push(sequence);
    }
  }

  if (oids.length > 0 && wants('type')) {
    for (const row of await query(TYPES_SQL, [oids])) {
      const draft = schemas.get(num(row, 'nsp'));
      if (!draft) continue;
      const kind = str(row, 'type');
      const qualified = quoteQualified([str(row, 'schema'), str(row, 'name')], 'postgres');
      const type: { -readonly [K in keyof TypeDef]: TypeDef[K] } = {
        name: str(row, 'name'),
        kind:
          kind === 'e' ? 'enum' : kind === 'c' ? 'composite' : kind === 'd' ? 'domain' : 'range',
        values: kind === 'e' ? json<string[]>(row, 'labels', []) : [],
        definition: buildTypeDefinition(row, qualified),
      };
      const comment = opt(row, 'comment');
      if (comment !== undefined) type.comment = comment;
      const owner = opt(row, 'owner');
      if (owner !== undefined) type.owner = owner;
      draft.types.push(type);
    }
  }

  const extensions = wants('extension')
    ? (await query(EXTENSIONS_SQL)).map((row) => ({
        name: str(row, 'name'),
        schema: str(row, 'schema'),
        version: str(row, 'version'),
      }))
    : [];

  const options: Record<string, string> = {};
  if (database) {
    for (const key of ['encoding', 'collation', 'ctype']) {
      const value = opt(database, key);
      if (value !== undefined) options[key] = value;
    }
  }

  return schemaSnapshotSchema.parse({
    engine: 'postgres',
    serverVersion,
    database: database ? str(database, 'name') : '',
    options,
    schemas: [...schemas.values()]
      .map((draft) => ({
        ...draft,
        tables: draft.tables.sort(byName),
        views: draft.views.sort(byName),
        routines: draft.routines.sort(bySignature),
        sequences: draft.sequences.sort(byName),
        types: draft.types.sort(byName),
        events: [],
      }))
      .sort(byName),
    extensions: extensions.sort(byName),
    capturedAt: new Date().toISOString(),
  });
}
