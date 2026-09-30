import {
  emptyQueryModel,
  type Condition,
  type CriteriaGroup,
  type CriteriaOperator,
  type Criterion,
  type QueryExpr,
  type QueryJoin,
  type QueryModel,
  type QueryTable,
  type SelectItem,
} from '../../src';

/** Terse builders for query models in tests. */

let seq = 0;
const id = (prefix: string): string => `${prefix}${++seq}`;

export function model(parts: Partial<QueryModel>): QueryModel {
  return { ...emptyQueryModel(), ...parts };
}

export function table(tableId: string, name: string, extra: Partial<QueryTable> = {}): QueryTable {
  return { id: tableId, name, ...extra };
}

export function join(
  left: string,
  right: string,
  pairs: [string, string][],
  type: QueryJoin['type'] = 'inner',
): QueryJoin {
  return {
    id: id('j'),
    type,
    left,
    right,
    conditions: pairs.map(([l, r]) => ({ left: l, operator: '=', right: r })),
  };
}

export const col = (column: string, tableId?: string): QueryExpr => ({
  kind: 'column',
  column,
  ...(tableId === undefined ? {} : { table: tableId }),
});
export const str = (value: string): QueryExpr => ({ kind: 'string', value });
export const num = (value: string): QueryExpr => ({ kind: 'number', value });
export const bool = (value: boolean): QueryExpr => ({ kind: 'boolean', value });
export const param = (text: string): QueryExpr => ({ kind: 'parameter', text });
export const raw = (sql: string): QueryExpr => ({ kind: 'raw', sql });
export const count = (arg?: QueryExpr, distinct?: boolean): QueryExpr => ({
  kind: 'aggregate',
  fn: 'count',
  ...(arg === undefined ? {} : { arg }),
  ...(distinct ? { distinct } : {}),
});

export function item(expr: QueryExpr, alias?: string): SelectItem {
  return { kind: 'expr', id: id('c'), expr, ...(alias === undefined ? {} : { alias }) };
}

export function star(tableId?: string): SelectItem {
  return { kind: 'star', id: id('c'), ...(tableId === undefined ? {} : { table: tableId }) };
}

export function cond(
  left: QueryExpr,
  operator: CriteriaOperator,
  ...values: QueryExpr[]
): Condition {
  return { kind: 'condition', id: id('w'), left, operator, values };
}

export function custom(sql: string): Criterion {
  return { kind: 'custom', id: id('w'), sql };
}

export function and(...items: Criterion[]): CriteriaGroup {
  return { kind: 'group', id: id('g'), op: 'and', items };
}

export function or(...items: Criterion[]): CriteriaGroup {
  return { kind: 'group', id: id('g'), op: 'or', items };
}

export function not(group: CriteriaGroup): CriteriaGroup {
  return { ...group, negated: true };
}

/** A WHERE / HAVING root: AND of the items unless an OR group is given. */
export function root(...items: Criterion[]): CriteriaGroup {
  return { kind: 'group', id: 'where', op: 'and', items };
}

/** The model with ids and root ids blanked, to compare structure. */
export function shape(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => (key === 'id' ? undefined : inner)),
  );
}
