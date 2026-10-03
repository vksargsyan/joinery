import { QuerybaraError, type CellValue, type SqlDialect } from '@querybara/core';

import type { ChangeSet, RowChange, RowInsert } from './changes';
import type { ColumnInfo } from './columns';
import { describeRow, type RowIdentity, type RowKey } from './identity';
import {
  andAll,
  compare,
  ident,
  joinFragments,
  param,
  renderLiterals,
  renderQuery,
  tableSql,
  type Fragment,
  type SqlQuery,
  type TableRef,
} from './sql';
import { isDefault, isLargeValue } from './values';

/**
 * Turns a ChangeSet into the statements Apply runs (spec §7): deletes, then updates, then
 * inserts, one statement per row, each parameterised and also rendered with literals for the
 * Apply dialog. Every UPDATE and DELETE finds its row by the identity's loaded values
 * (`IS NULL` for NULLs); `applyChanges` then requires each to touch exactly one row.
 *
 * Conflict detection: with `conflictCheck: 'changed-columns'` (the default) an UPDATE also
 * requires every column it changes to still hold the value it was loaded with, so a change
 * someone else made to the same cell is reported instead of overwritten. `'key'` matches on
 * the identity alone (last write wins per cell).
 *
 * Without a key (the all-columns identity) every loaded value is matched exactly, and only
 * one row is touched even when identical rows exist: `LIMIT 1` on MySQL/MariaDB, the first
 * matching `(tableoid, ctid)` on PostgreSQL.
 *
 * Rows as written are read back in the same transaction: RETURNING on PostgreSQL (INSERT and
 * UPDATE) and MariaDB 10.5+ (INSERT); otherwise a SELECT by the row's new key, using
 * LAST_INSERT_ID() for an AUTO_INCREMENT key the insert left to the server.
 */

export interface PlanOptions {
  readonly dialect: SqlDialect;
  readonly table: TableRef;
  /** The table's columns (describeColumns): types, and the column list rows are read back in. */
  readonly columns: readonly ColumnInfo[];
  readonly identity: RowIdentity;
  /**
   * INSERT ... RETURNING is available: PostgreSQL, MariaDB 10.5+ (`capabilities().returning`).
   * Defaults to true except on MySQL.
   */
  readonly returning?: boolean;
  readonly conflictCheck?: 'changed-columns' | 'key';
}

export interface PlannedStatement extends SqlQuery {
  readonly kind: 'delete' | 'update' | 'insert';
  /** The row's key in the ChangeSet. */
  readonly key: RowKey;
  /** Names the row in messages: "id = 5", "new row 2". */
  readonly label: string;
  /** The statement with literals in place of its parameters. */
  readonly preview: string;
  /** The statement ends in RETURNING and yields the row as written. */
  readonly returnsRow: boolean;
  /** Reads the row as written back after the statement, when RETURNING is not available. */
  readonly readBack?: SqlQuery;
  /** Values the row is known to hold afterwards; DEFAULT cells are unknown and left out. */
  readonly knownValues: Readonly<Record<string, CellValue>>;
}

export interface ChangePlan {
  readonly dialect: SqlDialect;
  readonly table: TableRef;
  readonly identity: RowIdentity;
  /** The columns of rows read back, in order. */
  readonly columns: readonly string[];
  readonly statements: readonly PlannedStatement[];
  /** Every statement with literals, `;`-terminated, one per line: what Apply shows. */
  readonly previewSql: string;
}

function invalid(message: string): never {
  throw new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}

/** The statements that write `changes` to the table (see the module comment for the rules). */
export function planChanges(changes: ChangeSet, options: PlanOptions): ChangePlan {
  const { dialect, table, identity } = options;
  const byName = new Map(options.columns.map((c) => [c.name, c]));
  const column = (name: string): ColumnInfo =>
    byName.get(name) ?? invalid(`Unknown column ${name} in table ${table.name}`);
  const returning = options.returning ?? dialect !== 'mysql';
  const conflictCheck = options.conflictCheck ?? 'changed-columns';
  const names = options.columns.map((c) => c.name);
  const order = new Map(names.map((name, i) => [name, i]));
  const target = tableSql(table, dialect);
  const columnList = names.map((name) => ident(name, dialect)).join(', ');
  const returningClause = ` RETURNING ${columnList}`;
  const allColumns = identity.kind === 'all-columns';
  const keyed = identity.kind === 'primary-key' || identity.kind === 'unique';

  const deleted = changes.deletedRows();
  const edited = changes.editedRows();
  if (identity.kind === 'none' && deleted.length + edited.length > 0) {
    throw new QuerybaraError({
      code: 'READ_ONLY',
      message: 'The table has no primary or unique key, so rows cannot be changed or deleted',
      hint: 'Accept matching rows on all columns to edit this table',
    });
  }
  identity.columns.forEach(column);

  /** Conditions that find a row by `values`; `extra` columns are matched exactly too. */
  const match = (
    values: Readonly<Record<string, CellValue>>,
    extra: readonly string[],
    label: string,
  ): Fragment[] => {
    const parts: Fragment[][] = [];
    for (const name of identity.columns) {
      const value = values[name];
      if (value === undefined || isLargeValue(value)) {
        if (keyed) invalid(`Row ${label}: the key column ${name} was not loaded`);
        continue;
      }
      parts.push(compare(column(name), '=', value, dialect, { exact: allColumns }));
    }
    for (const name of extra) {
      if (identity.columns.includes(name)) continue;
      const value = values[name];
      const info = column(name);
      if (value === undefined || isLargeValue(value)) continue;
      if (info.kind === 'geometry' && dialect !== 'postgres') continue;
      parts.push(compare(info, '=', value, dialect, { exact: true }));
    }
    if (parts.length === 0) invalid(`Row ${label} has no values that can find it again`);
    return andAll(parts);
  };

  /** WHERE ... for one row, touching at most one row for the all-columns identity. */
  const whereOne = (condition: Fragment[]): { where: Fragment[]; limit: string } => {
    if (!allColumns) return { where: [' WHERE ', ...condition], limit: '' };
    if (dialect === 'postgres') {
      return {
        where: [
          ` WHERE (tableoid, ctid) = (SELECT tableoid, ctid FROM ${target} WHERE `,
          ...condition,
          ' LIMIT 1)',
        ],
        limit: '',
      };
    }
    return { where: [' WHERE ', ...condition], limit: ' LIMIT 1' };
  };

  const statements: PlannedStatement[] = [];
  const add = (
    kind: PlannedStatement['kind'],
    key: RowKey,
    label: string,
    fragments: readonly Fragment[],
    extra: {
      returnsRow: boolean;
      readBack?: SqlQuery;
      knownValues: Record<string, CellValue>;
    },
  ): void => {
    statements.push({
      kind,
      key,
      label,
      ...renderQuery(fragments, dialect),
      preview: renderLiterals(fragments, dialect),
      returnsRow: extra.returnsRow,
      ...(extra.readBack ? { readBack: extra.readBack } : {}),
      knownValues: extra.knownValues,
    });
  };

  /** SELECT of the row by its known values after the write, or undefined when unknown. */
  const readBackBy = (
    known: Readonly<Record<string, CellValue>>,
    generated: readonly string[] = [],
  ): SqlQuery | undefined => {
    if (!keyed && !allColumns) return undefined;
    const parts: Fragment[][] = [];
    for (const name of allColumns ? names : identity.columns) {
      if (generated.includes(name)) {
        parts.push([`${ident(name, dialect)} = LAST_INSERT_ID()`]);
        continue;
      }
      const value = known[name];
      if (value === undefined || isLargeValue(value)) {
        if (keyed) return undefined;
        continue;
      }
      if (allColumns && column(name).kind === 'geometry') continue;
      parts.push(compare(column(name), '=', value, dialect, { exact: allColumns }));
    }
    if (parts.length === 0) return undefined;
    return renderQuery(
      [
        `SELECT ${columnList} FROM ${target} WHERE `,
        ...andAll(parts),
        allColumns ? ' LIMIT 1' : '',
      ],
      dialect,
    );
  };

  for (const row of deleted) {
    const label = describeRow(identity, row.original);
    const { where, limit } = whereOne(match(row.original, [], label));
    add('delete', row.key, label, [`DELETE FROM ${target}`, ...where, limit], {
      returnsRow: false,
      knownValues: {},
    });
  }

  for (const row of edited) planUpdate(row);
  changes.insertedRows().forEach((row, index) => planInsert(row, index));

  function planUpdate(row: RowChange): void {
    const label = describeRow(identity, row.original);
    const edits = [...row.edits.entries()].sort(
      ([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0),
    );
    const known: Record<string, CellValue> = { ...row.original };
    const sets: Fragment[][] = [];
    for (const [name, value] of edits) {
      const info = column(name);
      if (isDefault(value)) {
        sets.push([`${ident(name, dialect)} = DEFAULT`]);
        delete known[name];
        continue;
      }
      if (info.readOnly !== undefined) invalid(`${name} cannot be edited: ${info.readOnly}`);
      sets.push([`${ident(name, dialect)} = `, param(value as CellValue)]);
      known[name] = value as CellValue;
    }
    const changed = conflictCheck === 'changed-columns' || allColumns ? edits.map(([n]) => n) : [];
    const { where, limit } = whereOne(match(row.original, changed, label));
    const pgReturning = dialect === 'postgres' && returning;
    add(
      'update',
      row.key,
      label,
      [
        `UPDATE ${target} SET `,
        ...joinFragments(sets, ', '),
        ...where,
        limit,
        pgReturning ? returningClause : '',
      ],
      pgReturning
        ? { returnsRow: true, knownValues: known }
        : { returnsRow: false, readBack: readBackBy(known), knownValues: known },
    );
  }

  function planInsert(row: RowInsert, index: number): void {
    const label = `new row ${index + 1}`;
    const cells = [...row.values.entries()]
      .filter((entry): entry is [string, CellValue] => !isDefault(entry[1]))
      .sort(([a], [b]) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const known: Record<string, CellValue> = {};
    for (const [name, value] of cells) {
      const info = column(name);
      if (info.readOnly !== undefined) invalid(`${name} cannot be set: ${info.readOnly}`);
      known[name] = value;
    }
    const head =
      cells.length === 0
        ? [
            dialect === 'postgres'
              ? `INSERT INTO ${target} DEFAULT VALUES`
              : `INSERT INTO ${target} () VALUES ()`,
          ]
        : [
            `INSERT INTO ${target} (${cells.map(([name]) => ident(name, dialect)).join(', ')}) VALUES (`,
            ...joinFragments(
              cells.map(([, value]) => [param(value)]),
              ', ',
            ),
            ')',
          ];
    if (returning) {
      add('insert', row.key, label, [...head, returningClause], {
        returnsRow: true,
        knownValues: known,
      });
      return;
    }
    const generated = identity.columns.filter((name) => {
      const value = known[name];
      return (value === undefined || value === null) && column(name).autoIncrement;
    });
    const readBack = keyed ? readBackBy(known, generated) : undefined;
    add('insert', row.key, label, head, {
      returnsRow: false,
      ...(readBack ? { readBack } : {}),
      knownValues: known,
    });
  }

  return {
    dialect,
    table,
    identity,
    columns: names,
    statements,
    previewSql: statements.map((s) => `${s.preview};`).join('\n'),
  };
}
