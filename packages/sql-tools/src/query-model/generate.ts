import type { SqlDialect } from '@joinery/core';

import { quoteIdent, quoteQualified, quoteString } from '../dialect';
import {
  operatorInfo,
  referenceName,
  type ComparisonOperator,
  type CriteriaGroup,
  type Criterion,
  type JoinType,
  type QueryExpr,
  type QueryIssue,
  type QueryJoin,
  type QueryModel,
  type QueryTable,
} from './model';
import {
  DECIMAL_NUMBER,
  checkFragment,
  hasTopLevelLogic,
  isParameterText,
  isParenthesized,
  isSimpleExpression,
} from './tokens';

/** SQL for a query model, and what is wrong with the model, if anything. */
export interface GeneratedQuery {
  readonly sql: string;
  /** Errors mean the SQL leaves something out or cannot run on the dialect; warnings do not. */
  readonly issues: readonly QueryIssue[];
}

/** MySQL returns every row after OFFSET with this LIMIT (its documented idiom). */
export const MYSQL_NO_LIMIT = '18446744073709551615';

const FLIPPED: Readonly<Record<ComparisonOperator, ComparisonOperator>> = {
  '=': '=',
  '<>': '<>',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
};

const JOIN_SQL: Readonly<Record<JoinType, string>> = {
  inner: 'INNER JOIN',
  left: 'LEFT JOIN',
  right: 'RIGHT JOIN',
  full: 'FULL JOIN',
};

function flipJoin(type: JoinType): JoinType {
  return type === 'left' ? 'right' : type === 'right' ? 'left' : type;
}

function dialectName(dialect: SqlDialect): string {
  return dialect === 'mariadb' ? 'MariaDB' : dialect === 'mysql' ? 'MySQL' : 'PostgreSQL';
}

/**
 * Writes a model as formatted SQL (spec §8: the builder writes SQL). Every name goes through
 * quoteIdent / quoteQualified and every value through quoteString, a checked number or a
 * checked placeholder; hand-written expressions are emitted as written once `checkFragment`
 * accepts them, in parentheses unless they are simple. Tables are written in model order, each
 * joined to the ones before it; a table without a join to them is a CROSS JOIN.
 *
 * Parsing the result with parseQuery and generating again gives the same text. Problems are
 * reported as issues rather than thrown: incomplete conditions, joins and invalid values are
 * left out (with an error), and constructs the dialect lacks (FULL JOIN, ILIKE and NULLS FIRST
 * on MySQL/MariaDB) are written but flagged as errors.
 */
export function generateQuery(model: QueryModel, dialect: SqlDialect): GeneratedQuery {
  return new Generator(model, dialect).run();
}

class Generator {
  private readonly issues: QueryIssue[] = [];
  private readonly tables = new Map<string, QueryTable>();
  private readonly qualify: boolean;

  constructor(
    private readonly model: QueryModel,
    private readonly dialect: SqlDialect,
  ) {
    for (const table of model.tables) this.tables.set(table.id, table);
    this.qualify = model.tables.length > 1;
  }

  run(): GeneratedQuery {
    const lines: string[] = [];
    this.checkTables();
    const items = this.selectList();
    const head = this.model.distinct ? 'SELECT DISTINCT' : 'SELECT';
    lines.push(items.length === 1 ? `${head} ${items[0]}` : `${head}\n  ${items.join(',\n  ')}`);
    lines.push(...this.fromClause());
    const where = this.clause('WHERE', this.model.where);
    if (where) lines.push(where);
    const groupBy = this.model.groupBy.map((item) => this.expr(item.expr, item.id));
    if (groupBy.length > 0) lines.push(`GROUP BY ${groupBy.join(', ')}`);
    const having = this.clause('HAVING', this.model.having);
    if (having) lines.push(having);
    const orderBy = this.model.orderBy.map((item) => {
      let sql = this.expr(item.expr, item.id);
      if (item.direction === 'desc') sql += ' DESC';
      if (item.nulls) {
        sql += item.nulls === 'first' ? ' NULLS FIRST' : ' NULLS LAST';
        if (this.dialect !== 'postgres') {
          this.error(`${dialectName(this.dialect)} has no NULLS FIRST / LAST.`, item.id);
        }
      }
      return sql;
    });
    if (orderBy.length > 0) lines.push(`ORDER BY ${orderBy.join(', ')}`);
    const paging = this.paging();
    if (paging) lines.push(paging);
    return { sql: lines.join('\n'), issues: this.issues };
  }

  private error(message: string, id?: string): void {
    this.issues.push({ severity: 'error', message, ...(id === undefined ? {} : { id }) });
  }

  private warning(message: string, id?: string): void {
    this.issues.push({ severity: 'warning', message, ...(id === undefined ? {} : { id }) });
  }

  private checkTables(): void {
    const seen = new Map<string, string>();
    for (const table of this.model.tables) {
      if (table.name === '') this.error('A table has no name.', table.id);
      const reference = referenceName(table);
      // MySQL/MariaDB may compare aliases without case; keep them apart either way.
      const key = this.dialect === 'postgres' ? reference : reference.toLowerCase();
      if (seen.has(key)) {
        this.error(`Two tables are called "${reference}": give one of them an alias.`, table.id);
      }
      seen.set(key, table.id);
    }
  }

  private selectList(): string[] {
    if (this.model.columns.length === 0) return ['*'];
    return this.model.columns.map((item) => {
      if (item.kind === 'star') {
        if (item.table === undefined) return '*';
        const table = this.tables.get(item.table);
        if (!table) {
          this.error('A column refers to a table that is not in the query.', item.id);
          return '*';
        }
        return `${quoteIdent(referenceName(table), this.dialect)}.*`;
      }
      const sql = this.expr(item.expr, item.id);
      return item.alias !== undefined && item.alias !== ''
        ? `${sql} AS ${quoteIdent(item.alias, this.dialect)}`
        : sql;
    });
  }

  private tableSql(table: QueryTable): string {
    const name = quoteQualified([table.schema, table.name], this.dialect);
    return table.alias !== undefined && table.alias !== ''
      ? `${name} AS ${quoteIdent(table.alias, this.dialect)}`
      : name;
  }

  /** Joins that can be written: both tables in the query, distinct, with conditions. */
  private usableJoins(): QueryJoin[] {
    const usable: QueryJoin[] = [];
    const pairs = new Set<string>();
    for (const join of this.model.joins) {
      if (!this.tables.has(join.left) || !this.tables.has(join.right)) {
        this.error('A join refers to a table that is not in the query.', join.id);
        continue;
      }
      if (join.left === join.right) {
        this.error('A join must connect two different tables.', join.id);
        continue;
      }
      if (join.conditions.length === 0 || join.conditions.some((c) => !c.left || !c.right)) {
        this.error('A join needs a column on each side of every condition.', join.id);
        continue;
      }
      const pair = [join.left, join.right].sort().join('\u0000');
      if (pairs.has(pair)) {
        this.warning('Two joins connect the same tables; their conditions are combined.', join.id);
      }
      pairs.add(pair);
      if (join.type === 'full' && this.dialect !== 'postgres') {
        this.error(`${dialectName(this.dialect)} has no FULL JOIN.`, join.id);
      }
      usable.push(join);
    }
    return usable;
  }

  private fromClause(): string[] {
    const tables = this.model.tables;
    if (tables.length === 0) {
      if (this.model.joins.length > 0) this.error('Joins need tables in the query.');
      return [];
    }
    const joins = this.usableJoins();
    const placed = new Set<string>([tables[0]!.id]);
    const lines = [`FROM ${this.tableSql(tables[0]!)}`];
    let remaining = tables.slice(1);
    while (remaining.length > 0) {
      const linked = (table: QueryTable): QueryJoin[] =>
        joins.filter(
          (join) =>
            (join.left === table.id && placed.has(join.right)) ||
            (join.right === table.id && placed.has(join.left)),
        );
      const next = remaining.find((table) => linked(table).length > 0) ?? remaining[0]!;
      const reaching = linked(next);
      remaining = remaining.filter((table) => table !== next);
      placed.add(next.id);
      if (reaching.length === 0) {
        lines.push(`  CROSS JOIN ${this.tableSql(next)}`);
        continue;
      }
      const oriented = reaching.map((join) =>
        join.right === next.id ? join.type : flipJoin(join.type),
      );
      if (oriented.some((type) => type !== oriented[0])) {
        this.warning(
          `The joins that reach "${referenceName(next)}" have different types; the first one is used.`,
          reaching[0]!.id,
        );
      }
      lines.push(
        `  ${JOIN_SQL[oriented[0]!]} ${this.tableSql(next)} ON ${this.joinConditions(next, reaching).join(' AND ')}`,
      );
    }
    return lines;
  }

  /**
   * The ON conditions of the joins that bring `next` in, the earlier table's column first,
   * grouped by that table in order of first appearance (the order parseQuery rebuilds).
   */
  private joinConditions(next: QueryTable, joins: readonly QueryJoin[]): string[] {
    const byTable = new Map<string, string[]>();
    for (const join of joins) {
      const forward = join.right === next.id;
      const other = this.tables.get(forward ? join.left : join.right)!;
      const list = byTable.get(other.id) ?? [];
      byTable.set(other.id, list);
      for (const condition of join.conditions) {
        const [earlier, operator, later] = forward
          ? [condition.left, condition.operator, condition.right]
          : [condition.right, FLIPPED[condition.operator], condition.left];
        list.push(`${this.qualified(other, earlier)} ${operator} ${this.qualified(next, later)}`);
      }
    }
    return [...byTable.values()].flat();
  }

  private qualified(table: QueryTable, column: string): string {
    return `${quoteIdent(referenceName(table), this.dialect)}.${quoteIdent(column, this.dialect)}`;
  }

  private expr(expr: QueryExpr, id: string): string {
    switch (expr.kind) {
      case 'column': {
        if (expr.column === '') this.error('A column has no name.', id);
        if (expr.table === undefined) return quoteIdent(expr.column, this.dialect);
        const table = this.tables.get(expr.table);
        if (!table) {
          this.error(`"${expr.column}" refers to a table that is not in the query.`, id);
          return quoteIdent(expr.column, this.dialect);
        }
        return this.qualify
          ? this.qualified(table, expr.column)
          : quoteIdent(expr.column, this.dialect);
      }
      case 'aggregate': {
        const fn = expr.fn.toUpperCase();
        if (expr.arg === undefined) {
          if (expr.fn !== 'count' || expr.distinct) this.error(`${fn} needs a column.`, id);
          return `${fn}(*)`;
        }
        return `${fn}(${expr.distinct ? 'DISTINCT ' : ''}${this.expr(expr.arg, id)})`;
      }
      case 'string':
        try {
          return quoteString(expr.value, this.dialect);
        } catch (error) {
          this.error(error instanceof Error ? error.message : String(error), id);
          return "''";
        }
      case 'number':
        if (DECIMAL_NUMBER.test(expr.value)) return expr.value;
        this.error(`"${expr.value}" is not a number.`, id);
        return quoteString(expr.value.replaceAll('\0', ''), this.dialect);
      case 'boolean':
        return expr.value ? 'TRUE' : 'FALSE';
      case 'parameter':
        if (isParameterText(expr.text, this.dialect)) return expr.text;
        this.error(`"${expr.text}" is not a parameter placeholder.`, id);
        return quoteString(expr.text.replaceAll('\0', ''), this.dialect);
      case 'raw': {
        const problem = checkFragment(expr.sql, this.dialect);
        if (problem) this.error(`"${expr.sql.trim()}": ${problem}`, id);
        const sql = expr.sql.trim();
        return isSimpleExpression(sql, this.dialect) ? sql : `(${sql})`;
      }
    }
  }

  /** WHERE / HAVING: the root group's items one per line, or '' when it has none. */
  private clause(keyword: string, root: CriteriaGroup): string {
    const items = root.items.map((item) => this.criterion(item)).filter((sql) => sql !== '');
    if (items.length === 0) return '';
    const op = root.op === 'or' ? 'OR' : 'AND';
    if (root.negated) return `${keyword} ${this.negate(items, op)}`;
    return `${keyword} ${items.join(`\n  ${op} `)}`;
  }

  /** NOT (a OR b); one item already in parentheses gets no second pair. */
  private negate(items: readonly string[], op: 'AND' | 'OR'): string {
    const only = items.length === 1 ? items[0]! : undefined;
    if (only !== undefined && isParenthesized(only, this.dialect)) return `NOT ${only}`;
    return `NOT (${items.join(` ${op} `)})`;
  }

  private criterion(criterion: Criterion): string {
    switch (criterion.kind) {
      case 'group': {
        const items = criterion.items
          .map((item) => this.criterion(item))
          .filter((sql) => sql !== '');
        if (items.length === 0) return '';
        const op = criterion.op === 'or' ? 'OR' : 'AND';
        if (criterion.negated) return this.negate(items, op);
        return items.length === 1 ? items[0]! : `(${items.join(` ${op} `)})`;
      }
      case 'custom': {
        const sql = criterion.sql.trim();
        if (sql === '') {
          this.error('A condition written as SQL is empty; it is left out.', criterion.id);
          return '';
        }
        const problem = checkFragment(sql, this.dialect);
        if (problem) this.error(`"${sql}": ${problem}`, criterion.id);
        return hasTopLevelLogic(sql, this.dialect) ? `(${sql})` : sql;
      }
      case 'condition': {
        const info = operatorInfo(criterion.operator);
        if (info.postgresOnly && this.dialect !== 'postgres') {
          this.error(`${dialectName(this.dialect)} has no ${info.label}.`, criterion.id);
        }
        const count = criterion.values.length;
        const expected = info.arity === 'list' ? Math.max(1, count) : info.arity;
        if (count !== expected) {
          this.error(
            info.arity === 2
              ? `${info.label} needs two values; the condition is left out.`
              : info.arity === 'list'
                ? `${info.label} needs at least one value; the condition is left out.`
                : `${info.label} needs a value; the condition is left out.`,
            criterion.id,
          );
          return '';
        }
        const left = this.expr(criterion.left, criterion.id);
        const values = criterion.values.map((value) => this.expr(value, criterion.id));
        switch (info.arity) {
          case 0:
            return `${left} ${info.label}`;
          case 1:
            return `${left} ${info.label} ${values[0]}`;
          case 2:
            return `${left} ${info.label} ${values[0]} AND ${values[1]}`;
          case 'list':
            return `${left} ${info.label} (${values.join(', ')})`;
        }
      }
    }
  }

  private paging(): string {
    const valid = (value: number | undefined, label: string): value is number => {
      if (value === undefined) return false;
      if (Number.isSafeInteger(value) && value >= 0) return true;
      this.error(`${label} must be a whole number of 0 or more.`);
      return false;
    };
    const limit = valid(this.model.limit, 'LIMIT') ? this.model.limit : undefined;
    const offset = valid(this.model.offset, 'OFFSET') ? this.model.offset : undefined;
    if (limit === undefined && offset === undefined) return '';
    if (this.dialect === 'postgres') {
      return [
        limit === undefined ? '' : `LIMIT ${limit}`,
        offset === undefined ? '' : `OFFSET ${offset}`,
      ]
        .filter(Boolean)
        .join(' ');
    }
    const rows = limit === undefined ? MYSQL_NO_LIMIT : String(limit);
    return offset === undefined ? `LIMIT ${rows}` : `LIMIT ${rows} OFFSET ${offset}`;
  }
}
