import type { SqlDialect } from '@joinery/core';

/**
 * The visual query builder's model (spec §8): one SELECT as the builder shows it. It is plain
 * data (JSON-safe, no classes), so the desktop builder keeps it in a store and tests build it by
 * hand. `generateQuery` turns it into SQL and `parseQuery` reads the subset of SELECT it can
 * represent back into it; for every model, parsing the generated SQL generates the same SQL.
 *
 * Names are exact and unquoted (quoting happens when SQL is generated). Every list item carries
 * an `id` so the UI can key and edit it; ids only need to be unique within their list, and
 * parsing assigns fresh ones.
 */

export type JoinType = 'inner' | 'left' | 'right' | 'full';

export const JOIN_TYPES: readonly JoinType[] = ['inner', 'left', 'right', 'full'];

/** A table or view in FROM. */
export interface QueryTable {
  readonly id: string;
  /** PostgreSQL schema, or MySQL/MariaDB database; the name is unqualified without it. */
  readonly schema?: string | undefined;
  readonly name: string;
  readonly alias?: string | undefined;
}

export type ComparisonOperator = '=' | '<>' | '<' | '<=' | '>' | '>=';

export const COMPARISON_OPERATORS: readonly ComparisonOperator[] = [
  '=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
];

/** `left` is a column of the join's left table, `right` one of its right table. */
export interface JoinCondition {
  readonly left: string;
  readonly operator: ComparisonOperator;
  readonly right: string;
}

/**
 * A join drawn between two tables: `left <type> JOIN right ON <conditions ANDed>`. A pair of
 * tables has at most one join, with at least one condition. SQL places tables in model order,
 * so a join whose right table comes first is written the other way round (LEFT becomes RIGHT).
 */
export interface QueryJoin {
  readonly id: string;
  readonly type: JoinType;
  /** Table ids. */
  readonly left: string;
  readonly right: string;
  readonly conditions: readonly JoinCondition[];
}

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

export const AGGREGATE_FUNCTIONS: readonly AggregateFunction[] = [
  'count',
  'sum',
  'avg',
  'min',
  'max',
];

/**
 * A value or expression. `raw` is SQL the user typed (or the parser could not break down): it is
 * emitted as written, after `checkFragment` found it to be one self-contained expression.
 */
export type QueryExpr =
  /** A column; unqualified when `table` is unset (or a select-list alias in ORDER BY). */
  | { readonly kind: 'column'; readonly table?: string | undefined; readonly column: string }
  /** COUNT(*) when `arg` is unset. */
  | {
      readonly kind: 'aggregate';
      readonly fn: AggregateFunction;
      readonly distinct?: boolean | undefined;
      readonly arg?: QueryExpr | undefined;
    }
  | { readonly kind: 'string'; readonly value: string }
  /** Decimal number text, e.g. "-12.5" or "1e3". */
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  /** A placeholder the run prompts for: `:name`, `$1`, or `?` (MySQL/MariaDB). */
  | { readonly kind: 'parameter'; readonly text: string }
  | { readonly kind: 'raw'; readonly sql: string };

export type ColumnExpr = Extract<QueryExpr, { kind: 'column' }>;

export type SelectItem =
  /** `*`, or `t.*` for one table. */
  | { readonly kind: 'star'; readonly id: string; readonly table?: string | undefined }
  | {
      readonly kind: 'expr';
      readonly id: string;
      readonly expr: QueryExpr;
      readonly alias?: string | undefined;
    };

export type CriteriaOperator =
  | ComparisonOperator
  | 'like'
  | 'not like'
  | 'ilike'
  | 'not ilike'
  | 'in'
  | 'not in'
  | 'between'
  | 'not between'
  | 'is null'
  | 'is not null';

/** How many values an operator takes: none, one, two (BETWEEN) or a list (IN). */
export type OperatorArity = 0 | 1 | 2 | 'list';

export interface OperatorInfo {
  readonly operator: CriteriaOperator;
  /** What the UI shows, which is also the SQL written. */
  readonly label: string;
  readonly arity: OperatorArity;
  /** Only PostgreSQL has it. */
  readonly postgresOnly?: boolean;
}

export const CRITERIA_OPERATORS: readonly OperatorInfo[] = [
  { operator: '=', label: '=', arity: 1 },
  { operator: '<>', label: '<>', arity: 1 },
  { operator: '<', label: '<', arity: 1 },
  { operator: '<=', label: '<=', arity: 1 },
  { operator: '>', label: '>', arity: 1 },
  { operator: '>=', label: '>=', arity: 1 },
  { operator: 'like', label: 'LIKE', arity: 1 },
  { operator: 'not like', label: 'NOT LIKE', arity: 1 },
  { operator: 'ilike', label: 'ILIKE', arity: 1, postgresOnly: true },
  { operator: 'not ilike', label: 'NOT ILIKE', arity: 1, postgresOnly: true },
  { operator: 'in', label: 'IN', arity: 'list' },
  { operator: 'not in', label: 'NOT IN', arity: 'list' },
  { operator: 'between', label: 'BETWEEN', arity: 2 },
  { operator: 'not between', label: 'NOT BETWEEN', arity: 2 },
  { operator: 'is null', label: 'IS NULL', arity: 0 },
  { operator: 'is not null', label: 'IS NOT NULL', arity: 0 },
];

/** The operators a dialect offers. */
export function operatorsFor(dialect: SqlDialect): readonly OperatorInfo[] {
  return dialect === 'postgres'
    ? CRITERIA_OPERATORS
    : CRITERIA_OPERATORS.filter((info) => !info.postgresOnly);
}

export function operatorInfo(operator: CriteriaOperator): OperatorInfo {
  return CRITERIA_OPERATORS.find((info) => info.operator === operator)!;
}

/** `left <operator> values…`; the number of values follows the operator's arity. */
export interface Condition {
  readonly kind: 'condition';
  readonly id: string;
  readonly left: QueryExpr;
  readonly operator: CriteriaOperator;
  readonly values: readonly QueryExpr[];
}

/** A condition written as SQL (a boolean column, a function, anything the rows cannot show). */
export interface CustomCondition {
  readonly kind: 'custom';
  readonly id: string;
  readonly sql: string;
}

/** Items joined by AND or OR, in parentheses when nested; NOT (...) when negated. */
export interface CriteriaGroup {
  readonly kind: 'group';
  readonly id: string;
  readonly op: 'and' | 'or';
  readonly negated?: boolean | undefined;
  readonly items: readonly Criterion[];
}

export type Criterion = Condition | CustomCondition | CriteriaGroup;

export interface GroupItem {
  readonly id: string;
  readonly expr: QueryExpr;
}

export interface OrderItem {
  readonly id: string;
  readonly expr: QueryExpr;
  readonly direction: 'asc' | 'desc';
  /** PostgreSQL NULLS FIRST / LAST; the server default when unset. */
  readonly nulls?: 'first' | 'last' | undefined;
}

export interface QueryModel {
  readonly distinct: boolean;
  /** In FROM order: the first is the FROM table, the others are joined to it. */
  readonly tables: readonly QueryTable[];
  readonly joins: readonly QueryJoin[];
  /** The select list; empty selects `*`. */
  readonly columns: readonly SelectItem[];
  /** WHERE, as a root group (no parentheses of its own). */
  readonly where: CriteriaGroup;
  readonly groupBy: readonly GroupItem[];
  readonly having: CriteriaGroup;
  readonly orderBy: readonly OrderItem[];
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export function emptyGroup(id: string, op: 'and' | 'or' = 'and'): CriteriaGroup {
  return { kind: 'group', id, op, items: [] };
}

/** A model with nothing in it: `SELECT *` without FROM until a table is added. */
export function emptyQueryModel(): QueryModel {
  return {
    distinct: false,
    tables: [],
    joins: [],
    columns: [],
    where: emptyGroup('where'),
    groupBy: [],
    having: emptyGroup('having'),
    orderBy: [],
  };
}

/** The name a table's columns are qualified with: its alias, else its name. */
export function referenceName(table: QueryTable): string {
  return table.alias !== undefined && table.alias !== '' ? table.alias : table.name;
}

/** A problem generateQuery found in a model. Errors make SQL that cannot run as intended. */
export interface QueryIssue {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** The id of the table, join, item or criterion concerned, when there is one. */
  readonly id?: string | undefined;
}
