import {
  operatorInfo,
  referenceName,
  type ColumnExpr,
  type Condition,
  type CriteriaOperator,
  type QueryExpr,
  type QueryModel,
} from '@joinery/sql-tools';

import { entryOf, type BuilderCatalog } from './catalog';

/**
 * What the side panels offer (spec §8: columns, criteria, grouping, sort in side panels): the
 * columns to pick from, sensible default values and how a condition changes with its
 * operator. Pure.
 */

export interface ColumnOption {
  /** Stable key of the column expression, for select values. */
  readonly key: string;
  /** `table.column`, or the column alone when the query has one table. */
  readonly label: string;
  readonly expr: ColumnExpr;
  readonly dataType?: string | undefined;
}

/** A stable key for an expression (select option values, list comparisons). */
export function exprKey(expr: QueryExpr): string {
  if (expr.kind === 'column') return `column\u0000${expr.table ?? ''}\u0000${expr.column}`;
  return JSON.stringify(expr);
}

/**
 * The columns of the model's tables, in table order, plus any column the model already uses
 * that the catalog does not list (so every current choice has an option).
 */
export function columnOptions(
  model: QueryModel,
  catalog: BuilderCatalog | undefined,
): ColumnOption[] {
  const options: ColumnOption[] = [];
  const seen = new Set<string>();
  const single = model.tables.length === 1;
  const push = (expr: ColumnExpr, dataType?: string): void => {
    const key = exprKey(expr);
    if (seen.has(key)) return;
    seen.add(key);
    const table = model.tables.find((t) => t.id === expr.table);
    const label = table && !single ? `${referenceName(table)}.${expr.column}` : expr.column;
    options.push({ key, label, expr, ...(dataType === undefined ? {} : { dataType }) });
  };
  for (const table of model.tables) {
    const entry = catalog && entryOf(catalog, table);
    for (const column of entry?.columns ?? []) {
      push({ kind: 'column', table: table.id, column: column.name }, column.dataType);
    }
  }
  const visit = (expr: QueryExpr): void => {
    if (expr.kind === 'column') push(expr);
    else if (expr.kind === 'aggregate' && expr.arg) visit(expr.arg);
  };
  for (const item of model.columns) if (item.kind === 'expr') visit(item.expr);
  for (const item of model.groupBy) visit(item.expr);
  for (const item of model.orderBy) visit(item.expr);
  const walk = (items: QueryModel['where']['items']): void => {
    for (const item of items) {
      if (item.kind === 'group') walk(item.items);
      else if (item.kind === 'condition') {
        visit(item.left);
        item.values.forEach(visit);
      }
    }
  };
  walk(model.where.items);
  walk(model.having.items);
  return options;
}

/** Output column names (select-list aliases) ORDER BY can sort by. */
export function aliasOptions(model: QueryModel): ColumnOption[] {
  return model.columns.flatMap((item) =>
    item.kind === 'expr' && item.alias !== undefined && item.alias !== ''
      ? [
          {
            key: exprKey({ kind: 'column', column: item.alias }),
            label: `${item.alias} (output)`,
            expr: { kind: 'column', column: item.alias },
          },
        ]
      : [],
  );
}

const NUMERIC = /int|numeric|decimal|real|double|float|serial|money|bit\b|year/i;
const BOOLEAN = /^bool|^tinyint\(1\)/i;

/** A starting value for a condition on a column of this type. */
export function defaultValue(dataType: string | undefined): QueryExpr {
  if (dataType !== undefined && BOOLEAN.test(dataType)) return { kind: 'boolean', value: true };
  if (dataType !== undefined && NUMERIC.test(dataType)) return { kind: 'number', value: '' };
  return { kind: 'string', value: '' };
}

/** The type of the column an expression is, when it is one. */
export function dataTypeOf(expr: QueryExpr, options: readonly ColumnOption[]): string | undefined {
  if (expr.kind !== 'column') return undefined;
  const key = exprKey(expr);
  return options.find((option) => option.key === key)?.dataType;
}

/** A condition with a new operator, its values padded or cut to what the operator takes. */
export function withOperator(
  condition: Condition,
  operator: CriteriaOperator,
  fallback: QueryExpr,
): Condition {
  const arity = operatorInfo(operator).arity;
  const count = arity === 'list' ? Math.max(1, condition.values.length) : arity;
  const values = Array.from({ length: count }, (_v, i) => condition.values[i] ?? fallback);
  return { ...condition, operator, values };
}
