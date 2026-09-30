import {
  referenceName,
  type ComparisonOperator,
  type Criterion,
  type CriteriaGroup,
  type JoinCondition,
  type JoinType,
  type QueryExpr,
  type QueryJoin,
  type QueryModel,
  type QueryTable,
  type SelectItem,
} from '@joinery/sql-tools';

import { entryOf, proposeJoins, type BuilderCatalog, type CatalogEntry } from './catalog';

/**
 * The query builder's edits (spec §8), as pure functions from model to model: tables with
 * their foreign-key joins, column ticks, join editing, list items, the criteria tree, and
 * matching a parsed model to the one before so tables keep their ids (and places on the canvas).
 */

export type NewId = () => string;

// Tables

/**
 * Adds a catalog table: qualified with its schema (the MySQL database), aliased when its name is
 * taken, and joined to the tables already there that its foreign keys connect.
 */
export function addTable(
  model: QueryModel,
  catalog: BuilderCatalog,
  entry: CatalogEntry,
  newId: NewId,
): { readonly model: QueryModel; readonly tableId: string } {
  const taken = new Set(model.tables.map((table) => referenceName(table).toLowerCase()));
  let alias: string | undefined;
  if (taken.has(entry.name.toLowerCase())) {
    let n = 2;
    while (taken.has(`${entry.name}_${n}`.toLowerCase())) n++;
    alias = `${entry.name}_${n}`;
  }
  const table: QueryTable = {
    id: newId(),
    schema: entry.schema,
    name: entry.name,
    ...(alias === undefined ? {} : { alias }),
  };
  const added = { ...model, tables: [...model.tables, table] };
  const joins = proposeJoins(added, catalog, table.id, newId);
  return { model: { ...added, joins: [...added.joins, ...joins] }, tableId: table.id };
}

function exprUses(expr: QueryExpr, tableId: string): boolean {
  if (expr.kind === 'column') return expr.table === tableId;
  if (expr.kind === 'aggregate') return expr.arg !== undefined && exprUses(expr.arg, tableId);
  return false;
}

function criteriaWithout(
  group: CriteriaGroup,
  keep: (criterion: Criterion) => boolean,
): CriteriaGroup {
  return {
    ...group,
    items: group.items
      .filter(keep)
      .map((item) => (item.kind === 'group' ? criteriaWithout(item, keep) : item)),
  };
}

/** Removes a table with its joins and everything that refers to its columns. */
export function removeTable(model: QueryModel, tableId: string): QueryModel {
  const keep = (criterion: Criterion): boolean =>
    criterion.kind !== 'condition' ||
    (!exprUses(criterion.left, tableId) && !criterion.values.some((v) => exprUses(v, tableId)));
  return {
    ...model,
    tables: model.tables.filter((table) => table.id !== tableId),
    joins: model.joins.filter((join) => join.left !== tableId && join.right !== tableId),
    columns: model.columns.filter((item) =>
      item.kind === 'star' ? item.table !== tableId : !exprUses(item.expr, tableId),
    ),
    where: criteriaWithout(model.where, keep),
    groupBy: model.groupBy.filter((item) => !exprUses(item.expr, tableId)),
    having: criteriaWithout(model.having, keep),
    orderBy: model.orderBy.filter((item) => !exprUses(item.expr, tableId)),
  };
}

export function setAlias(model: QueryModel, tableId: string, alias: string): QueryModel {
  return {
    ...model,
    tables: model.tables.map((table) => {
      if (table.id !== tableId) return table;
      const { alias: _old, ...rest } = table;
      return alias.trim() === '' ? rest : { ...rest, alias: alias.trim() };
    }),
  };
}

// Column ticks

function isPlainColumn(item: SelectItem, tableId: string, column: string): boolean {
  return (
    item.kind === 'expr' &&
    item.expr.kind === 'column' &&
    item.expr.table === tableId &&
    item.expr.column === column
  );
}

/** Whether a table's column is ticked: a plain column item in the select list. */
export function isColumnSelected(model: QueryModel, tableId: string, column: string): boolean {
  return model.columns.some((item) => isPlainColumn(item, tableId, column));
}

export function isStarSelected(model: QueryModel, tableId: string): boolean {
  return model.columns.some((item) => item.kind === 'star' && item.table === tableId);
}

/** Ticks or unticks a column: adds it at the end of the select list, or removes it. */
export function toggleColumn(
  model: QueryModel,
  tableId: string,
  column: string,
  on: boolean,
  newId: NewId,
): QueryModel {
  if (!on) {
    return {
      ...model,
      columns: model.columns.filter((item) => !isPlainColumn(item, tableId, column)),
    };
  }
  if (isColumnSelected(model, tableId, column)) return model;
  const item: SelectItem = {
    kind: 'expr',
    id: newId(),
    expr: { kind: 'column', table: tableId, column },
  };
  return { ...model, columns: [...model.columns, item] };
}

/** Ticks or unticks `t.*`. */
export function toggleStar(
  model: QueryModel,
  tableId: string,
  on: boolean,
  newId: NewId,
): QueryModel {
  if (!on) {
    return {
      ...model,
      columns: model.columns.filter((item) => !(item.kind === 'star' && item.table === tableId)),
    };
  }
  if (isStarSelected(model, tableId)) return model;
  return { ...model, columns: [...model.columns, { kind: 'star', id: newId(), table: tableId }] };
}

// Joins

const FLIPPED: Readonly<Record<ComparisonOperator, ComparisonOperator>> = {
  '=': '=',
  '<>': '<>',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
};

/**
 * Joins two columns (a line drawn between them): a condition on the join the pair already has,
 * or a new INNER join from the first table to the second.
 */
export function connectColumns(
  model: QueryModel,
  from: { readonly table: string; readonly column: string },
  to: { readonly table: string; readonly column: string },
  newId: NewId,
): { readonly model: QueryModel; readonly joinId: string | undefined } {
  if (from.table === to.table) return { model, joinId: undefined };
  const existing = model.joins.find(
    (join) =>
      (join.left === from.table && join.right === to.table) ||
      (join.left === to.table && join.right === from.table),
  );
  if (existing) {
    const forward = existing.left === from.table;
    const condition: JoinCondition = forward
      ? { left: from.column, operator: '=', right: to.column }
      : { left: to.column, operator: '=', right: from.column };
    if (existing.conditions.some((c) => c.left === condition.left && c.right === condition.right)) {
      return { model, joinId: existing.id };
    }
    return {
      model: updateJoin(model, existing.id, (join) => ({
        ...join,
        conditions: [...join.conditions, condition],
      })),
      joinId: existing.id,
    };
  }
  const join: QueryJoin = {
    id: newId(),
    type: 'inner',
    left: from.table,
    right: to.table,
    conditions: [{ left: from.column, operator: '=', right: to.column }],
  };
  return { model: { ...model, joins: [...model.joins, join] }, joinId: join.id };
}

/** A new join between two tables, its first condition's columns still to pick. */
export function addJoin(model: QueryModel, left: string, right: string, newId: NewId): QueryModel {
  const join: QueryJoin = {
    id: newId(),
    type: 'inner',
    left,
    right,
    conditions: [{ left: '', operator: '=', right: '' }],
  };
  return { ...model, joins: [...model.joins, join] };
}

export function updateJoin(
  model: QueryModel,
  joinId: string,
  update: (join: QueryJoin) => QueryJoin,
): QueryModel {
  return { ...model, joins: model.joins.map((join) => (join.id === joinId ? update(join) : join)) };
}

export function setJoinType(model: QueryModel, joinId: string, type: JoinType): QueryModel {
  return updateJoin(model, joinId, (join) => ({ ...join, type }));
}

/** Swaps a join's sides: LEFT becomes RIGHT and every condition turns round. */
export function swapJoin(model: QueryModel, joinId: string): QueryModel {
  return updateJoin(model, joinId, (join) => ({
    ...join,
    type: join.type === 'left' ? 'right' : join.type === 'right' ? 'left' : join.type,
    left: join.right,
    right: join.left,
    conditions: join.conditions.map((c) => ({
      left: c.right,
      operator: FLIPPED[c.operator],
      right: c.left,
    })),
  }));
}

export function setJoinCondition(
  model: QueryModel,
  joinId: string,
  index: number,
  patch: Partial<JoinCondition>,
): QueryModel {
  return updateJoin(model, joinId, (join) => ({
    ...join,
    conditions: join.conditions.map((c, i) => (i === index ? { ...c, ...patch } : c)),
  }));
}

export function addJoinCondition(model: QueryModel, joinId: string): QueryModel {
  return updateJoin(model, joinId, (join) => ({
    ...join,
    conditions: [...join.conditions, { left: '', operator: '=', right: '' }],
  }));
}

/** Removes a condition; the join goes with its last one. */
export function removeJoinCondition(model: QueryModel, joinId: string, index: number): QueryModel {
  const join = model.joins.find((j) => j.id === joinId);
  if (!join) return model;
  if (join.conditions.length <= 1) return removeJoin(model, joinId);
  return updateJoin(model, joinId, (j) => ({
    ...j,
    conditions: j.conditions.filter((_c, i) => i !== index),
  }));
}

export function removeJoin(model: QueryModel, joinId: string): QueryModel {
  return { ...model, joins: model.joins.filter((join) => join.id !== joinId) };
}

// Lists (select items, GROUP BY, ORDER BY)

/** Moves the item with `id` by `delta` places, staying inside the list. */
export function moveItem<T extends { readonly id: string }>(
  list: readonly T[],
  id: string,
  delta: number,
): T[] {
  const from = list.findIndex((item) => item.id === id);
  const to = Math.max(0, Math.min(list.length - 1, from + delta));
  if (from < 0 || from === to) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export function replaceItem<T extends { readonly id: string }>(
  list: readonly T[],
  id: string,
  update: (item: T) => T,
): T[] {
  return list.map((item) => (item.id === id ? update(item) : item));
}

export function removeItem<T extends { readonly id: string }>(list: readonly T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

/** GROUP BY every plain column of the select list that is not grouped yet. */
export function groupBySelected(model: QueryModel, newId: NewId): QueryModel {
  const key = (expr: QueryExpr): string => JSON.stringify(expr);
  const grouped = new Set(model.groupBy.map((item) => key(item.expr)));
  const additions = model.columns.flatMap((item) =>
    item.kind === 'expr' && item.expr.kind === 'column' && !grouped.has(key(item.expr))
      ? [{ id: newId(), expr: item.expr }]
      : [],
  );
  return { ...model, groupBy: [...model.groupBy, ...additions] };
}

// Criteria

/** Applies `update` to the criterion with `id` anywhere in the tree (the root included). */
export function updateCriterion(
  group: CriteriaGroup,
  id: string,
  update: (criterion: Criterion) => Criterion,
): CriteriaGroup {
  if (group.id === id) {
    const updated = update(group);
    return updated.kind === 'group' ? updated : group;
  }
  return {
    ...group,
    items: group.items.map((item) => {
      if (item.id === id) return update(item);
      return item.kind === 'group' ? updateCriterion(item, id, update) : item;
    }),
  };
}

/** Adds a criterion at the end of the group with `groupId`. */
export function addCriterion(
  group: CriteriaGroup,
  groupId: string,
  criterion: Criterion,
): CriteriaGroup {
  return updateCriterion(group, groupId, (target) =>
    target.kind === 'group' ? { ...target, items: [...target.items, criterion] } : target,
  );
}

export function removeCriterion(group: CriteriaGroup, id: string): CriteriaGroup {
  return {
    ...group,
    items: group.items
      .filter((item) => item.id !== id)
      .map((item) => (item.kind === 'group' ? removeCriterion(item, id) : item)),
  };
}

/** Every condition in a tree, depth first. */
export function allCriteria(group: CriteriaGroup): Criterion[] {
  return group.items.flatMap((item) =>
    item.kind === 'group' ? [item, ...allCriteria(item)] : [item],
  );
}

// Matching a parsed model to the previous one

function tableKey(table: QueryTable): string {
  return [table.schema ?? '', table.name, table.alias ?? ''].join('\u0000');
}

function mapExpr(expr: QueryExpr, ids: ReadonlyMap<string, string>): QueryExpr {
  if (expr.kind === 'column' && expr.table !== undefined) {
    return { ...expr, table: ids.get(expr.table) ?? expr.table };
  }
  if (expr.kind === 'aggregate' && expr.arg !== undefined)
    return { ...expr, arg: mapExpr(expr.arg, ids) };
  return expr;
}

function mapCriteria(group: CriteriaGroup, ids: ReadonlyMap<string, string>): CriteriaGroup {
  return {
    ...group,
    items: group.items.map((item): Criterion => {
      if (item.kind === 'group') return mapCriteria(item, ids);
      if (item.kind === 'custom') return item;
      return {
        ...item,
        left: mapExpr(item.left, ids),
        values: item.values.map((v) => mapExpr(v, ids)),
      };
    }),
  };
}

/**
 * A model read from SQL, with the table ids of the previous model where the same table (schema,
 * name and alias) is still there, and fresh ids for the others, so the canvas keeps its places.
 */
export function reconcile(previous: QueryModel, parsed: QueryModel, newId: NewId): QueryModel {
  const unused = [...previous.tables];
  const ids = new Map<string, string>();
  for (const table of parsed.tables) {
    const index = unused.findIndex((old) => tableKey(old) === tableKey(table));
    const match = index >= 0 ? unused.splice(index, 1)[0] : undefined;
    ids.set(table.id, match ? match.id : newId());
  }
  return {
    ...parsed,
    tables: parsed.tables.map((table) => ({ ...table, id: ids.get(table.id)! })),
    joins: parsed.joins.map((join) => {
      const left = ids.get(join.left) ?? join.left;
      const right = ids.get(join.right) ?? join.right;
      const same = previous.joins.find(
        (old) =>
          (old.left === left && old.right === right) || (old.left === right && old.right === left),
      );
      return { ...join, id: same?.id ?? newId(), left, right };
    }),
    columns: parsed.columns.map((item): SelectItem =>
      item.kind === 'star'
        ? {
            ...item,
            ...(item.table === undefined ? {} : { table: ids.get(item.table) ?? item.table }),
          }
        : { ...item, expr: mapExpr(item.expr, ids) },
    ),
    where: mapCriteria(parsed.where, ids),
    groupBy: parsed.groupBy.map((item) => ({ ...item, expr: mapExpr(item.expr, ids) })),
    having: mapCriteria(parsed.having, ids),
    orderBy: parsed.orderBy.map((item) => ({ ...item, expr: mapExpr(item.expr, ids) })),
  };
}

/** Tables of the model that the catalog does not know (typed in SQL, or dropped since). */
export function unknownTables(
  model: QueryModel,
  catalog: BuilderCatalog | undefined,
): QueryTable[] {
  if (!catalog) return [];
  return model.tables.filter((table) => !entryOf(catalog, table));
}
