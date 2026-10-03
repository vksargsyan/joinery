import type { SqlDialect } from '@querybara/core';

import { isTrivia, tokenize, type Token } from '../lexer';
import { splitStatements } from '../splitter';
import { MYSQL_NO_LIMIT } from './generate';
import {
  AGGREGATE_FUNCTIONS,
  COMPARISON_OPERATORS,
  emptyGroup,
  referenceName,
  type AggregateFunction,
  type ComparisonOperator,
  type Condition,
  type CriteriaGroup,
  type CriteriaOperator,
  type Criterion,
  type GroupItem,
  type JoinCondition,
  type JoinType,
  type OrderItem,
  type QueryExpr,
  type QueryJoin,
  type QueryModel,
  type QueryTable,
  type SelectItem,
} from './model';
import {
  DECIMAL_NUMBER,
  closingIndex,
  endsOperand,
  identifierName,
  isAliasToken,
  isIdentifier,
  isOperator,
  isParameterText,
  isPunct,
  isReserved,
  isWord,
  scanTop,
  splitTopCommas,
  stringValue,
  unbalanced,
  unsupportedInside,
  wordOf,
} from './tokens';

/** What parseQuery made of some SQL. Offsets are into the text it was given. */
export type QueryParseResult =
  | { readonly status: 'ok'; readonly model: QueryModel }
  /** A query the builder cannot show; `construct` names what, e.g. "a subquery". */
  | {
      readonly status: 'unsupported';
      readonly construct: string;
      readonly message: string;
      readonly start: number;
      readonly end: number;
    }
  /** Not a complete SELECT (a typo, or text still being typed). */
  | {
      readonly status: 'invalid';
      readonly message: string;
      readonly start: number;
      readonly end: number;
    };

export interface QueryParseOptions {
  /**
   * The columns of a table, from the metadata cache. With it, a column written without a table
   * name is attached to the one table in scope that has it; without it, such a column stays
   * unqualified unless the query has a single table.
   */
  readonly columnsOf?: (table: QueryTable) => readonly string[] | undefined;
}

type Failure = Exclude<QueryParseResult, { status: 'ok' }>;

class Stop {
  constructor(readonly failure: Failure) {}
}

/**
 * Reads the SELECT the visual builder can show back into a model (spec §8: "SQL it can parse
 * opens back in the builder"), on Querybara's own lexer (ADR 0003, ADR 0014). Anything outside
 * that subset — another statement, several statements, WITH, UNION, subqueries, window
 * functions, DISTINCT ON, ROLLUP, locking clauses, USING and NATURAL joins, join conditions
 * that are not column comparisons, FULL JOIN on MySQL/MariaDB — gives `unsupported` naming the
 * construct, so the builder can open read-only with a note. Expressions it cannot break down
 * (functions, arithmetic, CASE) are kept as written in `raw` expressions and conditions.
 */
export function parseQuery(
  sql: string,
  dialect: SqlDialect,
  options: QueryParseOptions = {},
): QueryParseResult {
  const statements = splitStatements(sql, dialect);
  const first = statements[0];
  if (!first)
    return { status: 'invalid', message: 'There is no query.', start: 0, end: sql.length };
  if (statements.length > 1) {
    const second = statements[1]!;
    return unsupported('more than one statement', second.start, second.end);
  }
  const all = tokenize(first.text, dialect);
  for (const token of all) {
    if (token.unterminated) {
      return {
        status: 'invalid',
        message: 'A string, quoted name or comment is not closed.',
        start: first.start + token.start,
        end: first.start + token.end,
      };
    }
    if (token.kind === 'executable-comment') {
      return unsupported(
        'an executable comment (/*! … */)',
        first.start + token.start,
        first.start + token.end,
      );
    }
  }
  const tokens = all.filter((token) => !isTrivia(token.kind));
  const brackets = unbalanced(tokens);
  if (brackets) {
    const at = brackets.token!;
    return {
      status: 'invalid',
      message: brackets.message,
      start: first.start + at.start,
      end: first.start + at.end,
    };
  }
  try {
    const parser = new Parser(first.text, first.start, tokens, dialect, options);
    return { status: 'ok', model: parser.parse() };
  } catch (error) {
    if (error instanceof Stop) return error.failure;
    throw error;
  }
}

function unsupported(construct: string, start: number, end: number): Failure {
  return {
    status: 'unsupported',
    construct,
    message: `The query builder cannot show ${construct}.`,
    start,
    end,
  };
}

const COMPARISONS = new Set<string>([...COMPARISON_OPERATORS, '!=']);

/** Reserved words that are values, so an expression can end with them. */
const VALUE_WORDS = new Set([
  'END',
  'NULL',
  'TRUE',
  'FALSE',
  'CURRENT_DATE',
  'CURRENT_TIME',
  'CURRENT_TIMESTAMP',
  'LOCALTIME',
  'LOCALTIMESTAMP',
  'CURRENT_USER',
  'SESSION_USER',
  'USER',
]);

const JOIN_WORDS = ['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN'];

type Clause = 'FROM' | 'WHERE' | 'GROUP' | 'HAVING' | 'ORDER' | 'LIMIT' | 'OFFSET';

const CLAUSE_ORDER: readonly Clause[] = ['FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT'];

/** Groups written in parentheses, which stay nested; others come from AND/OR precedence. */
type Node = Criterion;

class Parser {
  private readonly postgres: boolean;
  private readonly tables: QueryTable[] = [];
  private readonly joins: QueryJoin[] = [];
  private readonly explicit = new WeakSet<CriteriaGroup>();
  private readonly counters = new Map<string, number>();
  private aliases: readonly string[] = [];

  constructor(
    private readonly text: string,
    private readonly base: number,
    private readonly tokens: readonly Token[],
    private readonly dialect: SqlDialect,
    private readonly options: QueryParseOptions,
  ) {
    this.postgres = dialect === 'postgres';
  }

  // Errors

  private unsupported(construct: string, token: Token | undefined, last = token): never {
    const start = this.base + (token?.start ?? this.text.length);
    const end = this.base + (last?.end ?? this.text.length);
    throw new Stop(unsupported(construct, start, end));
  }

  private invalid(message: string, token: Token | undefined): never {
    const start = this.base + (token?.start ?? this.text.length);
    const end = this.base + (token?.end ?? this.text.length);
    throw new Stop({ status: 'invalid', message, start, end });
  }

  private id(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}${next}`;
  }

  /** The statement text from token `from` through token `to` (inclusive), as written. */
  private source(from: number, to: number): string {
    return this.text.slice(this.tokens[from]!.start, this.tokens[to]!.end);
  }

  // The statement

  parse(): QueryModel {
    const tokens = this.tokens;
    const first = tokens[0];
    if (!first) this.invalid('There is no query.', undefined);
    if (isWord(first, 'WITH')) this.unsupported('a WITH clause (common table expression)', first);
    if (isPunct(first, '(')) this.unsupported('a query in parentheses', first);
    if (!isWord(first, 'SELECT')) {
      const word = wordOf(first);
      this.unsupported(
        word === '' ? 'a statement other than SELECT' : `${article(word)} ${word} statement`,
        first,
      );
    }
    this.checkWholeStatement();

    let start = 1;
    let distinct = false;
    if (isWord(tokens[1], 'DISTINCT')) {
      if (isWord(tokens[2], 'ON')) this.unsupported('DISTINCT ON', tokens[1], tokens[2]);
      distinct = true;
      start = 2;
    } else if (isWord(tokens[1], 'ALL')) {
      start = 2;
    }
    const modifier = tokens[start];
    if (
      !this.postgres &&
      isWord(
        modifier,
        'DISTINCTROW',
        'HIGH_PRIORITY',
        'STRAIGHT_JOIN',
        'SQL_SMALL_RESULT',
        'SQL_BIG_RESULT',
        'SQL_BUFFER_RESULT',
        'SQL_NO_CACHE',
        'SQL_CACHE',
        'SQL_CALC_FOUND_ROWS',
      )
    ) {
      this.unsupported(wordOf(modifier), modifier);
    }

    const clauses = this.clauses(start);
    const selectEnd = clauses[0]?.at ?? tokens.length;
    const range = (clause: Clause): [number, number] | undefined => {
      const index = clauses.findIndex((entry) => entry.clause === clause);
      if (index < 0) return undefined;
      const entry = clauses[index]!;
      return [entry.bodyStart, clauses[index + 1]?.at ?? tokens.length];
    };

    const from = range('FROM');
    if (from) this.fromClause(from[0], from[1]);
    const columns = this.selectList(start, selectEnd);
    this.aliases = columns.flatMap((item) =>
      item.kind === 'expr' && item.alias !== undefined ? [item.alias] : [],
    );
    const where = range('WHERE');
    const groupBy = range('GROUP');
    const having = range('HAVING');
    const orderBy = range('ORDER');
    const paging = this.paging(range('LIMIT'), range('OFFSET'));
    return {
      distinct,
      tables: this.tables,
      joins: this.joins,
      columns,
      where: where ? this.criteriaRoot(where[0], where[1], 'where', 'w') : emptyGroup('where'),
      groupBy: groupBy ? this.groupBy(groupBy[0], groupBy[1]) : [],
      having: having
        ? this.criteriaRoot(having[0], having[1], 'having', 'h')
        : emptyGroup('having'),
      orderBy: orderBy ? this.orderBy(orderBy[0], orderBy[1]) : [],
      ...paging,
    };
  }

  /** Constructs the builder cannot show wherever they are, most specific first. */
  private checkWholeStatement(): void {
    const tokens = this.tokens;
    scanTop(tokens, 0, tokens.length, (token, index) => {
      if (isWord(token, 'UNION', 'INTERSECT', 'EXCEPT')) {
        this.unsupported(`${wordOf(token) === 'UNION' ? 'a' : 'an'} ${wordOf(token)}`, token);
      }
      if (!this.postgres && isWord(token, 'MINUS') && isWord(tokens[index + 1], 'SELECT')) {
        this.unsupported('a MINUS', token);
      }
    });
    const inside = unsupportedInside(tokens, 1, tokens.length);
    if (inside) this.unsupported(inside.construct, inside.token);
  }

  /** Depth-0 clause keywords after the select list, checked for order. */
  private clauses(
    start: number,
  ): { readonly clause: Clause; readonly at: number; readonly bodyStart: number }[] {
    const tokens = this.tokens;
    const found: { clause: Clause; at: number; bodyStart: number }[] = [];
    scanTop(tokens, start, tokens.length, (token, index) => {
      const next = tokens[index + 1];
      const word = wordOf(token);
      switch (word) {
        case 'FROM':
          // IS [NOT] DISTINCT FROM is a comparison, not the FROM clause.
          if (!isWord(tokens[index - 1], 'DISTINCT')) {
            found.push({ clause: 'FROM', at: index, bodyStart: index + 1 });
          }
          break;
        case 'WHERE':
        case 'HAVING':
          found.push({ clause: word, at: index, bodyStart: index + 1 });
          break;
        case 'GROUP':
        case 'ORDER':
          if (isWord(next, 'BY')) found.push({ clause: word, at: index, bodyStart: index + 2 });
          break;
        case 'LIMIT':
          found.push({ clause: 'LIMIT', at: index, bodyStart: index + 1 });
          break;
        case 'OFFSET':
          // OFFSET is reserved in PostgreSQL; in MySQL only LIMIT … OFFSET uses it.
          if (this.postgres || found.some((entry) => entry.clause === 'LIMIT')) {
            found.push({ clause: 'OFFSET', at: index, bodyStart: index + 1 });
          }
          break;
        case 'FETCH':
          if (isWord(next, 'FIRST', 'NEXT')) this.unsupported('FETCH FIRST', token, next);
          break;
        case 'FOR':
          if (isWord(next, 'SYSTEM_TIME')) this.unsupported('FOR SYSTEM_TIME', token, next);
          this.unsupported('a locking clause (FOR UPDATE / FOR SHARE)', token);
          break;
        case 'LOCK':
          if (!this.postgres) this.unsupported('LOCK IN SHARE MODE', token);
          break;
        case 'INTO':
          this.unsupported('SELECT … INTO', token);
          break;
        case 'WINDOW':
          this.unsupported('a WINDOW clause', token);
          break;
        case 'PROCEDURE':
          if (!this.postgres) this.unsupported('PROCEDURE', token);
          break;
        default:
          break;
      }
    });
    let last = -1;
    for (const entry of found) {
      const rank = CLAUSE_ORDER.indexOf(entry.clause === 'OFFSET' ? 'LIMIT' : entry.clause);
      const again =
        entry.clause !== 'OFFSET' &&
        entry.clause !== 'LIMIT' &&
        found.filter((other) => other.clause === entry.clause).length > 1;
      if (rank < last || again) {
        this.invalid(
          `${this.tokens[entry.at]!.text.toUpperCase()} is out of place.`,
          this.tokens[entry.at],
        );
      }
      last = rank;
    }
    const limits = found.filter((entry) => entry.clause === 'LIMIT').length;
    const offsets = found.filter((entry) => entry.clause === 'OFFSET').length;
    if (limits > 1 || offsets > 1) {
      const twice = found.filter((entry) => entry.clause === (limits > 1 ? 'LIMIT' : 'OFFSET'))[1]!;
      this.invalid(
        `${this.tokens[twice.at]!.text.toUpperCase()} appears twice.`,
        this.tokens[twice.at],
      );
    }
    return found;
  }

  // FROM

  private fromClause(start: number, end: number): void {
    const tokens = this.tokens;
    if (start >= end) this.invalid('FROM needs a table.', tokens[start - 1]);
    let i = this.tableRef(start, end);
    const pending: { table: QueryTable; type: JoinType; on: [number, number]; at: Token }[] = [];
    while (i < end) {
      const token = tokens[i]!;
      if (isPunct(token, ',')) {
        i = this.tableRef(i + 1, end);
        continue;
      }
      const join = this.joinKeyword(i, end);
      const tableStart = join.next;
      const after = this.tableRef(tableStart, end);
      const table = this.tables.at(-1)!;
      if (isWord(tokens[after], 'USING')) this.unsupported('JOIN … USING', tokens[after]);
      if (isWord(tokens[after], 'ON')) {
        if (join.type === 'cross') this.invalid('CROSS JOIN takes no ON condition.', tokens[after]);
        const onEnd = this.joinEnd(after + 1, end);
        if (onEnd === after + 1) this.invalid('ON needs a condition.', tokens[after]);
        pending.push({ table, type: join.type, on: [after + 1, onEnd], at: token });
        i = onEnd;
      } else {
        if (join.type !== 'cross' && (join.type !== 'inner' || this.postgres)) {
          this.invalid('This JOIN needs an ON condition.', token);
        }
        i = after;
      }
    }
    // ON conditions are read once every table is known; each sees only the tables before it.
    for (const entry of pending) this.joinConditions(entry.table, entry.type, entry.on);
  }

  private joinKeyword(
    i: number,
    end: number,
  ): { readonly type: JoinType | 'cross'; readonly next: number } {
    const tokens = this.tokens;
    const token = tokens[i];
    const word = wordOf(token);
    if (word === 'NATURAL') this.unsupported('NATURAL JOIN', token);
    if (word === 'STRAIGHT_JOIN') this.unsupported('STRAIGHT_JOIN', token);
    let type: JoinType | 'cross';
    let at = i;
    if (word === 'JOIN') return { type: 'inner', next: i + 1 };
    if (word === 'INNER') type = 'inner';
    else if (word === 'CROSS') type = 'cross';
    else if (word === 'LEFT') type = 'left';
    else if (word === 'RIGHT') type = 'right';
    else if (word === 'FULL') type = 'full';
    else if (word === 'LATERAL') this.unsupported('LATERAL', token);
    else this.invalid(`Unexpected ${describe(token)} in FROM.`, token);
    at++;
    if ((type === 'left' || type === 'right' || type === 'full') && isWord(tokens[at], 'OUTER')) {
      at++;
    }
    if (!isWord(tokens[at], 'JOIN') || at >= end) {
      this.invalid(`${word} must be followed by JOIN.`, tokens[at] ?? token);
    }
    if (type === 'full' && !this.postgres) {
      this.unsupported(
        `FULL JOIN (${this.dialect === 'mariadb' ? 'MariaDB' : 'MySQL'} has no FULL JOIN)`,
        token,
        tokens[at],
      );
    }
    return { type, next: at + 1 };
  }

  /** Where an ON condition ends: the next depth-0 comma or join keyword. */
  private joinEnd(start: number, end: number): number {
    const tokens = this.tokens;
    const stop = scanTop(tokens, start, end, (token, index) => {
      if (isPunct(token, ',')) return true;
      if (!isWord(token, ...JOIN_WORDS)) return false;
      // LEFT(…) and RIGHT(…) are MySQL functions.
      return !isPunct(tokens[index + 1], '(');
    });
    return stop < 0 ? end : stop;
  }

  /** One table in FROM with its alias; returns the index after it. */
  private tableRef(start: number, end: number): number {
    const tokens = this.tokens;
    const token = tokens[start];
    if (start >= end || !token) this.invalid('A table name is missing.', tokens[start - 1]);
    if (isPunct(token, '(')) this.unsupported('a parenthesised join or subquery in FROM', token);
    if (isWord(token, 'LATERAL')) this.unsupported('LATERAL', token);
    if (isWord(token, 'ONLY') && this.postgres) this.unsupported('ONLY', token);
    const parts: string[] = [];
    let i = start;
    for (;;) {
      const part = tokens[i];
      if (i >= end || !isIdentifier(part, this.dialect)) {
        this.invalid(`Expected a table name, found ${describe(part)}.`, part ?? token);
      }
      const name = identifierName(part, this.dialect);
      if (name === undefined) this.unsupported('a Unicode-escaped name', part);
      parts.push(name);
      i++;
      if (!isPunct(tokens[i], '.')) break;
      i++;
    }
    if (isPunct(tokens[i], '(')) this.unsupported('a function in FROM', tokens[start], tokens[i]);
    if (parts.length > 2) this.unsupported('a three-part table name', tokens[start], tokens[i - 1]);
    let alias: string | undefined;
    if (isWord(tokens[i], 'AS')) {
      const name = tokens[i + 1];
      if (i + 1 >= end || !isIdentifier(name, this.dialect)) {
        this.invalid('AS must be followed by an alias.', tokens[i]);
      }
      alias = identifierName(name, this.dialect);
      i += 2;
    } else if (i < end && isAliasToken(tokens[i], this.dialect)) {
      alias = identifierName(tokens[i]!, this.dialect);
      i++;
    }
    if (isPunct(tokens[i], '(')) this.unsupported('a column alias list', tokens[i]);
    const extra = tokens[i];
    if (i < end && extra) {
      if (isWord(extra, 'TABLESAMPLE')) this.unsupported('TABLESAMPLE', extra);
      if (isWord(extra, 'PARTITION')) this.unsupported('PARTITION', extra);
      if (isWord(extra, 'USE', 'IGNORE', 'FORCE')) this.unsupported('an index hint', extra);
      if (!isPunct(extra, ',') && !isWord(extra, ...JOIN_WORDS, 'ON', 'USING', 'LATERAL')) {
        this.invalid(`Unexpected ${describe(extra)} after a table.`, extra);
      }
    }
    const table: QueryTable = {
      id: this.id('t'),
      name: parts[parts.length - 1]!,
      ...(parts.length === 2 ? { schema: parts[0]! } : {}),
      ...(alias === undefined ? {} : { alias }),
    };
    const reference = referenceName(table);
    if (this.tables.some((other) => this.sameName(referenceName(other), reference))) {
      this.invalid(`Two tables are called "${reference}".`, tokens[start]);
    }
    this.tables.push(table);
    return i;
  }

  private sameName(a: string, b: string): boolean {
    return this.postgres ? a === b : a.toLowerCase() === b.toLowerCase();
  }

  /** ON conditions of the join bringing in `table`: column comparisons with earlier tables. */
  private joinConditions(table: QueryTable, type: JoinType, [start, end]: [number, number]): void {
    const placed = this.tables.slice(0, this.tables.indexOf(table));
    const scope = [...placed, table];
    const node = this.criteria(start, end, 'on', scope);
    const items = node.kind === 'group' && node.op === 'and' && !node.negated ? node.items : [node];
    const byTable = new Map<string, JoinCondition[]>();
    const construct = 'a join condition other than column comparisons joined by AND';
    for (const item of items) {
      if (item.kind !== 'condition' || !COMPARISONS.has(item.operator)) {
        this.unsupported(construct, this.tokens[start], this.tokens[end - 1]);
      }
      const left = item.left;
      const right = item.values[0];
      if (left.kind !== 'column' || right?.kind !== 'column') {
        this.unsupported(construct, this.tokens[start], this.tokens[end - 1]);
      }
      const operator = item.operator as ComparisonOperator;
      let condition: [string, string, ComparisonOperator, string] | undefined;
      if (right.table === table.id && left.table !== undefined && left.table !== table.id) {
        condition = [left.table, left.column, operator, right.column];
      } else if (left.table === table.id && right.table !== undefined && right.table !== table.id) {
        condition = [right.table, right.column, flip(operator), left.column];
      }
      if (!condition) {
        this.unsupported(
          `a join condition that does not compare "${referenceName(table)}" with an earlier table`,
          this.tokens[start],
          this.tokens[end - 1],
        );
      }
      const [other, earlier, op, later] = condition;
      const list = byTable.get(other) ?? [];
      byTable.set(other, list);
      list.push({ left: earlier, operator: op, right: later });
    }
    for (const [other, conditions] of byTable) {
      this.joins.push({ id: this.id('j'), type, left: other, right: table.id, conditions });
    }
  }

  // Select list, GROUP BY, ORDER BY

  private selectList(start: number, end: number): SelectItem[] {
    const tokens = this.tokens;
    if (start >= end) this.invalid('SELECT needs at least one column.', tokens[start - 1]);
    return splitTopCommas(tokens, start, end).map(([from, to]) => {
      if (from >= to)
        this.invalid('A column is missing between commas.', tokens[from] ?? tokens[to]);
      if (to - from === 1 && isOperator(tokens[from], '*')) {
        return { kind: 'star', id: this.id('c') };
      }
      if (
        to - from === 3 &&
        isOperator(tokens[to - 1], '*') &&
        isPunct(tokens[from + 1], '.') &&
        isIdentifier(tokens[from], this.dialect)
      ) {
        const table = this.tableNamed([identifierName(tokens[from]!, this.dialect) ?? '']);
        if (table) return { kind: 'star', id: this.id('c'), table: table.id };
      }
      let exprEnd = to;
      let alias: string | undefined;
      const as = scanTop(tokens, from, to, (token) => isWord(token, 'AS'));
      if (as >= 0) {
        const name = tokens[as + 1];
        if (as + 2 !== to || !isIdentifier(name, this.dialect)) {
          this.invalid('AS must be followed by one name.', tokens[as]);
        }
        alias = identifierName(name, this.dialect);
        exprEnd = as;
      } else if (
        to - from >= 2 &&
        isAliasToken(tokens[to - 1], this.dialect) &&
        this.endsValue(tokens[to - 2]!)
      ) {
        alias = identifierName(tokens[to - 1]!, this.dialect);
        exprEnd = to - 1;
      }
      if (exprEnd <= from) this.invalid('A column has an alias but no expression.', tokens[from]);
      const expr = this.expr(from, exprEnd, this.tables);
      return {
        kind: 'expr',
        id: this.id('c'),
        expr,
        ...(alias === undefined ? {} : { alias }),
      };
    });
  }

  /** A token an expression can end with, so an identifier after it is an implicit alias. */
  private endsValue(token: Token): boolean {
    if (token.kind !== 'word') return endsOperand(token);
    return !isReserved(token.text, this.dialect) || VALUE_WORDS.has(wordOf(token));
  }

  private groupBy(start: number, end: number): GroupItem[] {
    const tokens = this.tokens;
    if (start >= end) this.invalid('GROUP BY needs a column.', tokens[start - 1]);
    const rollup = scanTop(tokens, start, end, (token) =>
      isWord(token, 'ROLLUP', 'CUBE', 'GROUPING', 'WITH'),
    );
    if (rollup >= 0) {
      const token = tokens[rollup]!;
      this.unsupported(
        isWord(token, 'WITH')
          ? 'WITH ROLLUP'
          : isWord(token, 'GROUPING')
            ? 'GROUPING SETS'
            : wordOf(token),
        token,
      );
    }
    return splitTopCommas(tokens, start, end).map(([from, to]) => {
      if (from >= to) this.invalid('A column is missing between commas.', tokens[from]);
      return { id: this.id('g'), expr: this.expr(from, to, this.tables) };
    });
  }

  private orderBy(start: number, end: number): OrderItem[] {
    const tokens = this.tokens;
    if (start >= end) this.invalid('ORDER BY needs a column.', tokens[start - 1]);
    return splitTopCommas(tokens, start, end).map(([from, to]) => {
      if (from >= to) this.invalid('A column is missing between commas.', tokens[from]);
      let last = to;
      let nulls: 'first' | 'last' | undefined;
      if (isWord(tokens[last - 2], 'NULLS') && isWord(tokens[last - 1], 'FIRST', 'LAST')) {
        nulls = isWord(tokens[last - 1], 'FIRST') ? 'first' : 'last';
        last -= 2;
      }
      let direction: 'asc' | 'desc' = 'asc';
      if (isWord(tokens[last - 1], 'ASC', 'DESC')) {
        direction = isWord(tokens[last - 1], 'DESC') ? 'desc' : 'asc';
        last--;
      }
      const using = scanTop(tokens, from, last, (token) => isWord(token, 'USING'));
      if (using >= 0) this.unsupported('ORDER BY … USING', tokens[using]);
      if (last <= from) this.invalid('A sort needs a column.', tokens[from]);
      return {
        id: this.id('o'),
        expr: this.expr(from, last, this.tables, true),
        direction,
        ...(nulls === undefined ? {} : { nulls }),
      };
    });
  }

  private paging(
    limit: [number, number] | undefined,
    offset: [number, number] | undefined,
  ): { limit?: number; offset?: number } {
    const tokens = this.tokens;
    const out: { limit?: number; offset?: number } = {};
    const count = (index: number, label: string): number | undefined => {
      const token = tokens[index];
      if (token?.kind === 'parameter') {
        this.unsupported(`a ${label} that is not a number`, token);
      }
      if (token?.kind !== 'number' || !/^\d+$/.test(token.text)) {
        this.invalid(`${label} needs a whole number.`, token ?? tokens[index - 1]);
      }
      if (label === 'LIMIT' && !this.postgres && token.text === MYSQL_NO_LIMIT) return undefined;
      const value = Number(token.text);
      if (!Number.isSafeInteger(value)) this.invalid(`${label} is too large.`, token);
      return value;
    };
    if (limit) {
      const [start, end] = limit;
      if (this.postgres && end - start === 1 && isWord(tokens[start], 'ALL')) {
        // LIMIT ALL: no limit.
      } else if (!this.postgres && end - start === 3 && isPunct(tokens[start + 1], ',')) {
        const skip = count(start, 'OFFSET');
        const rows = count(start + 2, 'LIMIT');
        if (skip !== undefined && skip !== 0) out.offset = skip;
        if (rows !== undefined) out.limit = rows;
      } else {
        if (end - start !== 1)
          this.invalid('LIMIT takes one number.', tokens[start + 1] ?? tokens[start]);
        const rows = count(start, 'LIMIT');
        if (rows !== undefined) out.limit = rows;
      }
    }
    if (offset) {
      const [start, end] = offset;
      const rowsWord =
        this.postgres && end - start === 2 && isWord(tokens[start + 1], 'ROW', 'ROWS');
      if (end - start !== 1 && !rowsWord) {
        this.invalid('OFFSET takes one number.', tokens[start + 1] ?? tokens[start]);
      }
      const skip = count(start, 'OFFSET');
      if (skip !== undefined) out.offset = skip;
    }
    return out;
  }

  // Criteria

  private criteriaRoot(start: number, end: number, id: string, prefix: string): CriteriaGroup {
    if (start >= end) this.invalid('A condition is missing.', this.tokens[start - 1]);
    const node = this.criteria(start, end, prefix, this.tables);
    if (node.kind === 'group' && !node.negated && !this.explicit.has(node)) {
      return { ...node, id };
    }
    return { kind: 'group', id, op: 'and', items: [node] };
  }

  private criteria(start: number, end: number, prefix: string, scope: readonly QueryTable[]): Node {
    const parts = this.splitLogic(start, end, 'OR');
    if (parts.length === 1) return this.conjunction(start, end, prefix, scope);
    return {
      kind: 'group',
      id: this.id(prefix),
      op: 'or',
      items: parts.map(([from, to]) => this.conjunction(from, to, prefix, scope)),
    };
  }

  private conjunction(
    start: number,
    end: number,
    prefix: string,
    scope: readonly QueryTable[],
  ): Node {
    const parts = this.splitLogic(start, end, 'AND');
    if (parts.length === 1) return this.negation(start, end, prefix, scope);
    return {
      kind: 'group',
      id: this.id(prefix),
      op: 'and',
      items: parts.map(([from, to]) => this.negation(from, to, prefix, scope)),
    };
  }

  /** Splits at depth-0 AND or OR; the AND of BETWEEN … AND … is not a split. */
  private splitLogic(start: number, end: number, word: 'AND' | 'OR'): [number, number][] {
    const tokens = this.tokens;
    const parts: [number, number][] = [];
    let from = start;
    let between = false;
    scanTop(tokens, start, end, (token, index) => {
      if (isWord(token, 'BETWEEN')) between = true;
      else if (isWord(token, word)) {
        if (word === 'AND' && between) {
          between = false;
          return;
        }
        if (index === from) this.invalid(`${word} needs a condition before it.`, token);
        parts.push([from, index]);
        from = index + 1;
      }
    });
    if (from >= end) this.invalid(`${word} needs a condition after it.`, tokens[end - 1]);
    parts.push([from, end]);
    return parts;
  }

  private negation(start: number, end: number, prefix: string, scope: readonly QueryTable[]): Node {
    const tokens = this.tokens;
    if (isWord(tokens[start], 'NOT') && start + 1 < end) {
      const inner = this.negation(start + 1, end, prefix, scope);
      if (inner.kind === 'group' && this.explicit.has(inner) && !inner.negated) {
        const negated: CriteriaGroup = { ...inner, negated: true };
        this.explicit.add(negated);
        return negated;
      }
      const wrapped: CriteriaGroup = {
        kind: 'group',
        id: this.id(prefix),
        op: 'and',
        negated: true,
        items: [inner],
      };
      this.explicit.add(wrapped);
      return wrapped;
    }
    if (isPunct(tokens[start], '(') && closingIndex(tokens, start, end) === end - 1) {
      if (end - start === 2) this.invalid('Empty parentheses.', tokens[start]);
      const inner = this.criteria(start + 1, end - 1, prefix, scope);
      if (inner.kind === 'group') this.explicit.add(inner);
      return inner;
    }
    return this.predicate(start, end, prefix, scope);
  }

  /** One condition; anything the rows cannot show becomes a condition written as SQL. */
  private predicate(
    start: number,
    end: number,
    prefix: string,
    scope: readonly QueryTable[],
  ): Node {
    const tokens = this.tokens;
    const custom = (): Node => ({
      kind: 'custom',
      id: this.id(prefix),
      sql: this.source(start, end - 1),
    });
    let at = -1;
    let negated = false;
    scanTop(tokens, start, end, (token, index) => {
      if (index === start) return false;
      if (token.kind === 'operator' && COMPARISONS.has(token.text)) {
        at = index;
        return true;
      }
      if (isWord(token, 'NOT') && isWord(tokens[index + 1], 'LIKE', 'ILIKE', 'IN', 'BETWEEN')) {
        at = index + 1;
        negated = true;
        return true;
      }
      if (isWord(token, 'IS', 'LIKE', 'ILIKE', 'IN', 'BETWEEN')) {
        at = index;
        return true;
      }
      return false;
    });
    if (at < 0) return custom();
    const leftEnd = negated ? at - 1 : at;
    const left = this.expr(start, leftEnd, scope);
    const token = tokens[at]!;
    const condition = (operator: CriteriaOperator, values: QueryExpr[]): Condition => ({
      kind: 'condition',
      id: this.id(prefix),
      left,
      operator,
      values,
    });
    if (token.kind === 'operator') {
      if (at + 1 >= end) this.invalid(`${token.text} needs a value.`, token);
      const operator = (token.text === '!=' ? '<>' : token.text) as ComparisonOperator;
      // `a = ANY (…)`, `a > ALL (…)`: array and subquery comparisons.
      if (isWord(tokens[at + 1], 'ANY', 'ALL', 'SOME')) return custom();
      return condition(operator, [this.expr(at + 1, end, scope)]);
    }
    const word = wordOf(token);
    if (word === 'IS') {
      if (isWord(tokens[at + 1], 'NULL') && at + 2 === end) return condition('is null', []);
      if (isWord(tokens[at + 1], 'NOT') && isWord(tokens[at + 2], 'NULL') && at + 3 === end) {
        return condition('is not null', []);
      }
      return custom();
    }
    if (word === 'LIKE' || word === 'ILIKE') {
      if (at + 1 >= end) this.invalid(`${word} needs a pattern.`, token);
      if (scanTop(tokens, at + 1, end, (t) => isWord(t, 'ESCAPE')) >= 0) return custom();
      const operator = `${negated ? 'not ' : ''}${word.toLowerCase()}` as CriteriaOperator;
      return condition(operator, [this.expr(at + 1, end, scope)]);
    }
    if (word === 'IN') {
      const open = at + 1;
      if (!isPunct(tokens[open], '(')) return custom();
      const close = closingIndex(tokens, open, end);
      if (close !== end - 1) return custom();
      if (close === open + 1) this.invalid('IN needs at least one value.', tokens[open]);
      const values = splitTopCommas(tokens, open + 1, close).map(([from, to]) => {
        if (from >= to) this.invalid('A value is missing between commas.', tokens[from]);
        return this.expr(from, to, scope);
      });
      return condition(negated ? 'not in' : 'in', values);
    }
    // BETWEEN
    if (isWord(tokens[at + 1], 'SYMMETRIC', 'ASYMMETRIC')) return custom();
    const and = scanTop(tokens, at + 1, end, (t) => isWord(t, 'AND'));
    if (and < 0) this.invalid('BETWEEN needs AND.', token);
    if (and === at + 1 || and + 1 >= end) this.invalid('BETWEEN needs two values.', token);
    return condition(negated ? 'not between' : 'between', [
      this.expr(at + 1, and, scope),
      this.expr(and + 1, end, scope),
    ]);
  }

  // Expressions

  /** An expression in tokens[start, end): a column, aggregate, literal, placeholder or raw SQL. */
  private expr(
    start: number,
    end: number,
    scope: readonly QueryTable[],
    orderBy = false,
  ): QueryExpr {
    const tokens = this.tokens;
    if (start >= end) this.invalid('An expression is missing.', tokens[start] ?? tokens[start - 1]);
    const raw = (): QueryExpr => ({ kind: 'raw', sql: this.source(start, end - 1) });
    const first = tokens[start]!;
    const count = end - start;
    if (count === 1) {
      switch (first.kind) {
        case 'string': {
          const value = stringValue(first, this.dialect);
          return value === undefined ? raw() : { kind: 'string', value };
        }
        case 'number':
          return DECIMAL_NUMBER.test(first.text) ? { kind: 'number', value: first.text } : raw();
        case 'parameter':
          return isParameterText(first.text, this.dialect)
            ? { kind: 'parameter', text: first.text }
            : raw();
        case 'word':
          if (isWord(first, 'TRUE', 'FALSE')) {
            return { kind: 'boolean', value: isWord(first, 'TRUE') };
          }
          if (isReserved(first.text, this.dialect)) return raw();
          return this.column([], identifierName(first, this.dialect)!, scope, orderBy) ?? raw();
        case 'quoted-identifier': {
          const name = identifierName(first, this.dialect);
          if (name === undefined) return raw();
          return this.column([], name, scope, orderBy) ?? raw();
        }
        default:
          return raw();
      }
    }
    if (count === 2 && isOperator(first, '-') && tokens[start + 1]!.kind === 'number') {
      const value = `-${tokens[start + 1]!.text}`;
      return DECIMAL_NUMBER.test(value) ? { kind: 'number', value } : raw();
    }
    if ((count === 3 || count === 5) && this.isDotted(start, end)) {
      const names: string[] = [];
      for (let i = start; i < end; i += 2) {
        const name = identifierName(tokens[i]!, this.dialect);
        if (name === undefined) return raw();
        names.push(name);
      }
      return this.column(names.slice(0, -1), names.at(-1)!, scope, false) ?? raw();
    }
    const aggregate = this.aggregate(start, end, scope);
    return aggregate ?? raw();
  }

  /** `a.b` or `a.b.c` made of identifiers. */
  private isDotted(start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
      const token = this.tokens[i];
      if ((i - start) % 2 === 0 ? !isIdentifier(token, this.dialect) : !isPunct(token, '.')) {
        return false;
      }
    }
    return true;
  }

  private aggregate(
    start: number,
    end: number,
    scope: readonly QueryTable[],
  ): QueryExpr | undefined {
    const tokens = this.tokens;
    const name = wordOf(tokens[start]).toLowerCase();
    if (!AGGREGATE_FUNCTIONS.includes(name as AggregateFunction)) return undefined;
    if (!isPunct(tokens[start + 1], '(') || closingIndex(tokens, start + 1, end) !== end - 1) {
      return undefined;
    }
    const fn = name as AggregateFunction;
    let from = start + 2;
    const to = end - 1;
    if (from >= to) return undefined;
    if (to - from === 1 && isOperator(tokens[from], '*')) {
      return fn === 'count' ? { kind: 'aggregate', fn } : undefined;
    }
    let distinct = false;
    if (isWord(tokens[from], 'DISTINCT')) {
      distinct = true;
      from++;
    }
    if (from >= to || isWord(tokens[from], 'ALL')) return undefined;
    // Several arguments or an ORDER BY inside: not one of the builder's aggregates.
    const extra = scanTop(
      tokens,
      from,
      to,
      (token) => isPunct(token, ',') || isWord(token, 'ORDER'),
    );
    if (extra >= 0) return undefined;
    const arg = this.expr(from, to, scope);
    return { kind: 'aggregate', fn, ...(distinct ? { distinct } : {}), arg };
  }

  /**
   * A column by its qualifier parts (`t`, or `schema.table` for a table without alias) and
   * name; undefined when a qualifier matches no table (the expression then stays raw SQL).
   */
  private column(
    qualifier: readonly string[],
    column: string,
    scope: readonly QueryTable[],
    orderBy: boolean,
  ): QueryExpr | undefined {
    if (qualifier.length > 0) {
      const table = this.tableNamed(qualifier, scope);
      return table ? { kind: 'column', table: table.id, column } : undefined;
    }
    // ORDER BY a select-list alias sorts by that output column.
    if (orderBy && this.aliases.some((alias) => this.sameName(alias, column))) {
      return { kind: 'column', column };
    }
    if (scope.length === 1) return { kind: 'column', table: scope[0]!.id, column };
    const columnsOf = this.options.columnsOf;
    if (columnsOf) {
      const owners = scope.filter((table) =>
        (columnsOf(table) ?? []).some((name) =>
          this.postgres ? name === column : name.toLowerCase() === column.toLowerCase(),
        ),
      );
      if (owners.length === 1) return { kind: 'column', table: owners[0]!.id, column };
    }
    return { kind: 'column', column };
  }

  /** The table a qualifier names: its alias or name, or `schema.name` without an alias. */
  private tableNamed(
    qualifier: readonly string[],
    scope: readonly QueryTable[] = this.tables,
  ): QueryTable | undefined {
    if (qualifier.length === 1) {
      const name = qualifier[0]!;
      const exact = scope.find((table) => referenceName(table) === name);
      if (exact || this.postgres) return exact;
      const loose = scope.filter((table) => this.sameName(referenceName(table), name));
      return loose.length === 1 ? loose[0] : undefined;
    }
    if (qualifier.length === 2) {
      const [schema, name] = qualifier as [string, string];
      return scope.find(
        (table) =>
          (table.alias === undefined || table.alias === '') &&
          table.schema !== undefined &&
          this.sameName(table.schema, schema) &&
          this.sameName(table.name, name),
      );
    }
    return undefined;
  }
}

function flip(operator: ComparisonOperator): ComparisonOperator {
  const flipped: Record<ComparisonOperator, ComparisonOperator> = {
    '=': '=',
    '<>': '<>',
    '<': '>',
    '<=': '>=',
    '>': '<',
    '>=': '<=',
  };
  return flipped[operator];
}

function article(word: string): string {
  return /^[AEIOU]/i.test(word) ? 'an' : 'a';
}

function describe(token: Token | undefined): string {
  if (!token) return 'the end of the query';
  return `"${token.text.length > 24 ? `${token.text.slice(0, 24)}…` : token.text}"`;
}
