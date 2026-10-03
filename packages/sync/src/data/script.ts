import type { CellValue, ColumnKind, SqlDialect } from '@querybara/core';
import { QuerybaraError } from '@querybara/core';
import { quoteIdent } from '@querybara/sql-tools';

import type { RowDiff } from './merge';
import { columnIndex } from './merge';
import { sqlLiteral, tableName } from './sql';
import type { TableRef } from './sql';

/**
 * Data sync script generation (spec §13, data sync step 7): batched DELETE, UPDATE and INSERT
 * statements that make the target table match the source for the selected actions.
 */
export interface DataSyncOptions {
  /** Dialect of the target. */
  readonly dialect: SqlDialect;
  /** The target table. */
  readonly table: TableRef;
  /** Key columns (target names; matched case-insensitively against the row column lists). */
  readonly keyColumns: readonly string[];
  /** Column order of `RowDiff.sourceRow`. */
  readonly sourceColumns: readonly string[];
  /** Column order of `RowDiff.targetRow` (and the target table's columns). */
  readonly targetColumns: readonly string[];
  /** Target columns to write; default every target column the source also has. */
  readonly columns?: readonly string[];
  readonly ignoreColumns?: readonly string[];
  /** Which actions to script; all by default. */
  readonly actions?: {
    readonly insert?: boolean;
    readonly update?: boolean;
    readonly delete?: boolean;
  };
  /** Rows per INSERT or DELETE statement (default 500). */
  readonly batchSize?: number;
  /** Target column kinds, for literals that need coercion (PostgreSQL booleans). */
  readonly targetKinds?: Readonly<Record<string, ColumnKind>>;
  /** Wrap the script in a transaction (default true; DML is transactional on both families). */
  readonly transaction?: boolean;
  /** MySQL: SET FOREIGN_KEY_CHECKS = 0; PostgreSQL: session_replication_role = replica (superuser). */
  readonly disableForeignKeyChecks?: boolean;
  /** PostgreSQL: disable user triggers on the table while applying (needs table ownership). */
  readonly disableTriggers?: boolean;
}

/** A generated data sync script. */
export interface DataSyncScript {
  /** Plain statements, in order, for a driver to run. */
  readonly statements: readonly string[];
  /** The same statements as a script. */
  readonly text: string;
  readonly counts: { readonly insert: number; readonly update: number; readonly delete: number };
  readonly warnings: readonly string[];
}

/**
 * Builds statements incrementally for large diffs: `add` returns statements as batches fill,
 * `finish` flushes the rest. Within a flush deletes come first, then updates, then inserts, so
 * a key that only changed case under a case-insensitive collation is removed before it is
 * re-inserted.
 */
export class DataSyncScriptBuilder {
  private readonly deletes: CellValue[][] = [];
  private readonly updates: RowDiff[] = [];
  private readonly inserts: RowDiff[] = [];
  private readonly writeColumns: { name: string; source: number; target: number }[];
  private readonly sourceKey: number[];
  private readonly targetKey: number[];
  private readonly batchSize: number;
  private readonly name: string;
  readonly counts = { insert: 0, update: 0, delete: 0 };

  constructor(private readonly options: DataSyncOptions) {
    const { dialect, sourceColumns, targetColumns } = options;
    this.batchSize = Math.max(1, options.batchSize ?? 500);
    this.name = tableName(options.table, dialect);
    const ignored = new Set((options.ignoreColumns ?? []).map((c) => c.toLowerCase()));
    this.writeColumns = (options.columns ?? targetColumns)
      .filter((c) => !ignored.has(c.toLowerCase()))
      .map((name) => ({
        name,
        source: columnIndex(sourceColumns, name),
        target: columnIndex(targetColumns, name),
      }))
      .filter((c) => c.source !== -1 && c.target !== -1)
      .map((c) => ({ ...c, name: targetColumns[c.target]! }));
    this.sourceKey = options.keyColumns.map((k) => columnIndex(sourceColumns, k));
    this.targetKey = options.keyColumns.map((k) => columnIndex(targetColumns, k));
    if (this.targetKey.includes(-1)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'A key column is missing from the target columns',
      });
    }
  }

  private literal(value: CellValue, column: string): string {
    return sqlLiteral(value, this.options.dialect, this.options.targetKinds?.[column]);
  }

  private keyColumnName(i: number): string {
    return this.options.targetColumns[this.targetKey[i]!]!;
  }

  private keyValues(diff: RowDiff): CellValue[] {
    if (diff.targetRow !== undefined) return this.targetKey.map((i) => diff.targetRow![i] ?? null);
    return this.sourceKey.map((i) => (i === -1 ? null : (diff.sourceRow![i] ?? null)));
  }

  private keyTuple(values: readonly CellValue[]): string {
    const literals = values.map((v, i) => this.literal(v, this.keyColumnName(i)));
    return literals.length === 1 ? literals[0]! : `(${literals.join(', ')})`;
  }

  private keyMatch(values: readonly CellValue[]): string {
    return values
      .map(
        (v, i) =>
          `${quoteIdent(this.keyColumnName(i), this.options.dialect)} = ${this.literal(v, this.keyColumnName(i))}`,
      )
      .join(' AND ');
  }

  private deleteStatement(): string {
    const keys = this.targetKey.map((_k, i) =>
      quoteIdent(this.keyColumnName(i), this.options.dialect),
    );
    const head = keys.length === 1 ? keys[0]! : `(${keys.join(', ')})`;
    const tuples = this.deletes.splice(0).map((values) => this.keyTuple(values));
    return `DELETE FROM ${this.name} WHERE ${head} IN (${tuples.join(', ')})`;
  }

  private updateStatements(): string[] {
    const keySet = new Set(this.targetKey.map((_k, i) => this.keyColumnName(i).toLowerCase()));
    const out: string[] = [];
    for (const diff of this.updates.splice(0)) {
      const changed = diff.changedColumns?.map((c) => c.toLowerCase());
      const sets = this.writeColumns
        .filter(
          (c) =>
            !keySet.has(c.name.toLowerCase()) &&
            (changed === undefined || changed.includes(c.name.toLowerCase())),
        )
        .map(
          (c) =>
            `${quoteIdent(c.name, this.options.dialect)} = ${this.literal(diff.sourceRow?.[c.source] ?? null, c.name)}`,
        );
      if (sets.length === 0) continue;
      out.push(
        `UPDATE ${this.name} SET ${sets.join(', ')} WHERE ${this.keyMatch(this.keyValues(diff))}`,
      );
    }
    return out;
  }

  private insertStatement(): string {
    const cols = this.writeColumns.map((c) => quoteIdent(c.name, this.options.dialect)).join(', ');
    const rows = this.inserts
      .splice(0)
      .map(
        (diff) =>
          `(${this.writeColumns.map((c) => this.literal(diff.sourceRow?.[c.source] ?? null, c.name)).join(', ')})`,
      );
    return `INSERT INTO ${this.name} (${cols}) VALUES\n${rows.join(',\n')}`;
  }

  /** Queues one row difference; returns the statements of any batch it completed. */
  add(diff: RowDiff): string[] {
    const actions = this.options.actions ?? {};
    if (diff.action === 'delete' && actions.delete !== false) {
      this.deletes.push(this.keyValues(diff));
      this.counts.delete++;
      if (this.deletes.length >= this.batchSize) return [this.deleteStatement()];
    } else if (diff.action === 'update' && actions.update !== false) {
      this.updates.push(diff);
      this.counts.update++;
      if (this.updates.length >= this.batchSize) return this.updateStatements();
    } else if (diff.action === 'insert' && actions.insert !== false) {
      this.inserts.push(diff);
      this.counts.insert++;
      if (this.inserts.length >= this.batchSize) return [this.insertStatement()];
    }
    return [];
  }

  /** Statements for everything still queued. */
  flush(): string[] {
    const out: string[] = [];
    if (this.deletes.length > 0) out.push(this.deleteStatement());
    out.push(...this.updateStatements());
    if (this.inserts.length > 0 && this.writeColumns.length > 0) out.push(this.insertStatement());
    this.inserts.length = 0;
    return out;
  }

  /** Statements to run before the changes (transaction, checks off). */
  prologue(): string[] {
    const { dialect } = this.options;
    const out: string[] = [];
    if (this.options.transaction !== false)
      out.push(dialect === 'postgres' ? 'BEGIN' : 'START TRANSACTION');
    if (this.options.disableForeignKeyChecks) {
      out.push(
        dialect === 'postgres'
          ? 'SET LOCAL session_replication_role = replica'
          : 'SET FOREIGN_KEY_CHECKS = 0',
      );
    }
    if (this.options.disableTriggers && dialect === 'postgres')
      out.push(`ALTER TABLE ${this.name} DISABLE TRIGGER USER`);
    return out;
  }

  /** Statements to run after the changes. */
  epilogue(): string[] {
    const { dialect } = this.options;
    const out: string[] = [];
    if (this.options.disableTriggers && dialect === 'postgres')
      out.push(`ALTER TABLE ${this.name} ENABLE TRIGGER USER`);
    if (this.options.disableForeignKeyChecks && dialect !== 'postgres')
      out.push('SET FOREIGN_KEY_CHECKS = 1');
    if (this.options.transaction !== false) out.push('COMMIT');
    return out;
  }
}

/**
 * The whole sync script for a set of row differences held in memory. Deletes run first, then
 * updates, then inserts. For streaming very large diffs use `DataSyncScriptBuilder` directly.
 */
export function generateDataSyncScript(
  diffs: Iterable<RowDiff>,
  options: DataSyncOptions,
): DataSyncScript {
  const builder = new DataSyncScriptBuilder({ ...options, batchSize: options.batchSize ?? 500 });
  const all = [...diffs];
  const ordered = [
    ...all.filter((d) => d.action === 'delete'),
    ...all.filter((d) => d.action === 'update'),
    ...all.filter((d) => d.action === 'insert'),
  ];
  const body: string[] = [];
  for (const diff of ordered) body.push(...builder.add(diff));
  body.push(...builder.flush());
  const warnings: string[] = [];
  if (options.disableTriggers && options.dialect !== 'postgres') {
    warnings.push(
      'MySQL and MariaDB cannot disable triggers per session; triggers run while applying',
    );
  }
  if (options.disableForeignKeyChecks && options.dialect === 'postgres') {
    warnings.push('session_replication_role needs superuser and also skips user triggers');
  }
  const statements = body.length > 0 ? [...builder.prologue(), ...body, ...builder.epilogue()] : [];
  return {
    statements,
    text: statements.length > 0 ? `${statements.map((s) => `${s};`).join('\n')}\n` : '',
    counts: { ...builder.counts },
    warnings,
  };
}
