import { Double, Int32, Long, ObjectId } from 'bson';

import type { BsonValue } from '../bson';
import { parseIsoDate } from '../shell/parser';
import type {
  AggregateName,
  ColumnExpr,
  CompareOp,
  CountClause,
  Expr,
  JoinClause,
  OrderItem,
  SelectItem,
  SelectStatement,
  SqlRange,
  TableRef,
} from './ast';
import { SqlTranslationError, type SqlTranslationErrorCode } from './errors';
import { tokenizeSql, type SqlToken } from './lexer';

/**
 * A recursive-descent parser for the SELECT subset `sqlToMql` translates. It parses a little
 * more than the translator supports so that it can name what is unsupported ("Subqueries are
 * not supported") instead of reporting a bare syntax error.
 */

/** Words that cannot be unquoted identifiers or aliases. */
const RESERVED = new Set([
  'ALL',
  'AND',
  'AS',
  'ASC',
  'BETWEEN',
  'BY',
  'CASE',
  'CROSS',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'ESCAPE',
  'EXCEPT',
  'EXISTS',
  'FALSE',
  'FETCH',
  'FOR',
  'FROM',
  'FULL',
  'GROUP',
  'HAVING',
  'ILIKE',
  'IN',
  'INNER',
  'INTERSECT',
  'IS',
  'JOIN',
  'LEFT',
  'LIKE',
  'LIMIT',
  'NATURAL',
  'NOT',
  'NULL',
  'OFFSET',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'RIGHT',
  'SELECT',
  'THEN',
  'TRUE',
  'UNION',
  'USING',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
]);

const AGGREGATES = new Set<AggregateName>(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);
const COMPARE_OPS = new Map<string, CompareOp>([
  ['=', '='],
  ['<>', '<>'],
  ['!=', '<>'],
  ['<', '<'],
  ['<=', '<='],
  ['>', '>'],
  ['>=', '>='],
]);
const STATEMENT_WORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'MERGE',
  'UPSERT',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'SHOW',
  'DESCRIBE',
  'EXPLAIN',
  'CALL',
  'SET',
  'USE',
  'VALUES',
  'TABLE',
]);

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

export interface SqlParseOptions {
  /** Deepest nesting of parentheses and NOTs; default 200. */
  readonly maxDepth?: number;
}

export class SqlParser {
  private readonly tokens: SqlToken[];
  private index = 0;
  private depth = 0;
  private readonly maxDepth: number;

  constructor(
    private readonly sql: string,
    options: SqlParseOptions = {},
  ) {
    this.tokens = tokenizeSql(sql);
    this.maxDepth = options.maxDepth ?? 200;
  }

  // ---------------------------------------------------------------------------------------------
  // Token helpers

  private peek(offset = 0): SqlToken {
    return this.tokens[Math.min(this.index + offset, this.tokens.length - 1)]!;
  }

  private next(): SqlToken {
    const token = this.peek();
    if (this.index < this.tokens.length - 1) this.index += 1;
    return token;
  }

  private isWord(token: SqlToken, ...words: string[]): boolean {
    return token.kind === 'word' && words.includes(token.upper);
  }

  private isOp(token: SqlToken, ...ops: string[]): boolean {
    return token.kind === 'op' && ops.includes(token.value);
  }

  private acceptWord(...words: string[]): SqlToken | undefined {
    return this.isWord(this.peek(), ...words) ? this.next() : undefined;
  }

  private acceptOp(op: string): SqlToken | undefined {
    return this.isOp(this.peek(), op) ? this.next() : undefined;
  }

  private expectWord(word: string): SqlToken {
    const token = this.peek();
    if (!this.isWord(token, word)) this.unexpected(token, word);
    return this.next();
  }

  private expectOp(op: string): SqlToken {
    const token = this.peek();
    if (!this.isOp(token, op)) this.unexpected(token, `'${op}'`);
    return this.next();
  }

  fail(
    range: SqlRange,
    reason: string,
    code: SqlTranslationErrorCode = 'VALIDATION_FAILED',
    hint?: string,
  ): never {
    throw new SqlTranslationError(this.sql, code, range, reason, hint);
  }

  private unsupported(range: SqlRange, reason: string, hint?: string): never {
    this.fail(range, reason, 'NOT_SUPPORTED', hint);
  }

  private describe(token: SqlToken): string {
    switch (token.kind) {
      case 'eof':
        return 'the end of the statement';
      case 'string':
        return 'a string';
      case 'number':
        return `the number ${token.value}`;
      case 'quoted':
        return `the name "${token.value}"`;
      default:
        return `"${token.value}"`;
    }
  }

  private unexpected(token: SqlToken, expected?: string): never {
    this.unsupportedToken(token);
    this.fail(
      token,
      expected
        ? `Expected ${expected} but found ${this.describe(token)}`
        : `Unexpected ${this.describe(token)}`,
    );
  }

  /** Names SQL the translator knows but does not support, wherever it turns up. */
  private unsupportedToken(token: SqlToken): void {
    if (token.kind === 'op') {
      switch (token.value) {
        case '?':
        case ':':
        case '$':
        case '@':
          this.unsupported(token, 'Parameters and variables are not supported');
          break;
        case '||':
          this.unsupported(token, 'String concatenation is not supported');
          break;
        case '::':
          this.unsupported(token, 'Casts are not supported');
          break;
        case '+':
        case '-':
        case '*':
        case '/':
        case '%':
          this.unsupported(token, 'Arithmetic is not supported');
          break;
        default:
          return;
      }
    }
    if (token.kind !== 'word') return;
    switch (token.upper) {
      case 'UNION':
      case 'INTERSECT':
      case 'EXCEPT':
        this.unsupported(
          token,
          `${token.upper} is not supported`,
          'Translate each SELECT on its own',
        );
        break;
      case 'CASE':
        this.unsupported(token, 'CASE expressions are not supported');
        break;
      case 'EXISTS':
        this.unsupported(token, 'Subqueries are not supported');
        break;
      case 'WINDOW':
      case 'OVER':
        this.unsupported(token, 'Window functions are not supported');
        break;
      case 'FETCH':
        this.unsupported(token, 'FETCH FIRST is not supported', 'Use LIMIT');
        break;
      case 'FOR':
        this.unsupported(token, 'Locking clauses are not supported');
        break;
      default:
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Statement

  parseStatement(): SelectStatement {
    const first = this.peek();
    if (first.kind === 'eof') this.fail(first, 'Enter a SELECT statement to translate');
    if (this.isWord(first, 'WITH')) {
      this.unsupported(first, 'Common table expressions (WITH) are not supported');
    }
    if (first.kind === 'word' && STATEMENT_WORDS.has(first.upper)) {
      this.unsupported(first, 'Only SELECT statements can be translated');
    }
    if (this.isOp(first, '(')) {
      this.unsupported(first, 'A parenthesised query is not supported', 'Remove the parentheses');
    }
    const statement = this.select();
    this.acceptOp(';');
    const end = this.peek();
    if (end.kind !== 'eof') {
      if (this.tokens[this.index - 1]?.value === ';') {
        this.unsupported(end, 'Only one statement can be translated at a time');
      }
      this.unexpected(end);
    }
    return statement;
  }

  private select(): SelectStatement {
    this.expectWord('SELECT');
    let distinct = false;
    if (this.acceptWord('DISTINCT')) {
      distinct = true;
      if (this.isWord(this.peek(), 'ON')) {
        this.unsupported(this.peek(), 'DISTINCT ON is not supported');
      }
    } else {
      this.acceptWord('ALL');
    }
    if (this.isWord(this.peek(), 'TOP') && this.peek(1).kind === 'number') {
      this.unsupported(this.peek(), 'TOP is not supported', 'Use LIMIT');
    }
    const items = this.selectList();
    const fromToken = this.peek();
    if (!this.isWord(fromToken, 'FROM')) {
      if (fromToken.kind === 'eof') {
        this.fail(fromToken, 'Expected FROM and a collection', 'VALIDATION_FAILED');
      }
      this.unexpected(fromToken, 'FROM');
    }
    this.next();
    const from = this.tableRef();
    if (this.isOp(this.peek(), ',')) {
      this.unsupported(this.peek(), 'Comma-separated tables are not supported', 'Use JOIN ... ON');
    }
    const joins: JoinClause[] = [];
    for (;;) {
      const join = this.join();
      if (!join) break;
      joins.push(join);
    }
    const where = this.acceptWord('WHERE') ? this.expr() : undefined;
    const groupBy: Expr[] = [];
    if (this.acceptWord('GROUP')) {
      this.expectWord('BY');
      if (this.isWord(this.peek(), 'ROLLUP', 'CUBE', 'GROUPING')) {
        this.unsupported(this.peek(), `${this.peek().upper} is not supported`);
      }
      do groupBy.push(this.expr());
      while (this.acceptOp(','));
    }
    const having = this.acceptWord('HAVING') ? this.expr() : undefined;
    if (this.isWord(this.peek(), 'WINDOW')) this.unsupportedToken(this.peek());
    const orderBy: OrderItem[] = [];
    if (this.acceptWord('ORDER')) {
      this.expectWord('BY');
      do orderBy.push(this.orderItem());
      while (this.acceptOp(','));
    }
    let limit: CountClause | undefined;
    let offset: CountClause | undefined;
    for (;;) {
      const token = this.peek();
      if (this.isWord(token, 'LIMIT') && limit === undefined) {
        this.next();
        const first = this.count('LIMIT');
        if (this.acceptOp(',')) {
          if (offset !== undefined) this.fail(first, 'OFFSET is given twice');
          offset = first;
          limit = this.count('LIMIT');
        } else {
          limit = first;
        }
      } else if (this.isWord(token, 'OFFSET') && offset === undefined) {
        this.next();
        offset = this.count('OFFSET');
        this.acceptWord('ROW', 'ROWS');
      } else {
        break;
      }
    }
    return {
      distinct,
      items,
      from,
      joins,
      ...(where !== undefined ? { where } : {}),
      groupBy,
      ...(having !== undefined ? { having } : {}),
      orderBy,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    };
  }

  private count(clause: string): CountClause {
    const token = this.next();
    if (token.kind !== 'number' || !/^\d+$/.test(token.value)) {
      if (this.isWord(token, 'ALL') && clause === 'LIMIT') {
        this.unsupported(token, 'LIMIT ALL is not supported', 'Leave LIMIT out');
      }
      if (this.isOp(token, '?', ':', '$', '@')) this.unsupportedToken(token);
      this.fail(token, `${clause} expects a whole number`);
    }
    const value = Number(token.value);
    if (!Number.isSafeInteger(value)) this.fail(token, `${clause} is too large`);
    return { value, start: token.start, end: token.end };
  }

  // ---------------------------------------------------------------------------------------------
  // Select list, tables and joins

  private selectList(): SelectItem[] {
    const items: SelectItem[] = [];
    do {
      const token = this.peek();
      if (this.isOp(token, '*')) {
        this.next();
        items.push({ kind: 'star', start: token.start, end: token.end });
        continue;
      }
      if (this.isWord(token, 'FROM') || token.kind === 'eof') {
        this.fail(token, 'Expected a column, * or an aggregate before FROM');
      }
      const star = this.qualifiedStar();
      if (star) {
        items.push(star);
        continue;
      }
      const expr = this.expr();
      const alias = this.alias(true);
      items.push({
        kind: 'expr',
        expr,
        start: expr.start,
        end: alias?.range.end ?? expr.end,
        ...(alias ? { alias: alias.name, aliasRange: alias.range } : {}),
      });
    } while (this.acceptOp(','));
    return items;
  }

  /** `name.*` or `a.b.*`; undefined (consuming nothing) when the tokens are something else. */
  private qualifiedStar(): SelectItem | undefined {
    let offset = 0;
    const parts: string[] = [];
    for (;;) {
      const name = this.peek(offset);
      if (!this.isIdentifier(name) || !this.isOp(this.peek(offset + 1), '.')) return undefined;
      parts.push(name.value);
      const after = this.peek(offset + 2);
      if (this.isOp(after, '*')) {
        const start = this.peek().start;
        this.index += offset + 3;
        return { kind: 'star', qualifier: parts, start, end: after.end };
      }
      offset += 2;
    }
  }

  private isIdentifier(token: SqlToken): boolean {
    return token.kind === 'quoted' || (token.kind === 'word' && !RESERVED.has(token.upper));
  }

  /** An identifier's name, failing on a reserved word or anything else. */
  private identifier(what: string): SqlToken {
    const token = this.peek();
    if (token.kind === 'quoted') {
      this.next();
      return token;
    }
    if (token.kind === 'word' && !RESERVED.has(token.upper)) {
      this.next();
      return token;
    }
    if (token.kind === 'word') {
      this.unsupportedToken(token);
      this.fail(
        token,
        `Expected ${what} but found the keyword ${token.upper}`,
        'VALIDATION_FAILED',
        `Quote it to use it as a name: "${token.value}"`,
      );
    }
    this.unexpected(token, what);
  }

  /** `[AS] alias`; a bare alias only where `bare` allows it. */
  private alias(bare: boolean): { name: string; range: SqlRange } | undefined {
    const as = this.acceptWord('AS');
    const token = this.peek();
    if (as) {
      if (token.kind === 'string') {
        this.next();
        return { name: token.value, range: token };
      }
      const name = this.identifier('an alias after AS');
      return { name: name.value, range: name };
    }
    if (bare && this.isIdentifier(token)) {
      this.next();
      return { name: token.value, range: token };
    }
    return undefined;
  }

  private tableRef(): TableRef {
    const token = this.peek();
    if (this.isOp(token, '(')) {
      this.unsupported(token, 'Subqueries are not supported');
    }
    const first = this.identifier('a collection name');
    const parts = [first.value];
    let end = first.end;
    while (this.isOp(this.peek(), '.')) {
      this.next();
      const part = this.pathPart('a collection name');
      parts.push(part.value);
      end = part.end;
    }
    if (this.isOp(this.peek(), '(')) {
      this.unsupported(this.peek(), 'Table functions are not supported');
    }
    const alias = this.alias(true);
    return {
      name: parts.join('.'),
      parts,
      start: first.start,
      end: alias?.range.end ?? end,
      ...(alias ? { alias: alias.name } : {}),
    };
  }

  private join(): JoinClause | undefined {
    const token = this.peek();
    let type: 'inner' | 'left';
    if (this.isWord(token, 'JOIN')) {
      type = 'inner';
    } else if (this.isWord(token, 'INNER')) {
      this.next();
      type = 'inner';
    } else if (this.isWord(token, 'LEFT')) {
      this.next();
      this.acceptWord('OUTER');
      type = 'left';
    } else if (this.isWord(token, 'RIGHT', 'FULL')) {
      this.unsupported(
        token,
        `${token.upper} JOIN is not supported`,
        'Swap the tables and use LEFT JOIN',
      );
    } else if (this.isWord(token, 'CROSS', 'NATURAL')) {
      this.unsupported(token, `${token.upper} JOIN is not supported`, 'Use JOIN ... ON');
    } else {
      return undefined;
    }
    this.expectWord('JOIN');
    const table = this.tableRef();
    const on = this.peek();
    if (this.isWord(on, 'USING')) this.unsupported(on, 'JOIN ... USING is not supported', 'Use ON');
    if (!this.isWord(on, 'ON')) this.unexpected(on, 'ON');
    this.next();
    const condition = this.expr();
    return { type, table, on: condition, start: token.start, end: condition.end };
  }

  private orderItem(): OrderItem {
    const expr = this.expr();
    let end = expr.end;
    let descending = false;
    const direction = this.acceptWord('ASC', 'DESC');
    if (direction) {
      descending = direction.upper === 'DESC';
      end = direction.end;
    }
    let nulls: 'first' | 'last' | undefined;
    if (this.isWord(this.peek(), 'NULLS')) {
      this.next();
      const which = this.peek();
      if (!this.isWord(which, 'FIRST', 'LAST')) this.unexpected(which, 'FIRST or LAST');
      this.next();
      nulls = which.upper === 'FIRST' ? 'first' : 'last';
      end = which.end;
    }
    return { expr, descending, start: expr.start, end, ...(nulls ? { nulls } : {}) };
  }

  // ---------------------------------------------------------------------------------------------
  // Expressions

  private enter(token: SqlToken): void {
    this.depth += 1;
    if (this.depth > this.maxDepth) this.fail(token, 'The expression is nested too deeply');
  }

  expr(): Expr {
    return this.or();
  }

  private or(): Expr {
    const first = this.and();
    if (!this.isWord(this.peek(), 'OR')) return first;
    const items = [first];
    while (this.acceptWord('OR')) items.push(this.and());
    return { kind: 'or', items, start: first.start, end: items[items.length - 1]!.end };
  }

  private and(): Expr {
    const first = this.not();
    if (!this.isWord(this.peek(), 'AND')) return first;
    const items = [first];
    while (this.acceptWord('AND')) items.push(this.not());
    return { kind: 'and', items, start: first.start, end: items[items.length - 1]!.end };
  }

  private not(): Expr {
    const token = this.peek();
    if (!this.isWord(token, 'NOT')) return this.predicate();
    this.next();
    this.enter(token);
    const expr = this.not();
    this.depth -= 1;
    return { kind: 'not', expr, start: token.start, end: expr.end };
  }

  private predicate(): Expr {
    const left = this.operand();
    const token = this.peek();
    const op = token.kind === 'op' ? COMPARE_OPS.get(token.value) : undefined;
    if (op) {
      this.next();
      if (this.isWord(this.peek(), 'ANY', 'ALL', 'SOME')) {
        this.unsupported(this.peek(), 'Subqueries are not supported');
      }
      const right = this.operand();
      return { kind: 'compare', op, left, right, start: left.start, end: right.end };
    }
    if (this.isOp(token, '==')) this.fail(token, 'Unexpected "=="', 'VALIDATION_FAILED', 'Use =');
    if (this.isWord(token, 'IS')) {
      this.next();
      const negated = this.acceptWord('NOT') !== undefined;
      const what = this.next();
      if (this.isWord(what, 'NULL', 'UNKNOWN')) {
        return { kind: 'is', expr: left, test: null, negated, start: left.start, end: what.end };
      }
      if (this.isWord(what, 'TRUE', 'FALSE')) {
        const test = what.upper === 'TRUE';
        return { kind: 'is', expr: left, test, negated, start: left.start, end: what.end };
      }
      if (this.isWord(what, 'DISTINCT'))
        this.unsupported(what, 'IS DISTINCT FROM is not supported');
      this.unexpected(what, 'NULL, TRUE or FALSE');
    }
    let negated = false;
    if (this.isWord(token, 'NOT')) {
      const after = this.peek(1);
      if (!this.isWord(after, 'IN', 'BETWEEN', 'LIKE', 'ILIKE', 'REGEXP', 'RLIKE', 'SIMILAR')) {
        return left;
      }
      this.next();
      negated = true;
    }
    const keyword = this.peek();
    if (this.isWord(keyword, 'IN')) {
      this.next();
      this.expectOp('(');
      if (this.isWord(this.peek(), 'SELECT'))
        this.unsupported(this.peek(), 'Subqueries are not supported');
      const list: Expr[] = [];
      if (this.isOp(this.peek(), ')')) this.fail(this.peek(), 'IN needs at least one value');
      do list.push(this.operand());
      while (this.acceptOp(','));
      const close = this.peek();
      if (!this.isOp(close, ')')) this.unexpected(close, "',' or ')'");
      this.next();
      return { kind: 'in', expr: left, list, negated, start: left.start, end: close.end };
    }
    if (this.isWord(keyword, 'BETWEEN')) {
      this.next();
      if (this.isWord(this.peek(), 'SYMMETRIC', 'ASYMMETRIC')) {
        this.unsupported(this.peek(), `BETWEEN ${this.peek().upper} is not supported`);
      }
      const low = this.operand();
      this.expectWord('AND');
      const high = this.operand();
      return { kind: 'between', expr: left, low, high, negated, start: left.start, end: high.end };
    }
    if (this.isWord(keyword, 'LIKE', 'ILIKE')) {
      this.next();
      const pattern = this.operand();
      let escape: Expr | undefined;
      if (this.acceptWord('ESCAPE')) escape = this.operand();
      return {
        kind: 'like',
        expr: left,
        pattern,
        negated,
        caseInsensitive: keyword.upper === 'ILIKE',
        start: left.start,
        end: (escape ?? pattern).end,
        ...(escape ? { escape } : {}),
      };
    }
    if (this.isWord(keyword, 'REGEXP', 'RLIKE', 'SIMILAR')) {
      this.unsupported(keyword, `${keyword.upper} is not supported`, 'Use LIKE');
    }
    if (negated) this.unexpected(keyword, 'IN, BETWEEN or LIKE');
    return left;
  }

  /** A value: a literal, a column, an aggregate or a parenthesised expression. */
  private operand(): Expr {
    const expr = this.primary();
    const after = this.peek();
    if (after.kind === 'op' && ['+', '-', '*', '/', '%', '||', '::'].includes(after.value)) {
      this.unsupportedToken(after);
    }
    if (this.isWord(after, 'COLLATE')) this.unsupported(after, 'COLLATE is not supported');
    return expr;
  }

  private primary(): Expr {
    const token = this.peek();
    switch (token.kind) {
      case 'number':
        this.next();
        return {
          kind: 'literal',
          value: this.number(token, false),
          start: token.start,
          end: token.end,
        };
      case 'string':
        this.next();
        return { kind: 'literal', value: token.value, start: token.start, end: token.end };
      case 'quoted':
        return this.column();
      case 'op':
        return this.primaryOp(token);
      case 'eof':
        return this.unexpected(token, 'a value or a column');
      case 'word':
        break;
    }
    const upper = token.upper;
    switch (upper) {
      case 'NULL':
        this.next();
        return { kind: 'literal', value: null, start: token.start, end: token.end };
      case 'TRUE':
      case 'FALSE':
        this.next();
        return { kind: 'literal', value: upper === 'TRUE', start: token.start, end: token.end };
      case 'DATE':
      case 'TIMESTAMP':
        if (this.peek(1).kind === 'string') return this.dateLiteral();
        break;
      case 'INTERVAL':
      case 'TIME':
        if (this.peek(1).kind === 'string')
          this.unsupported(token, `${upper} literals are not supported`);
        break;
      case 'CAST':
      case 'CONVERT':
        if (this.isOp(this.peek(1), '(')) this.unsupported(token, 'Casts are not supported');
        break;
      default:
    }
    if (this.isOp(this.peek(1), '(') && !RESERVED.has(upper)) return this.call();
    if (RESERVED.has(upper)) {
      this.unsupportedToken(token);
      this.fail(
        token,
        `Expected a value or a column but found the keyword ${upper}`,
        'VALIDATION_FAILED',
        `Quote it to use it as a name: "${token.value}"`,
      );
    }
    return this.column();
  }

  private primaryOp(token: SqlToken): Expr {
    if (this.isOp(token, '(')) {
      this.next();
      if (this.isWord(this.peek(), 'SELECT'))
        this.unsupported(this.peek(), 'Subqueries are not supported');
      this.enter(token);
      const inner = this.expr();
      this.depth -= 1;
      if (this.isOp(this.peek(), ','))
        this.unsupported(this.peek(), 'Row values are not supported');
      const close = this.peek();
      if (!this.isOp(close, ')')) this.unexpected(close, "')'");
      this.next();
      return { ...inner, start: token.start, end: close.end };
    }
    if (this.isOp(token, '-', '+')) {
      const number = this.peek(1);
      if (number.kind === 'number') {
        this.next();
        this.next();
        return {
          kind: 'literal',
          value: this.number(number, token.value === '-'),
          start: token.start,
          end: number.end,
        };
      }
    }
    this.unexpected(token, 'a value or a column');
  }

  /** A numeric literal typed as the shell types it: Int32, else Int64, else Double. */
  private number(token: SqlToken, negative: boolean): BsonValue {
    const text = token.value;
    if (/^\d+$/.test(text)) {
      const n = BigInt(text) * (negative ? -1n : 1n);
      if (n >= INT32_MIN && n <= INT32_MAX) return new Int32(Number(n));
      if (n >= INT64_MIN && n <= INT64_MAX) return Long.fromBigInt(n);
      return new Double(Number(n));
    }
    const value = Number(text);
    if (!Number.isFinite(value)) this.fail(token, 'This number is too large');
    return new Double(negative ? -value : value);
  }

  private dateLiteral(): Expr {
    const keyword = this.next();
    const text = this.next();
    const dateOnly = keyword.upper === 'DATE';
    const trimmed = text.value.trim();
    const date = dateOnly && !DATE_ONLY.test(trimmed) ? undefined : parseIsoDate(trimmed);
    if (date === undefined) {
      this.fail(
        text,
        dateOnly ? `"${text.value}" is not a date` : `"${text.value}" is not a timestamp`,
        'VALIDATION_FAILED',
        dateOnly
          ? "Write DATE 'YYYY-MM-DD'"
          : "Write TIMESTAMP 'YYYY-MM-DD HH:MM:SS' (UTC unless it has a zone)",
      );
    }
    return { kind: 'literal', value: date, start: keyword.start, end: text.end };
  }

  /** `COUNT(...)` and the other aggregates, or `ObjectId('...')`. */
  private call(): Expr {
    const name = this.next();
    this.next();
    if (name.upper === 'OBJECTID') {
      const arg = this.next();
      if (arg.kind !== 'string') this.unexpected(arg, 'a hexadecimal string');
      const close = this.peek();
      if (!this.isOp(close, ')')) this.unexpected(close, "')'");
      this.next();
      if (!OBJECT_ID.test(arg.value)) {
        this.fail(arg, 'An ObjectId is 24 hexadecimal characters');
      }
      return {
        kind: 'literal',
        value: ObjectId.createFromHexString(arg.value),
        start: name.start,
        end: close.end,
      };
    }
    if (!AGGREGATES.has(name.upper as AggregateName)) {
      this.unsupported(
        name,
        `The function ${name.value}() is not supported`,
        'Use COUNT, SUM, AVG, MIN or MAX',
      );
    }
    const aggregate = name.upper as AggregateName;
    this.enter(name);
    let distinct = false;
    let arg: Expr | undefined;
    const first = this.peek();
    if (this.isOp(first, '*')) {
      if (aggregate !== 'COUNT') this.fail(first, `${aggregate}(*) is not valid; name a column`);
      this.next();
    } else {
      if (this.acceptWord('DISTINCT')) distinct = true;
      else this.acceptWord('ALL');
      if (this.isOp(this.peek(), ')')) this.fail(this.peek(), `${aggregate}() needs an argument`);
      arg = this.expr();
      if (this.isOp(this.peek(), ',')) {
        this.unsupported(this.peek(), `${aggregate}() takes one argument`);
      }
    }
    const close = this.peek();
    if (!this.isOp(close, ')')) this.unexpected(close, "')'");
    this.next();
    this.depth -= 1;
    const after = this.peek();
    if (this.isWord(after, 'OVER')) this.unsupported(after, 'Window functions are not supported');
    if (this.isWord(after, 'FILTER')) this.unsupported(after, 'FILTER clauses are not supported');
    if (this.isWord(after, 'WITHIN')) this.unsupported(after, 'WITHIN GROUP is not supported');
    return {
      kind: 'aggregate',
      name: aggregate,
      distinct,
      start: name.start,
      end: close.end,
      ...(arg ? { arg } : {}),
    };
  }

  /** A name or a path part after a dot: any word (keywords too), a quoted name or an index. */
  private pathPart(what: string): SqlToken {
    const token = this.peek();
    if (token.kind === 'word' || token.kind === 'quoted') return this.next();
    if (token.kind === 'number' && /^\d+$/.test(token.value)) return this.next();
    if (this.isOp(token, '*'))
      this.fail(token, '* can only stand alone or after a table name in the select list');
    this.unexpected(token, what);
  }

  private column(): ColumnExpr {
    const first = this.identifier('a column');
    const parts = [first.value];
    let end = first.end;
    while (this.isOp(this.peek(), '.')) {
      this.next();
      const part = this.pathPart('a field name after "."');
      parts.push(part.value);
      end = part.end;
    }
    if (this.isOp(this.peek(), '(')) {
      this.unsupported(this.peek(), `The function ${parts.join('.')}() is not supported`);
    }
    return { kind: 'column', parts, start: first.start, end };
  }
}

/** Parses one SELECT statement; errors are SqlTranslationErrors. */
export function parseSql(sql: string, options?: SqlParseOptions): SelectStatement {
  return new SqlParser(sql, options).parseStatement();
}
