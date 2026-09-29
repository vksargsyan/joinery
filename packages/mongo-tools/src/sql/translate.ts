import { Int32, Long } from 'bson';

import { bsonTag, toEjson, type BsonDocument, type BsonValue } from '../bson';
import { formatFindText, type QueryModel } from '../find-text';
import { formatAggregateText } from '../pipeline';
import type {
  AggregateExpr,
  ColumnExpr,
  Expr,
  ExprItem,
  JoinClause,
  OrderItem,
  SelectStatement,
  SqlRange,
  TableRef,
} from './ast';
import { SqlTranslationError, type SqlTranslationErrorCode } from './errors';
import { FilterBuilder, andFilters, literalExpression, setField, type Operand } from './filter';
import { parseSql } from './parser';

/**
 * SQL to MQL (spec §9, query tools): one SELECT translated to a find() or an aggregate(), for
 * the SQL query tab to run and to show beside the SQL.
 *
 * Supported: a select list of columns (dotted paths such as `address.city`, quoted with
 * backticks or double quotes), values, `*`, aliases and DISTINCT; COUNT(*), COUNT(x),
 * COUNT(DISTINCT x), SUM, AVG, MIN and MAX; FROM one collection with an alias; [INNER] JOIN and
 * LEFT [OUTER] JOIN ... ON; WHERE with comparisons, AND, OR, NOT, IN, BETWEEN, LIKE / ILIKE and
 * IS [NOT] NULL / TRUE / FALSE; GROUP BY, HAVING, ORDER BY (column, alias or position) and
 * LIMIT / OFFSET (also MySQL's `LIMIT offset, count`). Anything else fails with a
 * SqlTranslationError that locates it.
 *
 * Choices where SQL and MongoDB differ (each keeps SQL's result unless it says otherwise):
 * - Names are case-sensitive field names; keywords are not case-sensitive. A dot always
 *   separates path segments. A column may be qualified with the collection name or alias.
 * - A missing field is NULL. `x IS NULL` is `{ x: null }`, which matches null and missing.
 * - A comparison with NULL or a missing field is never true, and neither is its NOT: `x <> 5`,
 *   `x NOT IN (...)`, `x NOT LIKE ...` and `NOT (x = 5)` leave out documents where x is null or
 *   missing (`{ x: { $nin: [5, null] } }`). Writing `= NULL` is an error that suggests IS NULL.
 * - A comparison between two fields runs in `$expr` and requires both to be non-null.
 * - LIKE is case-sensitive, as in standard SQL and PostgreSQL (ILIKE is not); backslash is the
 *   default escape character. It matches strings only, and an array field matches when any
 *   element does (as every MongoDB filter does).
 * - COUNT(x) counts documents where x is neither null nor missing. MIN and MAX ignore nulls, AVG
 *   ignores nulls and non-numbers, and each is NULL when nothing is left. SUM is 0, not NULL,
 *   when there is nothing to add ($sum's behaviour).
 * - An aggregate without GROUP BY returns one row even when no document matches (COUNT 0, AVG
 *   NULL), as in SQL: the $group runs inside a $facet with a default row.
 * - GROUP BY and DISTINCT put null and missing in one group, as SQL does.
 * - Joins use $lookup and $unwind (LEFT JOIN keeps unmatched documents). The joined document
 *   sits under the join's alias, so `o.total` stays `o.total` in the result. Differs from SQL:
 *   a join key that is null or missing on both sides matches ($lookup equality), and an array
 *   key matches any of its elements.
 * - ORDER BY sorts as MongoDB does: nulls first in ascending order, types in BSON order.
 * - Without aliases, a selected dotted path keeps its nesting (`address.city` stays
 *   `{ address: { city } }`); `columns` lists the output paths in SELECT order.
 * - LIMIT 0 is refused: MongoDB reads a zero limit as no limit.
 *
 * The pipelines use stages from MongoDB 5.0 (the oldest supported server): $lookup with both
 * localField and a pipeline, $replaceWith, $set and the $first array operator.
 */

export interface SqlToMqlOptions {
  /** Print the mongosh text over several lines, as mongosh would; default true. */
  readonly multiline?: boolean;
  /** Deepest nesting of parentheses, NOTs and function calls; default 200. */
  readonly maxDepth?: number;
}

interface TranslationBase {
  /** The collection the query runs on (the FROM collection). */
  readonly collection: string;
  /** Output field paths in SELECT order; undefined for `SELECT *`. */
  readonly columns?: readonly string[];
  /** The mongosh command, e.g. `db.orders.find({ ... })`. */
  readonly text: string;
}

export interface SqlFindTranslation extends TranslationBase {
  readonly kind: 'find';
  readonly query: QueryModel;
}

export interface SqlAggregateTranslation extends TranslationBase {
  readonly kind: 'aggregate';
  readonly pipeline: readonly BsonDocument[];
}

/**
 * A translated SELECT. The query is data in the forms the rest of this package uses
 * (`toFindQuery(query)` / `toEjson(pipeline)` for the wire) plus its mongosh text.
 */
export type SqlTranslation = SqlFindTranslation | SqlAggregateTranslation;

const INT32_MAX = 2147483647;

function integer(n: number): BsonValue {
  return n <= INT32_MAX ? new Int32(n) : Long.fromNumber(n);
}

function flattenAnd(expr: Expr): Expr[] {
  return expr.kind === 'and' ? expr.items.flatMap(flattenAnd) : [expr];
}

/** A field name made from a path or expression: letters, digits and underscores. */
function sanitize(text: string, fallback: string): string {
  const name = text.replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '');
  return name === '' ? fallback : name;
}

function uniqueName(base: string, taken: Set<string>): string {
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
  taken.add(name);
  return name;
}

function containsAggregate(expr: Expr | undefined): boolean {
  if (expr === undefined) return false;
  switch (expr.kind) {
    case 'aggregate':
      return true;
    case 'and':
    case 'or':
      return expr.items.some(containsAggregate);
    case 'not':
      return containsAggregate(expr.expr);
    case 'compare':
      return containsAggregate(expr.left) || containsAggregate(expr.right);
    case 'in':
      return containsAggregate(expr.expr) || expr.list.some(containsAggregate);
    case 'between':
      return (
        containsAggregate(expr.expr) || containsAggregate(expr.low) || containsAggregate(expr.high)
      );
    case 'like':
      return containsAggregate(expr.expr);
    case 'is':
      return containsAggregate(expr.expr);
    default:
      return false;
  }
}

/** A position in ORDER BY or GROUP BY: an integer literal. */
function positionOf(expr: Expr): number | undefined {
  if (expr.kind !== 'literal') return undefined;
  const tag = bsonTag(expr.value);
  if (tag === 'Int32') return (expr.value as Int32).value;
  if (tag === 'Long') return Number.MAX_SAFE_INTEGER;
  return undefined;
}

interface JoinScope {
  readonly alias: string;
  readonly join: JoinClause;
}

interface Resolved {
  readonly path: string;
  /** -1 for the FROM collection, else the join's index. */
  readonly table: number;
}

/** A select-list entry once translated. */
interface Output {
  /** The output field path. */
  readonly name: string;
  readonly item: ExprItem;
  /** The $project value. */
  readonly value: BsonValue;
  /** What the item stands for in HAVING and ORDER BY. */
  readonly operand: Operand;
}

interface GroupKey {
  readonly path: string;
  /** The field under `_id` (several keys), or undefined for the only key. */
  readonly name?: string;
  /** The key's path in the $group output: `_id` or `_id.<name>`. */
  readonly groupPath: string;
}

interface Accumulator {
  readonly signature: string;
  readonly name: string;
  readonly spec: BsonDocument;
  /** For DISTINCT aggregates: the $set that turns the collected set into the result. */
  readonly finish?: BsonValue;
  /** The value when no document matched (aggregates without GROUP BY). */
  readonly empty: BsonValue;
}

class Translator {
  private readonly qualifier: readonly string[];
  private readonly joins: readonly JoinScope[];
  private readonly multiline: boolean;

  constructor(
    private readonly sql: string,
    private readonly statement: SelectStatement,
    options: SqlToMqlOptions,
  ) {
    this.multiline = options.multiline ?? true;
    const from = statement.from;
    this.checkCollection(from);
    this.qualifier = from.alias !== undefined ? [from.alias] : from.parts;
    const taken = new Set([this.qualifier.join('.')]);
    this.joins = statement.joins.map((join) => {
      this.checkCollection(join.table);
      const alias = join.table.alias ?? join.table.name;
      if (join.table.alias === undefined && join.table.parts.length > 1) {
        this.fail(join.table, `Give ${alias} an alias`, 'VALIDATION_FAILED', `JOIN ${alias} AS x`);
      }
      this.checkFieldName(alias, join.table, 'A join alias');
      if (taken.has(alias)) {
        this.fail(
          join.table,
          `${alias} is used twice in FROM`,
          'VALIDATION_FAILED',
          'Give each table its own alias',
        );
      }
      taken.add(alias);
      return { alias, join };
    });
  }

  fail(
    range: SqlRange,
    reason: string,
    code: SqlTranslationErrorCode = 'VALIDATION_FAILED',
    hint?: string,
  ): never {
    throw new SqlTranslationError(this.sql, code, range, reason, hint);
  }

  private checkCollection(table: TableRef): void {
    if (table.name === '' || table.parts.some((part) => part === '')) {
      this.fail(table, 'The collection name is empty');
    }
    if (/[\0$]/.test(table.name)) {
      this.fail(table, 'A collection name cannot contain $ or a null character');
    }
  }

  /** A name used as a field name in the output: no dots, no leading $, not empty. */
  private checkFieldName(name: string, range: SqlRange, what: string): void {
    if (name === '') this.fail(range, `${what} cannot be empty`);
    if (name.includes('.')) this.fail(range, `${what} cannot contain "."`);
    if (name.startsWith('$')) this.fail(range, `${what} cannot start with $`, 'NOT_SUPPORTED');
    if (name.includes('\0')) this.fail(range, `${what} cannot contain a null character`);
  }

  // ---------------------------------------------------------------------------------------------
  // Names

  /** A column's document path; `visible` joins can be named (all but later ones in an ON). */
  private resolve(column: ColumnExpr, visible = this.joins.length): Resolved {
    const parts = column.parts;
    let table = -1;
    let path: readonly string[] = parts;
    const join = this.joins.findIndex((scope) => scope.alias === parts[0]);
    if (join >= 0) {
      if (join >= visible) {
        this.fail(column, `${parts[0]} is joined later and cannot be used here`);
      }
      table = join;
    } else if (
      parts.length > this.qualifier.length &&
      this.qualifier.every((part, i) => parts[i] === part)
    ) {
      path = parts.slice(this.qualifier.length);
    }
    const text = path.join('.');
    for (const segment of text.split('.')) {
      if (segment === '') this.fail(column, `"${text}" has an empty field name`);
      if (segment.startsWith('$')) {
        this.fail(column, 'Field names starting with $ are not supported', 'NOT_SUPPORTED');
      }
      if (segment.includes('\0')) this.fail(column, 'A field name cannot contain a null character');
    }
    return { path: text, table };
  }

  private columnName(column: ColumnExpr): string {
    return column.parts.join('.');
  }

  // ---------------------------------------------------------------------------------------------
  // WHERE and joins

  /** WHERE split into the part that runs before the joins (it names only FROM's fields) and after. */
  private where(): { before: BsonDocument; after: BsonDocument } {
    const where = this.statement.where;
    if (where === undefined) return { before: {}, after: {} };
    const before: BsonDocument[] = [];
    const after: BsonDocument[] = [];
    for (const conjunct of flattenAnd(where)) {
      const tables = new Set<number>();
      const builder = new FilterBuilder({
        column: (column) => {
          const resolved = this.resolve(column);
          tables.add(resolved.table);
          return { kind: 'field', path: resolved.path, range: column };
        },
        aggregate: (aggregate) =>
          this.fail(
            aggregate,
            'Aggregate functions are not allowed in WHERE',
            'VALIDATION_FAILED',
            'Use HAVING',
          ),
        fail: (range, reason, code, hint) => this.fail(range, reason, code, hint),
      });
      const filter = builder.condition(conjunct);
      (tables.size === 0 || (tables.size === 1 && tables.has(-1)) ? before : after).push(filter);
    }
    return { before: andFilters(before), after: andFilters(after) };
  }

  private lookups(): BsonDocument[] {
    return this.joins.flatMap((scope, index) => this.lookup(scope, index));
  }

  private lookup(scope: JoinScope, index: number): BsonDocument[] {
    const { alias, join } = scope;
    const equalities: { local: string; foreign: string }[] = [];
    const conditions: BsonDocument[] = [];
    const side = (column: ColumnExpr): { foreign: boolean; path: string } => {
      const resolved = this.resolve(column, index + 1);
      if (resolved.table !== index) return { foreign: false, path: resolved.path };
      if (resolved.path === alias) this.fail(column, `Name a field of ${alias}`);
      return { foreign: true, path: resolved.path.slice(alias.length + 1) };
    };
    const onlyJoined = (range: SqlRange): never =>
      this.fail(
        range,
        `ON can only compare ${alias}'s fields with an earlier table's using =, and test ${alias}'s fields`,
        'NOT_SUPPORTED',
        `Qualify the columns (${alias}.field) and move other conditions to WHERE`,
      );
    for (const conjunct of flattenAnd(join.on)) {
      if (
        conjunct.kind === 'compare' &&
        conjunct.op === '=' &&
        conjunct.left.kind === 'column' &&
        conjunct.right.kind === 'column'
      ) {
        const left = side(conjunct.left);
        const right = side(conjunct.right);
        if (left.foreign !== right.foreign) {
          equalities.push(
            left.foreign
              ? { local: right.path, foreign: left.path }
              : { local: left.path, foreign: right.path },
          );
          continue;
        }
      }
      // A condition on the joined collection alone filters it inside the $lookup.
      const builder = new FilterBuilder({
        column: (column) => {
          const resolved = side(column);
          if (!resolved.foreign) onlyJoined(column);
          return { kind: 'field', path: resolved.path, range: column };
        },
        aggregate: (aggregate) => this.fail(aggregate, 'Aggregate functions are not allowed in ON'),
        fail: (range, reason, code, hint) => this.fail(range, reason, code, hint),
      });
      conditions.push(builder.condition(conjunct));
    }
    if (equalities.length === 0) {
      this.fail(
        join.on,
        `ON needs an equality between a field of ${alias} and a field of an earlier table`,
        'NOT_SUPPORTED',
        `For example ON ${this.qualifier.join('.')}.field = ${alias}.field`,
      );
    }
    const filter = andFilters(conditions);
    const lookup: BsonDocument = { from: join.table.name };
    if (equalities.length === 1) {
      lookup['localField'] = equalities[0]!.local;
      lookup['foreignField'] = equalities[0]!.foreign;
      if (Object.keys(filter).length > 0) lookup['pipeline'] = [{ $match: filter }];
    } else {
      const variables: BsonDocument = {};
      const taken = new Set<string>();
      const tests = equalities.map(({ local, foreign }) => {
        let base = sanitize(local, 'key').replace(/^[^\p{Ll}\p{Lu}]+/u, '');
        base = base === '' ? 'key' : base[0]!.toLowerCase() + base.slice(1);
        const name = uniqueName(base, taken);
        setField(variables, name, `$${local}`);
        return { $eq: [`$${foreign}`, `$$${name}`] };
      });
      lookup['let'] = variables;
      lookup['pipeline'] = [{ $match: andFilters([{ $expr: { $and: tests } }, filter]) }];
    }
    lookup['as'] = alias;
    const unwind: BsonValue =
      join.type === 'left' ? { path: `$${alias}`, preserveNullAndEmptyArrays: true } : `$${alias}`;
    return [{ $lookup: lookup }, { $unwind: unwind }];
  }

  // ---------------------------------------------------------------------------------------------
  // Output names

  private checkOutputs(outputs: readonly Output[]): void {
    for (let j = 0; j < outputs.length; j++) {
      const b = outputs[j]!;
      for (let i = 0; i < j; i++) {
        const a = outputs[i]!;
        if (a.name === b.name) {
          this.fail(
            b.item,
            `${b.name} is selected twice`,
            'VALIDATION_FAILED',
            'Give one of them an alias',
          );
        }
        if (b.name.startsWith(`${a.name}.`) || a.name.startsWith(`${b.name}.`)) {
          this.fail(
            b.item,
            `${b.name} and ${a.name} overlap in the result`,
            'NOT_SUPPORTED',
            'Select one of them, or give one an alias',
          );
        }
      }
    }
  }

  private checkAlias(item: ExprItem): void {
    if (item.alias !== undefined)
      this.checkFieldName(item.alias, item.aliasRange ?? item, 'An alias');
  }

  private exprItems(): ExprItem[] {
    return this.statement.items.map((item) => {
      if (item.kind === 'star') {
        this.fail(
          item,
          '* cannot be combined with other columns, GROUP BY, DISTINCT or aggregate functions',
          'NOT_SUPPORTED',
        );
      }
      this.checkAlias(item);
      return item;
    });
  }

  private checkLimit(): void {
    const limit = this.statement.limit;
    if (limit !== undefined && limit.value === 0) {
      this.fail(
        limit,
        'LIMIT 0 is not supported',
        'NOT_SUPPORTED',
        'MongoDB reads a limit of 0 as no limit',
      );
    }
  }

  private direction(order: OrderItem): Int32 {
    if (order.nulls === 'last' && !order.descending) {
      this.fail(
        order,
        'NULLS LAST with an ascending sort is not supported',
        'NOT_SUPPORTED',
        'MongoDB sorts nulls first when ascending',
      );
    }
    if (order.nulls === 'first' && order.descending) {
      this.fail(
        order,
        'NULLS FIRST with a descending sort is not supported',
        'NOT_SUPPORTED',
        'MongoDB sorts nulls last when descending',
      );
    }
    return new Int32(order.descending ? -1 : 1);
  }

  /** The output an ORDER BY or GROUP BY item names by position or alias, if any. */
  private outputFor(
    expr: Expr,
    outputs: readonly Output[] | undefined,
    clause: string,
  ): Output | undefined {
    const position = positionOf(expr);
    if (position !== undefined) {
      if (outputs === undefined)
        this.fail(expr, `${clause} ${position} needs a select list, not *`);
      if (position < 1 || position > outputs.length) {
        this.fail(
          expr,
          `${clause} position ${position} is not in the select list (1 to ${outputs.length})`,
        );
      }
      return outputs[position - 1];
    }
    if (expr.kind === 'column' && expr.parts.length === 1 && outputs !== undefined) {
      return outputs.find((output) => output.item.alias === expr.parts[0]);
    }
    return undefined;
  }

  private constantSort(range: SqlRange): never {
    return this.fail(range, 'Sorting by a constant is not supported', 'NOT_SUPPORTED');
  }

  // ---------------------------------------------------------------------------------------------
  // Translation

  translate(): SqlTranslation {
    this.checkLimit();
    const { statement } = this;
    const grouped =
      statement.groupBy.length > 0 ||
      statement.having !== undefined ||
      statement.items.some((item) => item.kind === 'expr' && containsAggregate(item.expr)) ||
      statement.orderBy.some((order) => containsAggregate(order.expr));
    if (grouped || statement.distinct) return this.grouped(grouped);
    return this.plain();
  }

  private plain(): SqlTranslation {
    const { statement } = this;
    const { before, after } = this.where();
    const star = statement.items.find((item) => item.kind === 'star');
    let outputs: Output[] | undefined;
    let projection: BsonDocument | undefined;
    let excluded: BsonDocument | undefined;
    if (star) {
      if (statement.items.length > 1) {
        const other = statement.items.find((item) => item !== star)!;
        this.fail(other, '* cannot be combined with other columns', 'NOT_SUPPORTED');
      }
      const qualifier = star.qualifier;
      if (qualifier !== undefined) {
        const name = qualifier.join('.');
        if (this.joins.some((scope) => scope.alias === name)) {
          this.fail(
            star,
            `${name}.* is not supported`,
            'NOT_SUPPORTED',
            'Select * or name its fields',
          );
        }
        if (name !== this.qualifier.join('.')) this.fail(star, `${name} is not a table in FROM`);
        if (this.joins.length > 0) {
          excluded = {};
          for (const scope of this.joins) setField(excluded, scope.alias, new Int32(0));
        }
      }
    } else {
      const items = this.exprItems();
      const names = this.explicitNames(items);
      outputs = items.map((item, index) => this.plainOutput(item, index, names));
      this.checkOutputs(outputs);
      projection = {};
      for (const output of outputs) setField(projection, output.name, output.value);
      // SQL returns only what is selected, so _id is excluded unless it (or part of it) is.
      const keepsId = outputs.some(
        (output) => output.name === '_id' || output.name.startsWith('_id.'),
      );
      if (!keepsId) projection['_id'] = new Int32(0);
    }
    const sort: BsonDocument = {};
    for (const order of statement.orderBy) {
      const output = this.outputFor(order.expr, outputs, 'ORDER BY');
      let path: string;
      if (output !== undefined) {
        if (output.operand.kind !== 'field') this.constantSort(order);
        path = output.operand.path;
      } else if (order.expr.kind === 'column') {
        path = this.resolve(order.expr).path;
      } else if (order.expr.kind === 'literal') {
        this.constantSort(order);
      } else {
        this.fail(
          order.expr,
          'ORDER BY can only name columns, aliases and positions',
          'NOT_SUPPORTED',
        );
      }
      if (!Object.prototype.hasOwnProperty.call(sort, path))
        setField(sort, path, this.direction(order));
    }
    const skip = statement.offset?.value ?? 0;
    const limit = statement.limit?.value;
    const collection = statement.from.name;
    const columns = outputs?.map((output) => output.name);
    if (this.joins.length === 0) {
      const query: QueryModel = {
        filter: before,
        ...(projection !== undefined ? { projection } : {}),
        ...(Object.keys(sort).length > 0 ? { sort } : {}),
        ...(skip > 0 ? { skip } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      return {
        kind: 'find',
        collection,
        query,
        ...(columns ? { columns } : {}),
        text: formatFindText(collection, query, { multiline: this.multiline }),
      };
    }
    const pipeline: BsonDocument[] = [];
    if (Object.keys(before).length > 0) pipeline.push({ $match: before });
    pipeline.push(...this.lookups());
    if (Object.keys(after).length > 0) pipeline.push({ $match: after });
    if (Object.keys(sort).length > 0) pipeline.push({ $sort: sort });
    if (skip > 0) pipeline.push({ $skip: integer(skip) });
    if (limit !== undefined) pipeline.push({ $limit: integer(limit) });
    if (projection !== undefined) pipeline.push({ $project: projection });
    if (excluded !== undefined) pipeline.push({ $project: excluded });
    return this.aggregate(pipeline, columns);
  }

  /** The names the select list gives explicitly, so generated names avoid them. */
  private explicitNames(items: readonly ExprItem[]): Set<string> {
    const names = new Set<string>();
    for (const item of items) {
      if (item.alias !== undefined) names.add(item.alias);
      else if (item.expr.kind === 'column') names.add(this.resolve(item.expr).path);
    }
    return names;
  }

  private plainOutput(item: ExprItem, index: number, names: Set<string>): Output {
    const expr = item.expr;
    if (expr.kind === 'column') {
      const { path } = this.resolve(expr);
      const name = item.alias ?? path;
      const value: BsonValue = name === path ? new Int32(1) : `$${path}`;
      return { name, item, value, operand: { kind: 'field', path, range: expr } };
    }
    if (expr.kind === 'literal') {
      const name = item.alias ?? uniqueName(`expr${index + 1}`, names);
      return {
        name,
        item,
        value: { $literal: expr.value },
        operand: { kind: 'value', value: expr.value, range: expr },
      };
    }
    return this.unsupportedItem(expr);
  }

  private unsupportedItem(expr: Expr): never {
    return this.fail(
      expr,
      'Only columns, values and aggregate functions can be selected',
      'NOT_SUPPORTED',
    );
  }

  private aggregate(
    pipeline: BsonDocument[],
    columns: readonly string[] | undefined,
  ): SqlTranslation {
    const collection = this.statement.from.name;
    return {
      kind: 'aggregate',
      collection,
      pipeline,
      ...(columns ? { columns } : {}),
      text: formatAggregateText(collection, pipeline, { multiline: this.multiline }),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // GROUP BY, aggregates and DISTINCT

  private grouped(aggregating: boolean): SqlTranslation {
    const { statement } = this;
    const items = this.exprItems();
    const { before, after } = this.where();

    // The columns the select list names, before anything else: GROUP BY may use their aliases.
    const selected = items.map((item) =>
      item.expr.kind === 'column' ? this.resolve(item.expr).path : undefined,
    );

    // Keys: GROUP BY, or the selected columns for a plain SELECT DISTINCT.
    const keyPaths: string[] = [];
    const addKey = (path: string): void => {
      if (!keyPaths.includes(path)) keyPaths.push(path);
    };
    if (aggregating) {
      for (const expr of statement.groupBy) addKey(this.groupKey(expr, items, selected));
      if (statement.distinct && keyPaths.some((path) => !selected.includes(path))) {
        this.fail(
          statement.items[0]!,
          'DISTINCT with GROUP BY columns that are not selected is not supported',
          'NOT_SUPPORTED',
        );
      }
    } else {
      items.forEach((item, i) => {
        if (selected[i] !== undefined) addKey(selected[i]);
        else if (item.expr.kind !== 'literal') this.unsupportedItem(item.expr);
      });
    }

    // Name the keys after the select item that shows them, when there is one.
    const keyNames = new Set<string>();
    const keys: GroupKey[] = keyPaths.map((path) => {
      if (keyPaths.length === 1) return { path, groupPath: '_id' };
      const index = selected.indexOf(path);
      const shown = index >= 0 ? (items[index]!.alias ?? path) : path;
      const name = uniqueName(sanitize(shown, 'key'), keyNames);
      return { path, name, groupPath: `_id.${name}` };
    });

    const accumulators: Accumulator[] = [];
    const accumulatorNames = new Set<string>(['_id']);
    const accumulate = (aggregate: AggregateExpr, preferred?: string): Accumulator =>
      this.accumulator(aggregate, preferred, accumulators, accumulatorNames);

    // Select list.
    const outputNames = this.explicitNames(items);
    const outputs: Output[] = items.map((item, index) => {
      const expr = item.expr;
      if (expr.kind === 'column') {
        const path = selected[index]!;
        const key = keys.find((k) => k.path === path);
        if (key === undefined) this.notGrouped(expr, statement.distinct && !aggregating);
        const name = item.alias ?? path;
        if (name.startsWith('_id.')) {
          this.fail(
            expr,
            `Give ${path} an alias`,
            'NOT_SUPPORTED',
            'Grouped results cannot nest under _id',
          );
        }
        return {
          name,
          item,
          value: `$${key.groupPath}`,
          operand: { kind: 'field', path: key.groupPath, range: expr },
        };
      }
      if (expr.kind === 'aggregate') {
        const name = item.alias ?? uniqueName(this.aggregateName(expr), outputNames);
        const accumulator = accumulate(expr, name);
        return {
          name,
          item,
          value: `$${accumulator.name}`,
          operand: { kind: 'field', path: accumulator.name, range: expr },
        };
      }
      if (expr.kind === 'literal') {
        const name = item.alias ?? uniqueName(`expr${index + 1}`, outputNames);
        return {
          name,
          item,
          value: { $literal: expr.value },
          operand: { kind: 'value', value: expr.value, range: expr },
        };
      }
      return this.unsupportedItem(expr);
    });
    this.checkOutputs(outputs);

    // HAVING: aggregates, grouped columns and select-list aliases.
    let having: BsonDocument = {};
    if (statement.having !== undefined) {
      const builder = new FilterBuilder({
        column: (column) => {
          const output = this.outputFor(column, outputs, 'HAVING');
          if (output !== undefined) return output.operand;
          const { path } = this.resolve(column);
          const key = keys.find((k) => k.path === path);
          if (key === undefined) this.notGrouped(column, false);
          return { kind: 'field', path: key.groupPath, range: column };
        },
        aggregate: (aggregate) => ({
          kind: 'field',
          path: accumulate(aggregate).name,
          range: aggregate,
        }),
        fail: (range, reason, code, hint) => this.fail(range, reason, code, hint),
      });
      having = builder.condition(statement.having);
    }

    // ORDER BY runs on the $group output, before the final $project.
    const sort: BsonDocument = {};
    for (const order of statement.orderBy) {
      const expr = order.expr;
      const output = this.outputFor(expr, outputs, 'ORDER BY');
      let path: string;
      if (output !== undefined) {
        if (output.operand.kind !== 'field') this.constantSort(order);
        path = output.operand.path;
      } else if (expr.kind === 'aggregate') {
        path = accumulate(expr).name;
      } else if (expr.kind === 'column') {
        const resolved = this.resolve(expr).path;
        const key = keys.find((k) => k.path === resolved);
        if (key === undefined) this.notGrouped(expr, statement.distinct && !aggregating);
        path = key.groupPath;
      } else if (expr.kind === 'literal') {
        this.constantSort(order);
      } else {
        this.fail(
          expr,
          'ORDER BY can only name columns, aliases, positions and aggregates',
          'NOT_SUPPORTED',
        );
      }
      if (!Object.prototype.hasOwnProperty.call(sort, path))
        setField(sort, path, this.direction(order));
    }

    // $group, then the $set that finishes DISTINCT aggregates.
    let id: BsonValue = null;
    if (keys.length === 1) {
      id = `$${keys[0]!.path}`;
    } else if (keys.length > 1) {
      const doc: BsonDocument = {};
      // { $ifNull: [x, null] } makes a missing field null, so both fall in one group.
      for (const key of keys) setField(doc, key.name!, { $ifNull: [`$${key.path}`, null] });
      id = doc;
    }
    const group: BsonDocument = { _id: id };
    const finish: BsonDocument = {};
    for (const accumulator of accumulators) {
      setField(group, accumulator.name, accumulator.spec);
      if (accumulator.finish !== undefined) setField(finish, accumulator.name, accumulator.finish);
    }
    let grouping: BsonDocument[] = [{ $group: group }];
    if (Object.keys(finish).length > 0) grouping.push({ $set: finish });
    if (keys.length === 0 && aggregating) {
      // SQL returns one row for an aggregate over no rows; $group returns none. Run the $group in
      // a $facet and fall back to the empty-input values.
      const empty: BsonDocument = {};
      for (const accumulator of accumulators) setField(empty, accumulator.name, accumulator.empty);
      grouping = [
        { $facet: { rows: grouping } },
        { $replaceWith: { $ifNull: [{ $first: '$rows' }, empty] } },
      ];
    }

    const project: BsonDocument = {};
    if (!outputs.some((output) => output.name === '_id')) project['_id'] = new Int32(0);
    for (const output of outputs) setField(project, output.name, output.value);

    const pipeline: BsonDocument[] = [];
    if (Object.keys(before).length > 0) pipeline.push({ $match: before });
    pipeline.push(...this.lookups());
    if (Object.keys(after).length > 0) pipeline.push({ $match: after });
    pipeline.push(...grouping);
    if (Object.keys(having).length > 0) pipeline.push({ $match: having });
    if (Object.keys(sort).length > 0) pipeline.push({ $sort: sort });
    const skip = statement.offset?.value ?? 0;
    if (skip > 0) pipeline.push({ $skip: integer(skip) });
    if (statement.limit !== undefined) pipeline.push({ $limit: integer(statement.limit.value) });
    pipeline.push({ $project: project });
    return this.aggregate(
      pipeline,
      outputs.map((output) => output.name),
    );
  }

  private notGrouped(column: ColumnExpr, distinct: boolean): never {
    const name = this.columnName(column);
    if (distinct) {
      return this.fail(column, `With SELECT DISTINCT, ${name} must be in the select list`);
    }
    return this.fail(column, `${name} must appear in GROUP BY or be used in an aggregate function`);
  }

  /** A GROUP BY item's path: a column, a select-list alias or a position. */
  private groupKey(
    expr: Expr,
    items: readonly ExprItem[],
    selected: readonly (string | undefined)[],
  ): string {
    const position = positionOf(expr);
    if (position !== undefined) {
      if (position < 1 || position > items.length) {
        this.fail(
          expr,
          `GROUP BY position ${position} is not in the select list (1 to ${items.length})`,
        );
      }
      const path = selected[position - 1];
      if (path === undefined)
        this.fail(expr, 'GROUP BY can only name a selected column by position');
      return path;
    }
    if (expr.kind === 'column') {
      if (expr.parts.length === 1) {
        const index = items.findIndex((item) => item.alias === expr.parts[0]);
        if (index >= 0) {
          const path = selected[index];
          if (path === undefined) this.fail(expr, `${expr.parts[0]} is not a column`);
          return path;
        }
      }
      return this.resolve(expr).path;
    }
    if (expr.kind === 'aggregate')
      this.fail(expr, 'Aggregate functions are not allowed in GROUP BY');
    if (expr.kind === 'literal')
      this.fail(expr, 'Grouping by a constant is not supported', 'NOT_SUPPORTED');
    return this.fail(
      expr,
      'GROUP BY can only name columns, aliases and positions',
      'NOT_SUPPORTED',
    );
  }

  /** The default name of an aggregate's result: `count`, `sum_price`, `count_distinct_a_b`... */
  private aggregateName(expr: AggregateExpr): string {
    const fn = expr.name.toLowerCase();
    const arg = expr.arg;
    const distinct = expr.distinct && expr.name !== 'MIN' && expr.name !== 'MAX' ? '_distinct' : '';
    if (arg === undefined || arg.kind !== 'column') return `${fn}${distinct}`;
    return `${fn}${distinct}_${sanitize(this.resolve(arg).path, 'value')}`;
  }

  private accumulator(
    expr: AggregateExpr,
    preferred: string | undefined,
    accumulators: Accumulator[],
    names: Set<string>,
  ): Accumulator {
    const arg = expr.arg;
    let path: string | undefined;
    let value: BsonValue | undefined;
    if (arg !== undefined) {
      if (arg.kind === 'column') path = this.resolve(arg).path;
      else if (arg.kind === 'literal') value = arg.value;
      else if (containsAggregate(arg)) this.fail(arg, 'Aggregate functions cannot be nested');
      else this.fail(arg, `${expr.name}() can only take a column or a value`, 'NOT_SUPPORTED');
    }
    const distinct = expr.distinct && expr.name !== 'MIN' && expr.name !== 'MAX';
    if (distinct && path === undefined) {
      this.fail(expr, `${expr.name}(DISTINCT ...) needs a column`, 'NOT_SUPPORTED');
    }
    const signature = `${expr.name}|${distinct}|${
      path !== undefined ? `field:${path}` : value !== undefined ? `value:${toEjson(value)}` : '*'
    }`;
    const existing = accumulators.find((a) => a.signature === signature);
    if (existing) return existing;

    const name = uniqueName(
      preferred !== undefined && preferred !== '_id' && !names.has(preferred)
        ? preferred
        : this.aggregateName(expr),
      names,
    );
    const input: BsonValue = path !== undefined ? `$${path}` : literalExpression(value ?? null);
    let spec: BsonDocument;
    let finish: BsonValue | undefined;
    let empty: BsonValue = null;
    switch (expr.name) {
      case 'COUNT':
        empty = new Int32(0);
        if (distinct) {
          spec = { $addToSet: input };
          finish = { $size: { $setDifference: [`$${name}`, [null]] } };
        } else if (path === undefined) {
          spec = { $sum: new Int32(value === null ? 0 : 1) };
        } else {
          // Counts the documents where the field is neither null nor missing.
          spec = {
            $sum: {
              $cond: [{ $eq: [{ $ifNull: [input, null] }, null] }, new Int32(0), new Int32(1)],
            },
          };
        }
        break;
      case 'SUM':
      case 'AVG': {
        const op = expr.name === 'SUM' ? '$sum' : '$avg';
        if (expr.name === 'SUM') empty = new Int32(0);
        if (distinct) {
          spec = { $addToSet: input };
          finish = { [op]: `$${name}` };
        } else {
          spec = { [op]: input };
        }
        break;
      }
      case 'MIN':
        spec = { $min: input };
        break;
      case 'MAX':
        spec = { $max: input };
        break;
    }
    const accumulator: Accumulator = {
      signature,
      name,
      spec,
      empty,
      ...(finish !== undefined ? { finish } : {}),
    };
    accumulators.push(accumulator);
    return accumulator;
  }
}

/**
 * Translates one SQL SELECT into a MongoDB find() or aggregate() (see the module comment for
 * what is supported and how SQL's semantics are kept). find() is chosen when the query needs
 * nothing else: no join, grouping, aggregate or DISTINCT. Every failure is a
 * SqlTranslationError locating the problem in `sql`; nothing else is thrown.
 */
export function sqlToMql(sql: string, options: SqlToMqlOptions = {}): SqlTranslation {
  try {
    const statement = parseSql(
      sql,
      options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {},
    );
    return new Translator(sql, statement, options).translate();
  } catch (error) {
    if (error instanceof SqlTranslationError) throw error;
    throw new SqlTranslationError(
      sql,
      'INTERNAL',
      { start: 0, end: sql.length },
      `The statement could not be translated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
