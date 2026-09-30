import { JoineryError, type CellValue, type SqlDialect } from '@joinery/core';

import { comparedAsText, type ColumnInfo } from './columns';
import {
  compare,
  ident,
  joinFragments,
  operand,
  param,
  type CompareOp,
  type Fragment,
} from './sql';

/**
 * The visual filter builder's model (spec §7): nested AND/OR groups of column conditions,
 * compiled server-side into a parameterised WHERE clause.
 *
 * Semantics follow SQL: `≠`, `<` and friends never match NULL (use `is null`); `= NULL` and
 * `≠ NULL` mean IS NULL / IS NOT NULL; `in` / `not in` handle a NULL in the list the way a
 * user expects (NULL matches NULL) instead of making NOT IN match nothing. Text operators
 * (contains, starts with, ends with) are case-insensitive unless `caseSensitive` is set:
 * ILIKE on PostgreSQL, LIKE under a case-insensitive collation on MySQL/MariaDB (the column's
 * own when it is `_ci`, otherwise utf8mb4_general_ci). Their operand is a plain string with
 * `%` and `_` escaped; `like` takes a pattern as typed.
 */

export const FILTER_OPERATORS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  'contains',
  'not-contains',
  'starts-with',
  'ends-with',
  'like',
  'not-like',
  'in',
  'not-in',
  'between',
  'is-null',
  'is-not-null',
  'is-empty',
  'is-not-empty',
  'is-true',
  'is-false',
  'json-contains',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export interface FilterCondition {
  readonly type: 'condition';
  readonly column: string;
  readonly operator: FilterOperator;
  /** Operand of comparison, text and JSON operators. */
  readonly value?: CellValue;
  /** Operands of `in` / `not-in`, and `[low, high]` for `between`. */
  readonly values?: readonly CellValue[];
  /** Text operators match case-insensitively unless this is set. */
  readonly caseSensitive?: boolean;
  /** Kept in the builder but left out of the query. */
  readonly disabled?: boolean;
}

export interface FilterGroup {
  readonly type: 'group';
  readonly combinator: 'and' | 'or';
  readonly children: readonly FilterNode[];
  readonly disabled?: boolean;
}

export type FilterNode = FilterCondition | FilterGroup;

/** A condition node; `value` is `values` for `in`, `not-in` and `between`. */
export function condition(
  column: string,
  operator: FilterOperator,
  value?: CellValue | readonly CellValue[],
  options: { readonly caseSensitive?: boolean } = {},
): FilterCondition {
  const base = { type: 'condition' as const, column, operator, ...options };
  if (Array.isArray(value)) return { ...base, values: value as readonly CellValue[] };
  return value === undefined ? base : { ...base, value: value as CellValue };
}

/** A group that matches when every child matches. */
export function and(...children: FilterNode[]): FilterGroup {
  return { type: 'group', combinator: 'and', children };
}

/** A group that matches when any child matches. */
export function or(...children: FilterNode[]): FilterGroup {
  return { type: 'group', combinator: 'or', children };
}

const COMPARISONS: readonly FilterOperator[] = ['=', '!=', '<', '<=', '>', '>='];
const TEXT: readonly FilterOperator[] = [
  'contains',
  'not-contains',
  'starts-with',
  'ends-with',
  'like',
  'not-like',
];

/**
 * The operators the filter builder offers for a column, in menu order. `is null` / `is not
 * null` are listed for nullable columns only, though they are accepted on any column.
 */
export function operatorsFor(column: ColumnInfo, dialect: SqlDialect): FilterOperator[] {
  const ops: FilterOperator[] = [];
  const textCompared = comparedAsText(column, dialect);
  switch (column.kind) {
    case 'string':
      ops.push(...COMPARISONS, ...TEXT, 'in', 'not-in', 'between', 'is-empty', 'is-not-empty');
      break;
    case 'enum':
    case 'uuid':
      ops.push('=', '!=', ...TEXT, 'in', 'not-in');
      break;
    case 'integer':
    case 'bigint':
    case 'decimal':
    case 'float':
      ops.push(...COMPARISONS, 'between', 'in', 'not-in');
      break;
    case 'boolean':
      ops.push('is-true', 'is-false', '=', '!=');
      break;
    case 'date':
    case 'time':
    case 'datetime':
    case 'timestamp':
    case 'interval':
      ops.push(...COMPARISONS, 'between', 'in', 'not-in', 'starts-with', 'contains');
      break;
    case 'json':
      ops.push('json-contains', 'contains', 'not-contains', '=', '!=');
      break;
    case 'binary':
      ops.push('=', '!=', 'is-empty', 'is-not-empty');
      break;
    case 'array':
      ops.push('=', '!=', 'contains', 'not-contains', 'is-empty', 'is-not-empty');
      break;
    case 'geometry':
      if (textCompared || dialect === 'postgres') ops.push('=', '!=', 'contains');
      break;
    default:
      ops.push('=', '!=', ...TEXT, 'in', 'not-in');
      break;
  }
  if (column.nullable) ops.push('is-null', 'is-not-null');
  return ops;
}

/** A problem with one condition, located by child indexes from the root group. */
export interface FilterIssue {
  readonly path: readonly number[];
  readonly column?: string;
  readonly message: string;
}

const LIKE_ESCAPE = '!';

/** Escapes LIKE wildcards with `!` (used with ESCAPE '!', which no sql_mode reinterprets). */
export function escapeLike(text: string): string {
  return text.replace(/[!%_]/g, (ch) => LIKE_ESCAPE + ch);
}

const PG_LIKE_TYPES = new Set([
  'text',
  'character varying',
  'varchar',
  'character',
  'char',
  'bpchar',
  'name',
  'citext',
]);

/** The column as text for LIKE, with the case rule applied (see the module comment). */
export function likeTarget(
  column: ColumnInfo,
  dialect: SqlDialect,
  caseSensitive: boolean,
): string {
  const name = ident(column.name, dialect);
  if (dialect === 'postgres') {
    const base = column.dataType
      .replace(/\([^)]*\)/, '')
      .trim()
      .toLowerCase();
    return column.kind === 'string' && PG_LIKE_TYPES.has(base) ? name : `${name}::text`;
  }
  const textual = column.kind === 'string' || column.kind === 'enum';
  const collation = textual ? column.collation?.toLowerCase() : undefined;
  if (!caseSensitive) {
    if (collation !== undefined && collation.endsWith('_ci')) return name;
    return `CONVERT(${name} USING utf8mb4) COLLATE utf8mb4_general_ci`;
  }
  if (collation !== undefined && /_(bin|cs)$/.test(collation)) return name;
  if (textual && column.charset !== undefined && column.charset !== 'binary') {
    return `${name} COLLATE ${column.charset}_bin`;
  }
  return `CONVERT(${name} USING utf8mb4) COLLATE utf8mb4_bin`;
}

/** `column [NOT] [I]LIKE pattern`, case rules applied; `escaped` patterns use ESCAPE '!'. */
export function textMatch(
  column: ColumnInfo,
  dialect: SqlDialect,
  pattern: string,
  options: { caseSensitive: boolean; negate: boolean; escaped: boolean },
): Fragment[] {
  const target = likeTarget(column, dialect, options.caseSensitive);
  const like =
    dialect === 'postgres' && !options.caseSensitive
      ? options.negate
        ? 'NOT ILIKE'
        : 'ILIKE'
      : options.negate
        ? 'NOT LIKE'
        : 'LIKE';
  const escape = options.escaped ? ` ESCAPE '${LIKE_ESCAPE}'` : '';
  return [`${target} ${like} `, param(pattern), escape];
}

function textOperand(value: CellValue | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean')
    return String(value);
  return undefined;
}

function emptyTest(column: ColumnInfo, dialect: SqlDialect, empty: boolean): string {
  const name = ident(column.name, dialect);
  if (dialect !== 'postgres') return `LENGTH(${name}) ${empty ? '=' : '>'} 0`;
  if (column.kind === 'binary') return `octet_length(${name}) ${empty ? '=' : '>'} 0`;
  if (column.kind === 'array') return `cardinality(${name}) ${empty ? '=' : '>'} 0`;
  return `${name} ${empty ? '=' : '<>'} ''`;
}

function inList(
  column: ColumnInfo,
  dialect: SqlDialect,
  values: readonly CellValue[],
  negate: boolean,
): Fragment[] {
  const name = ident(column.name, dialect);
  const target = comparedAsText(column, dialect) ? `${name}::text` : name;
  const present = values.filter((v) => v !== null);
  const hasNull = present.length < values.length;
  const list: Fragment[] =
    present.length === 0
      ? []
      : [
          `${target} ${negate ? 'NOT IN' : 'IN'} (`,
          ...joinFragments(
            present.map((v) =>
              comparedAsText(column, dialect) ? [param(v)] : operand(column, v, dialect),
            ),
            ', ',
          ),
          ')',
        ];
  if (!hasNull) return list.length > 0 ? list : [negate ? 'TRUE' : 'FALSE'];
  if (list.length === 0) return [`${name} ${negate ? 'IS NOT NULL' : 'IS NULL'}`];
  return negate
    ? ['(', ...list, ` AND ${name} IS NOT NULL)`]
    : ['(', ...list, ` OR ${name} IS NULL)`];
}

const COMPARE_OPS: Readonly<Partial<Record<FilterOperator, CompareOp>>> = {
  '=': '=',
  '!=': '<>',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
};

/** One condition's SQL, or an error message. The result is always a single atomic term. */
function conditionSql(
  node: FilterCondition,
  column: ColumnInfo,
  dialect: SqlDialect,
): Fragment[] | string {
  const op = node.operator;
  const allowed = operatorsFor(column, dialect);
  if (!allowed.includes(op) && op !== 'is-null' && op !== 'is-not-null') {
    return `"${op}" does not apply to ${column.kind} column ${column.name}`;
  }
  const name = ident(column.name, dialect);
  const caseSensitive = node.caseSensitive === true;
  const compareOp = COMPARE_OPS[op];
  if (compareOp !== undefined) {
    if (node.value === undefined) return `${column.name} ${op} needs a value`;
    if (node.value === null && compareOp !== '=' && compareOp !== '<>') {
      return `${column.name} ${op} NULL never matches; use "is null"`;
    }
    return compare(column, compareOp, node.value, dialect);
  }
  switch (op) {
    case 'contains':
    case 'not-contains':
    case 'starts-with':
    case 'ends-with': {
      const text = textOperand(node.value);
      if (text === undefined) return `${column.name} ${op} needs text to look for`;
      const escaped = escapeLike(text);
      const pattern =
        op === 'starts-with' ? `${escaped}%` : op === 'ends-with' ? `%${escaped}` : `%${escaped}%`;
      return textMatch(column, dialect, pattern, {
        caseSensitive,
        negate: op === 'not-contains',
        escaped: true,
      });
    }
    case 'like':
    case 'not-like': {
      const text = textOperand(node.value);
      if (text === undefined) return `${column.name} ${op} needs a pattern`;
      return textMatch(column, dialect, text, {
        caseSensitive,
        negate: op === 'not-like',
        escaped: false,
      });
    }
    case 'in':
    case 'not-in':
      if (node.values === undefined) return `${column.name} ${op} needs a list of values`;
      return inList(column, dialect, node.values, op === 'not-in');
    case 'between': {
      const [low, high] = node.values ?? [];
      if (node.values?.length !== 2 || low === undefined || high === undefined)
        return `${column.name} between needs two values`;
      if (low === null || high === null) return `${column.name} between cannot take NULL`;
      return [
        `${name} BETWEEN `,
        ...operand(column, low, dialect),
        ' AND ',
        ...operand(column, high, dialect),
      ];
    }
    case 'is-null':
      return [`${name} IS NULL`];
    case 'is-not-null':
      return [`${name} IS NOT NULL`];
    case 'is-empty':
    case 'is-not-empty':
      return [emptyTest(column, dialect, op === 'is-empty')];
    case 'is-true':
      return [`${name} IS TRUE`];
    case 'is-false':
      return [`${name} IS FALSE`];
    case 'json-contains': {
      const text = typeof node.value === 'string' ? node.value : undefined;
      try {
        if (text === undefined) throw new Error('missing');
        JSON.parse(text);
      } catch {
        return `${column.name} JSON contains needs a JSON value like {"key": 1}`;
      }
      if (dialect !== 'postgres') return ['JSON_CONTAINS(', name, ', ', param(text), ')'];
      const target = /^jsonb\b/i.test(column.dataType.trim()) ? name : `${name}::jsonb`;
      return [`${target} @> CAST(`, param(text), ' AS jsonb)'];
    }
    default:
      return `Unknown operator "${String(op)}"`;
  }
}

interface Compiled {
  readonly sql: Fragment[];
  /** Joins several terms with AND/OR: parenthesise it inside another group. */
  readonly compound: boolean;
}

function compileNode(
  node: FilterNode,
  columns: ReadonlyMap<string, ColumnInfo>,
  dialect: SqlDialect,
  path: number[],
  issues: FilterIssue[],
): Compiled | null {
  if (node.disabled) return null;
  if (node.type === 'condition') {
    const column = columns.get(node.column);
    if (!column) {
      issues.push({ path, column: node.column, message: `Unknown column ${node.column}` });
      return null;
    }
    const sql = conditionSql(node, column, dialect);
    if (typeof sql === 'string') {
      issues.push({ path, column: node.column, message: sql });
      return null;
    }
    return { sql, compound: false };
  }
  const parts = node.children
    .map((child, i) => compileNode(child, columns, dialect, [...path, i], issues))
    .filter((part): part is Compiled => part !== null);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!;
  return {
    sql: joinFragments(
      parts.map((part) => (part.compound ? ['(', ...part.sql, ')'] : part.sql)),
      node.combinator === 'and' ? ' AND ' : ' OR ',
    ),
    compound: true,
  };
}

/** Every problem in a filter, for the builder to highlight; empty when it compiles. */
export function validateFilter(
  filter: FilterNode,
  columns: readonly ColumnInfo[],
  dialect: SqlDialect,
): FilterIssue[] {
  const issues: FilterIssue[] = [];
  compileNode(filter, new Map(columns.map((c) => [c.name, c])), dialect, [], issues);
  return issues;
}

/**
 * The filter as SQL fragments, or null when nothing is enabled. Throws VALIDATION_FAILED with
 * the first problem (see `validateFilter` for all of them).
 */
export function compileFilter(
  filter: FilterNode | undefined,
  columns: readonly ColumnInfo[],
  dialect: SqlDialect,
): Compiled | null {
  if (filter === undefined) return null;
  const issues: FilterIssue[] = [];
  const compiled = compileNode(
    filter,
    new Map(columns.map((c) => [c.name, c])),
    dialect,
    [],
    issues,
  );
  const first = issues[0];
  if (first) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: `Invalid filter: ${first.message}`,
    });
  }
  return compiled;
}
