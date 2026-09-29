import { JoineryError, type CellValue, type QueryParams, type SqlDialect } from '@joinery/core';
import {
  analyzeStatement,
  decideSafety,
  findParameters,
  parameterNames,
  splitStatements,
  statementAt,
  type ConfirmationReason,
  type ParameterStyle,
  type SafetyDecision,
  type SafetyPolicy,
  type SqlStatement,
  type StatementAnalysis,
} from '@joinery/sql-tools';

/**
 * Turns an editor action (Run all, Run statement at cursor, Run selection; spec §6) into the
 * statements to run, with the safety decision for each and the parameter values to ask for.
 * Pure: the query runner shows the dialogs and executes.
 */

export type RunMode = 'all' | 'statement' | 'selection';

export interface RunRequest {
  readonly text: string;
  readonly dialect: SqlDialect;
  readonly mode: RunMode;
  /** Cursor offset in `text`, for `statement`. */
  readonly cursor?: number;
  /** Selected range in `text`, for `selection`; an empty one falls back to the cursor. */
  readonly selection?: { readonly start: number; readonly end: number };
  readonly policy: SafetyPolicy;
}

export interface PlannedParameter {
  /** Key of the value in the prompt answers; named parameters share one key across the plan. */
  readonly key: string;
  readonly style: ParameterStyle;
  /** `name`, `1`... as sql-tools reports it. */
  readonly name: string;
}

export interface PlannedStatement {
  /** 0-based position in the plan. */
  readonly index: number;
  readonly text: string;
  /** Absolute offsets in the editor text. */
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly analysis: StatementAnalysis;
  readonly decision: SafetyDecision;
  readonly parameters: readonly PlannedParameter[];
}

export interface ParameterPrompt {
  readonly key: string;
  /** What the prompt shows, e.g. ":id" or "$1 (statement 2)". */
  readonly label: string;
}

export interface RunPlan {
  readonly statements: readonly PlannedStatement[];
  /** The first statement a read-only profile refuses; when set, nothing runs. */
  readonly refused: PlannedStatement | undefined;
  /** Statements that ask before running, with why. */
  readonly confirmations: readonly {
    readonly statement: PlannedStatement;
    readonly reasons: readonly ConfirmationReason[];
  }[];
  /** Values to ask for, in order of first use. */
  readonly parameters: readonly ParameterPrompt[];
  /** A problem found before running (mixed placeholder styles), with its absolute offset. */
  readonly problem: { readonly message: string; readonly position: number | undefined } | undefined;
}

function pick(request: RunRequest): { statements: SqlStatement[]; offset: number } {
  const { text, dialect } = request;
  if (request.mode === 'selection' && request.selection) {
    const { start, end } = request.selection;
    if (end > start) {
      return { statements: splitStatements(text.slice(start, end), dialect), offset: start };
    }
  }
  const all = splitStatements(text, dialect);
  if (request.mode === 'all') return { statements: all, offset: 0 };
  const cursor = request.mode === 'selection' ? request.selection?.start : request.cursor;
  const current = statementAt(all, cursor ?? 0);
  return { statements: current ? [current] : [], offset: 0 };
}

function keyOf(style: ParameterStyle, name: string, index: number): string {
  return style === 'named' ? `:${name}` : `${index}:${style === 'numbered' ? '$' : '?'}${name}`;
}

function labelOf(style: ParameterStyle, name: string, index: number, many: boolean): string {
  if (style === 'named') return `:${name}`;
  const base = style === 'numbered' ? `$${name}` : `? #${name}`;
  return many ? `${base} (statement ${index + 1})` : base;
}

export function buildRunPlan(request: RunRequest): RunPlan {
  const { statements: picked, offset } = pick(request);
  const many = picked.length > 1;
  const prompts = new Map<string, ParameterPrompt>();
  let problem: RunPlan['problem'];

  const statements = picked.map((statement, index): PlannedStatement => {
    const analysis = analyzeStatement(statement.text, request.dialect);
    let parameters: PlannedParameter[] = [];
    try {
      const found = findParameters(statement.text, request.dialect);
      const names = parameterNames(found);
      const style = found[0]?.style;
      if (style !== undefined) {
        parameters = names.map((name) => ({ key: keyOf(style, name, index), style, name }));
      }
    } catch (error) {
      problem ??= {
        message: error instanceof Error ? error.message : String(error),
        position:
          error instanceof JoineryError && error.position !== undefined
            ? offset + statement.start + error.position
            : undefined,
      };
    }
    for (const parameter of parameters) {
      if (!prompts.has(parameter.key)) {
        prompts.set(parameter.key, {
          key: parameter.key,
          label: labelOf(parameter.style, parameter.name, index, many),
        });
      }
    }
    return {
      index,
      text: statement.text,
      start: offset + statement.start,
      end: offset + statement.end,
      line: statement.line,
      analysis,
      decision: decideSafety(analysis, request.policy),
      parameters,
    };
  });

  const refused = statements.find((s) => s.decision.action === 'refuse');
  const confirmations = statements.flatMap((statement) =>
    statement.decision.action === 'confirm'
      ? [{ statement, reasons: statement.decision.reasons }]
      : [],
  );
  return { statements, refused, confirmations, parameters: [...prompts.values()], problem };
}

/**
 * The values for one statement from the prompt answers, in the shape bindParameters takes:
 * a record for named parameters, an array (by number or ordinal) otherwise.
 */
export function parameterValues(
  statement: PlannedStatement,
  answers: ReadonlyMap<string, CellValue>,
): QueryParams | undefined {
  if (statement.parameters.length === 0) return undefined;
  const value = (key: string): CellValue => answers.get(key) ?? null;
  if (statement.parameters[0]?.style === 'named') {
    return Object.fromEntries(statement.parameters.map((p) => [p.name, value(p.key)]));
  }
  const values: CellValue[] = [];
  for (const parameter of statement.parameters) {
    values[Number(parameter.name) - 1] = value(parameter.key);
  }
  return Array.from(values, (v) => v ?? null);
}

/** Human wording for a confirmation reason, for the safety dialog. */
export function describeReason(reason: ConfirmationReason): string {
  switch (reason) {
    case 'update-without-where':
      return 'UPDATE without a WHERE clause changes every row';
    case 'delete-without-where':
      return 'DELETE without a WHERE clause removes every row';
    case 'drop':
      return 'Drops an object or its data';
    case 'truncate':
      return 'Truncates a table (removes every row)';
    case 'alter':
      return 'Alters a schema object';
    case 'explain-analyze':
      return 'EXPLAIN ANALYZE executes the statement';
    case 'unknown-effects':
      return 'Calls a routine that may write anything';
    case 'locks':
      return 'Takes locks';
    case 'server-config':
      return 'Changes server-wide settings';
    case 'write':
      return 'Writes on a connection that confirms every write';
  }
}
