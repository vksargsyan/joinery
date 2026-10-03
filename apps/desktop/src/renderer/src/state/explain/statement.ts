import type { SqlDialect } from '@querybara/core';

import type { PlannedStatement, RunPlan } from '../run-plan';

/**
 * What Explain acts on (spec §6): exactly one statement, the one at the cursor or the selection,
 * and what the ANALYZE confirmation says rolling back cannot undo. Pure.
 */

/** What rolling back cannot undo, per engine, for the ANALYZE confirmation. */
export const ANALYZE_WRITE_WARNING: Readonly<Record<SqlDialect, string>> = {
  postgres:
    'EXPLAIN ANALYZE runs the statement to measure it. Querybara runs it inside a transaction (a savepoint when one is open) and rolls it back, so its changes are not kept. Triggers still fire, and sequences it advances stay advanced.',
  mysql:
    'EXPLAIN ANALYZE runs the statement to measure it. Querybara runs it inside a transaction (a savepoint when one is open) and rolls it back. Changes to non-transactional tables (MyISAM, MEMORY) cannot be rolled back and are kept.',
  mariadb:
    'ANALYZE runs the statement to measure it. Querybara runs it inside a transaction (a savepoint when one is open) and rolls it back. Changes to non-transactional tables (MyISAM, Aria, MEMORY) cannot be rolled back and are kept.',
};

export interface ExplainRequest {
  readonly analyze: boolean;
  /** PostgreSQL BUFFERS; the tab's last choice (on by default) when left out. */
  readonly buffers?: boolean;
}

/** Why the statement cannot be explained, or the single statement to explain. */
export function pickExplainStatement(
  plan: RunPlan,
): { readonly statement: PlannedStatement } | { readonly error: string } {
  if (plan.statements.length === 0) {
    return { error: 'Put the cursor in a statement, or select one, to explain it.' };
  }
  if (plan.statements.length > 1) {
    return { error: 'Explain works on one statement: select just one, or clear the selection.' };
  }
  const statement = plan.statements[0]!;
  if (statement.analysis.kind === 'explain') {
    return {
      error:
        'The statement is an EXPLAIN already: run it for the server output, or remove EXPLAIN to see the plan here.',
    };
  }
  return { statement };
}
