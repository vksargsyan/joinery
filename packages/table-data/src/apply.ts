import { QuerybaraError, cancelledError, type CellValue, type Session } from '@querybara/core';

import { rowKeyAt, rowKeyOf, type RowKey } from './identity';
import type { ChangePlan, PlannedStatement } from './plan';
import { runQuery, type RunOptions, type StatementResult } from './session';

/**
 * Runs a ChangePlan in one transaction (spec §7: Apply runs the generated SQL in one
 * transaction). Every statement must touch exactly one row; an UPDATE or DELETE that touches
 * none means the row was changed or deleted since it was loaded, so everything is rolled back
 * and a CONFLICT error names the row. Any other failure also rolls back and names the row.
 *
 * On a session already inside a transaction (the SQL editor's manual mode) the plan runs
 * inside a savepoint instead, and the outer transaction stays open either way.
 */

export interface AppliedRow {
  readonly kind: 'insert' | 'update' | 'delete';
  /** The row's key in the ChangeSet. */
  readonly key: RowKey;
  /** The row's key after the write (it changes when a key column was edited), when known. */
  readonly newKey?: RowKey;
  /** The row as written, in `plan.columns` order; null for deletes or when it could not be read. */
  readonly row: readonly CellValue[] | null;
}

export interface ApplyResult {
  readonly rows: readonly AppliedRow[];
}

const SAVEPOINT = 'querybara_apply';

function withRow(statement: PlannedStatement, error: unknown): unknown {
  if (
    !(error instanceof QuerybaraError) ||
    error.code === 'CANCELLED' ||
    error.code === 'CONFLICT'
  ) {
    return error;
  }
  const verb =
    statement.kind === 'insert' ? 'insert' : statement.kind === 'update' ? 'update' : 'delete';
  const data = error.toJSON();
  return new QuerybaraError(
    {
      ...data,
      message: `Could not ${verb} ${statement.kind === 'insert' ? statement.label : `row ${statement.label}`}: ${error.message}`,
      detail: data.detail ?? statement.preview,
    },
    { cause: error },
  );
}

function conflict(statement: PlannedStatement, touched: number): QuerybaraError {
  const verb = statement.kind === 'delete' ? 'deleted' : 'updated';
  return new QuerybaraError({
    code: 'CONFLICT',
    message:
      touched === 0
        ? `Row ${statement.label} was changed or deleted by someone else since it was loaded; nothing was saved`
        : `Row ${statement.label} matched ${touched} rows instead of one; nothing was saved`,
    detail: `${statement.preview}\n-- would have ${verb} ${touched} rows`,
    hint: 'Refresh the data and make your changes again',
  });
}

/**
 * Runs `plan` through `session` in one transaction (or savepoint) and returns each row as
 * written; throws CONFLICT, or the failing statement's error naming the row, after rolling back.
 */
export async function applyChanges(
  session: Session,
  plan: ChangePlan,
  options: RunOptions = {},
): Promise<ApplyResult> {
  if (plan.statements.length === 0) return { rows: [] };
  const signal = options.signal;
  if (signal?.aborted) throw cancelledError();
  const run = (sql: string): Promise<unknown> => runQuery(session, { sql, params: [] });
  const nested = session.inTransaction;
  if (nested) await run(`SAVEPOINT ${SAVEPOINT}`);
  else if (session.begin) await session.begin();
  else await run(plan.dialect === 'postgres' ? 'BEGIN' : 'START TRANSACTION');

  const applied: AppliedRow[] = [];
  try {
    for (const statement of plan.statements) {
      if (signal?.aborted) throw cancelledError();
      let result: StatementResult;
      try {
        result = await runQuery(session, statement, signal ? { signal } : {});
      } catch (error) {
        throw withRow(statement, error);
      }
      const touched = result.rowsAffected ?? (statement.returnsRow ? result.rows.length : 0);
      if (touched !== 1) throw conflict(statement, touched);
      let row: CellValue[] | null = statement.returnsRow ? (result.rows[0] ?? null) : null;
      if (statement.readBack) {
        const read = await runQuery(session, statement.readBack, signal ? { signal } : {});
        row = read.rows[0] ?? null;
      }
      const newKey =
        statement.kind === 'delete'
          ? null
          : row
            ? rowKeyAt(plan.identity, plan.columns, row)
            : plan.identity.columns.every((name) => name in statement.knownValues)
              ? rowKeyOf(plan.identity, statement.knownValues)
              : null;
      applied.push({
        kind: statement.kind,
        key: statement.key,
        ...(newKey !== null ? { newKey } : {}),
        row,
      });
    }
  } catch (error) {
    try {
      if (nested) {
        await run(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
        await run(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      } else if (session.rollback) await session.rollback();
      else await run('ROLLBACK');
    } catch {
      // The original error matters more; a broken connection rolls back on its own.
    }
    throw error;
  }
  if (nested) await run(`RELEASE SAVEPOINT ${SAVEPOINT}`);
  else if (session.commit) await session.commit();
  else await run('COMMIT');
  return { rows: applied };
}
