import type { CellValue, ColumnKind, SqlDialect } from '@joinery/core';
import { JoineryError } from '@joinery/core';
import { quoteIdent, quoteQualified, quoteString } from '@joinery/sql-tools';

/**
 * SQL for the data sync algorithm (spec §13): key-range predicates, per-range checksums
 * computed server-side, range boundaries and key-ordered row streams. Values always travel as
 * positional parameters: `$1, $2...` for PostgreSQL, `?` for MySQL and MariaDB.
 */

export interface TableRef {
  /** PostgreSQL schema; ignored for MySQL/MariaDB (the session's database). */
  readonly schema?: string;
  readonly name: string;
}

/**
 * A half-open range of key tuples: rows with `lower < key <= upper`. A missing bound is open,
 * so consecutive ranges built from sampled boundaries cover the key space exactly once.
 */
export interface KeyRange {
  readonly lower?: readonly CellValue[];
  readonly upper?: readonly CellValue[];
}

/** Query text and its positional parameters. */
export interface SqlQuery {
  readonly text: string;
  readonly params: CellValue[];
}

/** The quoted table name: schema-qualified on PostgreSQL. */
export function tableName(table: TableRef, dialect: SqlDialect): string {
  return dialect === 'postgres'
    ? quoteQualified([table.schema, table.name], dialect)
    : quoteIdent(table.name, dialect);
}

class Params {
  readonly values: CellValue[] = [];
  constructor(private readonly dialect: SqlDialect) {}
  add(value: CellValue): string {
    this.values.push(value);
    return this.dialect === 'postgres' ? `$${this.values.length}` : '?';
  }
}

/**
 * Tuple comparison `(k1, k2) op (v1, v2)`. PostgreSQL gets a row comparison (index-friendly
 * there); MySQL gets the expanded OR form, which its range optimiser handles while it does
 * not use indexes for row-constructor inequalities.
 */
function tupleCompare(
  columns: readonly string[],
  values: readonly CellValue[],
  op: '>' | '<=',
  dialect: SqlDialect,
  params: Params,
): string {
  const idents = columns.map((c) => quoteIdent(c, dialect));
  if (dialect === 'postgres' || columns.length === 1) {
    if (columns.length === 1) return `${idents[0]!} ${op} ${params.add(values[0] ?? null)}`;
    return `(${idents.join(', ')}) ${op} (${values.map((v) => params.add(v)).join(', ')})`;
  }
  const strict = op === '>' ? '>' : '<';
  const build = (i: number): string => {
    const last = i === columns.length - 1;
    const cmp = `${idents[i]!} ${last ? op : strict} ${params.add(values[i] ?? null)}`;
    if (last) return cmp;
    return `(${cmp} OR (${idents[i]!} = ${params.add(values[i] ?? null)} AND ${build(i + 1)}))`;
  };
  return build(0);
}

function rangeWhere(
  keyColumns: readonly string[],
  range: KeyRange,
  dialect: SqlDialect,
  params: Params,
): string {
  const parts: string[] = [];
  if (range.lower !== undefined)
    parts.push(tupleCompare(keyColumns, range.lower, '>', dialect, params));
  if (range.upper !== undefined)
    parts.push(tupleCompare(keyColumns, range.upper, '<=', dialect, params));
  return parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '';
}

function keyOrder(
  keyColumns: readonly string[],
  dialect: SqlDialect,
  keyKinds: readonly ColumnKind[] = [],
): string {
  return keyColumns
    .map((c, i) => {
      const ident = quoteIdent(c, dialect);
      const kind = keyKinds[i];
      if (kind !== 'string' && kind !== 'enum') return ident;
      return dialect === 'postgres' ? `${ident}::text COLLATE "C"` : `CAST(${ident} AS BINARY)`;
    })
    .join(', ');
}

/**
 * NULL-safe, unambiguous text encoding of one column inside a row hash: `v<length>:<text>` for
 * values and `n` for NULL, so NULL, '' and 'NULL' all differ and no two column sequences run
 * together.
 */
function encodeColumn(column: string, dialect: SqlDialect): string {
  const ident = quoteIdent(column, dialect);
  if (dialect === 'postgres') {
    return `coalesce('v' || length(${ident}::text) || ':' || ${ident}::text, 'n')`;
  }
  const bin = `CAST(${ident} AS BINARY)`;
  return `COALESCE(CONCAT('v', LENGTH(${bin}), ':', ${bin}), 'n')`;
}

/**
 * Row count and checksum of a key range, computed on the server (spec §13, step 3).
 *
 * PostgreSQL: md5 of the md5 row hashes concatenated in hash order (a hash of ordered row
 * hashes; ordering by the hash itself makes it independent of the key collation).
 *
 * MySQL/MariaDB: BIT_XOR of the two 64-bit halves of each row's MD5, next to COUNT(*).
 * GROUP_CONCAT would need group_concat_max_len raised in every session and buffers the whole
 * range; BIT_XOR streams, needs no session setting, and works on read-only replicas. XOR is
 * order-independent, which is safe here because every row hash includes the row's unique key,
 * so no two rows of a range can cancel out, and the count guards the empty-versus-missing case.
 */
export function checksumQuery(
  table: TableRef,
  columns: readonly string[],
  keyColumns: readonly string[],
  range: KeyRange,
  dialect: SqlDialect,
): SqlQuery {
  const params = new Params(dialect);
  const where = rangeWhere(keyColumns, range, dialect, params);
  const from = tableName(table, dialect);
  if (dialect === 'postgres') {
    const row = columns.map((c) => encodeColumn(c, dialect)).join(' || ');
    return {
      text: `SELECT count(*) AS row_count, md5(coalesce(string_agg(h, '' ORDER BY h COLLATE "C"), '')) AS checksum FROM (SELECT md5(${row}) AS h FROM ${from}${where}) AS joinery_rows`,
      params: params.values,
    };
  }
  const row = `CONCAT(${columns.map((c) => encodeColumn(c, dialect)).join(', ')})`;
  const half = (start: number): string =>
    `LPAD(HEX(BIT_XOR(CAST(CONV(SUBSTRING(h, ${start}, 16), 16, 10) AS UNSIGNED))), 16, '0')`;
  return {
    text: `SELECT COUNT(*) AS row_count, CONCAT(${half(1)}, ${half(17)}) AS checksum FROM (SELECT MD5(${row}) AS h FROM ${from}${where}) AS joinery_rows`,
    params: params.values,
  };
}

/**
 * The key `offset` rows after `after` in key order (the upper bound of the next range), or
 * no row when fewer remain. Walking the key space this way reads each index entry once.
 */
export function boundaryQuery(
  table: TableRef,
  keyColumns: readonly string[],
  after: readonly CellValue[] | undefined,
  offset: number,
  dialect: SqlDialect,
): SqlQuery {
  const params = new Params(dialect);
  const where = rangeWhere(
    keyColumns,
    after === undefined ? {} : { lower: after },
    dialect,
    params,
  );
  const cols = keyColumns.map((c) => quoteIdent(c, dialect)).join(', ');
  const skip = Math.max(0, Math.floor(offset));
  return {
    text: `SELECT ${cols} FROM ${tableName(table, dialect)}${where} ORDER BY ${cols} LIMIT 1 OFFSET ${skip}`,
    params: params.values,
  };
}

/** Rows of a key range, sorted by key with string keys in binary (code point) order. */
export function rowsQuery(
  table: TableRef,
  columns: readonly string[],
  keyColumns: readonly string[],
  range: KeyRange,
  dialect: SqlDialect,
  keyKinds: readonly ColumnKind[] = [],
): SqlQuery {
  const params = new Params(dialect);
  const where = rangeWhere(keyColumns, range, dialect, params);
  const cols = columns.map((c) => quoteIdent(c, dialect)).join(', ');
  return {
    text: `SELECT ${cols} FROM ${tableName(table, dialect)}${where} ORDER BY ${keyOrder(keyColumns, dialect, keyKinds)}`,
    params: params.values,
  };
}

/** A query that returns no rows, only the column metadata. */
export function columnsQuery(table: TableRef, dialect: SqlDialect): SqlQuery {
  return { text: `SELECT * FROM ${tableName(table, dialect)} WHERE 1 = 0`, params: [] };
}

// ---------------------------------------------------------------------------------------------
// Literals

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * A SQL literal for any cell value. Strings go through the dialect's quoting; binary becomes a
 * hex literal (`'\x…'::bytea`, `X'…'`); bigints and finite numbers are written as numbers;
 * booleans as TRUE/FALSE (MySQL: 1/0). With a target `kind`, numbers and strings bound for a
 * PostgreSQL boolean column become TRUE/FALSE. Large-value handles cannot be scripted.
 */
export function sqlLiteral(value: CellValue, dialect: SqlDialect, kind?: ColumnKind): string {
  const pg = dialect === 'postgres';
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return pg ? (value ? 'TRUE' : 'FALSE') : value ? '1' : '0';
  if (
    kind === 'boolean' &&
    pg &&
    (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string')
  ) {
    const text = String(value).trim().toLowerCase();
    if (['1', 't', 'true', 'y', 'yes', 'on'].includes(text)) return 'TRUE';
    if (['0', 'f', 'false', 'n', 'no', 'off'].includes(text)) return 'FALSE';
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return String(value);
    if (!pg) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `MySQL cannot store the value ${String(value)}`,
      });
    }
    return `'${Number.isNaN(value) ? 'NaN' : value > 0 ? 'Infinity' : '-Infinity'}'::float8`;
  }
  if (value instanceof Uint8Array) return pg ? `'\\x${hex(value)}'::bytea` : `X'${hex(value)}'`;
  if (typeof value === 'string') return quoteString(value, dialect);
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: 'A large value was only previewed; fetch it in full before scripting',
  });
}
