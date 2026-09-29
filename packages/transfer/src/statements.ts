import type { ColumnDef, SqlDialect, TableDef } from '@joinery/core';
import { quoteIdent, quoteQualified } from '@joinery/sql-tools';

/**
 * Parameterised statements for the import modes (spec §12): multi-row INSERT, upsert
 * (PostgreSQL ON CONFLICT, MySQL/MariaDB ON DUPLICATE KEY UPDATE with the MySQL 8.0.19+ row
 * alias where available), update and delete by key. Values always travel as parameters:
 * `$n` for PostgreSQL, `?` for MySQL and MariaDB.
 */

/** Most placeholders one statement may carry: PostgreSQL's Bind and MySQL's prepared limit. */
export const MAX_PARAMETERS = 65_535;

export type ImportMode = 'append' | 'update' | 'upsert' | 'delete' | 'replace';

/** The quoted table name: schema-qualified on PostgreSQL when a schema is given. */
export function qualifiedTable(table: string, dialect: SqlDialect, schema?: string): string {
  return dialect === 'postgres'
    ? quoteQualified([schema, table], dialect)
    : quoteIdent(table, dialect);
}

/** MySQL 8.0.19+ (not MariaDB) takes `INSERT ... AS alias ON DUPLICATE KEY UPDATE`. */
export function supportsRowAlias(dialect: SqlDialect, serverVersion: string): boolean {
  if (dialect !== 'mysql' || /mariadb/i.test(serverVersion)) return false;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(serverVersion);
  if (!m) return false;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return major > 8 || (major === 8 && (minor > 0 || patch >= 19));
}

export interface StatementPlan {
  readonly dialect: SqlDialect;
  readonly table: TableDef;
  readonly schema?: string;
  readonly mode: ImportMode;
  /** Target columns bound per row, in parameter order. */
  readonly columns: readonly string[];
  /** Key columns (update, upsert, delete). */
  readonly keys: readonly string[];
  /** Use the MySQL row-alias upsert form. */
  readonly rowAlias?: boolean;
}

/**
 * Builds the text for `rows` rows. Callers keep `rows * columns.length` within
 * MAX_PARAMETERS; the text for a row count is deterministic, so it can be cached.
 */
export function buildStatement(plan: StatementPlan, rows: number): string {
  const { dialect, mode } = plan;
  if (mode === 'update') return buildUpdate(plan, rows);
  if (mode === 'delete') return buildDelete(plan, rows);
  const pg = dialect === 'postgres';
  const table = qualifiedTable(plan.table.name, dialect, plan.schema);
  const cols = plan.columns.map((c) => quoteIdent(c, dialect)).join(', ');
  const overriding =
    pg && plan.columns.some((c) => columnOf(plan.table, c)?.identity?.generation === 'always')
      ? ' OVERRIDING SYSTEM VALUE'
      : '';
  let sql = `INSERT INTO ${table} (${cols})${overriding} VALUES ${valuesList(plan.columns.length, rows, dialect)}`;
  if (mode !== 'upsert') return sql;
  const keySet = new Set(plan.keys);
  const updates = plan.columns.filter((c) => !keySet.has(c));
  if (pg) {
    const conflict = plan.keys.map((k) => quoteIdent(k, dialect)).join(', ');
    sql += ` ON CONFLICT (${conflict}) DO `;
    sql +=
      updates.length === 0
        ? 'NOTHING'
        : `UPDATE SET ${updates.map((c) => `${quoteIdent(c, dialect)} = EXCLUDED.${quoteIdent(c, dialect)}`).join(', ')}`;
    return sql;
  }
  const alias = 'joinery_new';
  if (plan.rowAlias === true) sql += ` AS ${alias}`;
  const assign = (c: string): string => {
    const ident = quoteIdent(c, dialect);
    return plan.rowAlias === true ? `${ident} = ${alias}.${ident}` : `${ident} = VALUES(${ident})`;
  };
  // With nothing to update, a no-op assignment keeps existing rows as they are.
  const first = quoteIdent(plan.keys[0] ?? plan.columns[0]!, dialect);
  sql += ` ON DUPLICATE KEY UPDATE ${updates.length === 0 ? `${first} = ${first}` : updates.map(assign).join(', ')}`;
  return sql;
}

function columnOf(table: TableDef, name: string): ColumnDef | undefined {
  return table.columns.find((c) => c.name === name);
}

/** `($1, $2), ($3, $4)` or `(?, ?), (?, ?)`; with `casts`, the first row casts each value. */
function valuesList(
  width: number,
  rows: number,
  dialect: SqlDialect,
  casts?: readonly string[],
): string {
  const parts: string[] = new Array<string>(rows);
  if (dialect !== 'postgres') {
    const row = `(${new Array<string>(width).fill('?').join(', ')})`;
    return new Array<string>(rows).fill(row).join(', ');
  }
  let n = 1;
  for (let r = 0; r < rows; r++) {
    const cells: string[] = new Array<string>(width);
    for (let c = 0; c < width; c++) {
      cells[c] = r === 0 && casts !== undefined ? `CAST($${n} AS ${casts[c]!})` : `$${n}`;
      n++;
    }
    parts[r] = `(${cells.join(', ')})`;
  }
  return parts.join(', ');
}

function buildUpdate(plan: StatementPlan, rows: number): string {
  const { dialect } = plan;
  const table = qualifiedTable(plan.table.name, dialect, plan.schema);
  const keySet = new Set(plan.keys);
  const updates = plan.columns.filter((c) => !keySet.has(c));
  const q = (c: string): string => quoteIdent(c, dialect);
  const match = plan.keys.map((k) => `t.${q(k)} = v.${q(k)}`).join(' AND ');
  if (dialect === 'postgres') {
    // Unknown-typed parameters in VALUES would resolve as text; the first row casts them.
    const casts = plan.columns.map((c) => columnOf(plan.table, c)?.dataType ?? 'text');
    return `UPDATE ${table} AS t SET ${updates.map((c) => `${q(c)} = v.${q(c)}`).join(', ')} FROM (VALUES ${valuesList(plan.columns.length, rows, dialect, casts)}) AS v (${plan.columns.map(q).join(', ')}) WHERE ${match}`;
  }
  const first = `SELECT ${plan.columns.map((c) => `? AS ${q(c)}`).join(', ')}`;
  const rest = `SELECT ${new Array<string>(plan.columns.length).fill('?').join(', ')}`;
  const derived = [first, ...new Array<string>(rows - 1).fill(rest)].join(' UNION ALL ');
  return `UPDATE ${table} AS t JOIN (${derived}) AS v ON ${match} SET ${updates.map((c) => `t.${q(c)} = v.${q(c)}`).join(', ')}`;
}

function buildDelete(plan: StatementPlan, rows: number): string {
  const { dialect } = plan;
  const table = qualifiedTable(plan.table.name, dialect, plan.schema);
  const keys = plan.keys.map((k) => quoteIdent(k, dialect));
  if (keys.length === 1) {
    const list =
      dialect === 'postgres'
        ? Array.from({ length: rows }, (_, i) => `$${i + 1}`).join(', ')
        : new Array<string>(rows).fill('?').join(', ');
    return `DELETE FROM ${table} WHERE ${keys[0]!} IN (${list})`;
  }
  return `DELETE FROM ${table} WHERE (${keys.join(', ')}) IN (${valuesList(keys.length, rows, dialect)})`;
}

/** Statements that empty the table for `replace`. */
export function emptyTableStatement(
  table: TableDef,
  dialect: SqlDialect,
  schema: string | undefined,
  how: 'truncate' | 'delete',
): string {
  const name = qualifiedTable(table.name, dialect, schema);
  return how === 'truncate' ? `TRUNCATE TABLE ${name}` : `DELETE FROM ${name}`;
}
