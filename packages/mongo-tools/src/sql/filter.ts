import { BSONRegExp } from 'bson';

import { isBsonDocument, type BsonDocument, type BsonValue } from '../bson';
import type { AggregateExpr, ColumnExpr, CompareOp, Expr, LikeExpr, SqlRange } from './ast';
import type { SqlTranslationErrorCode } from './errors';

/**
 * WHERE, HAVING and ON conditions as MongoDB query filters.
 *
 * SQL logic has three values: a comparison with NULL (or with a missing field, which SQL sees as
 * NULL) is unknown, and NOT unknown is still unknown, so the row is left out either way. MongoDB
 * filters have two, and `$not` / `$nor` match whatever the inner filter does not. To keep SQL's
 * results, every condition is translated in two forms: the filter for "is true" and the filter
 * for "is false", and NOT picks the other form instead of wrapping the filter (NOT is pushed down
 * with De Morgan's laws). So `a <> 5` and `NOT (a = 5)` both become `{ a: { $nin: [5, null] } }`:
 * documents where `a` is null or missing are left out, as SQL leaves them out.
 */

/** What a column, alias or aggregate in a condition stands for. */
export type Operand =
  | { readonly kind: 'field'; readonly path: string; readonly range: SqlRange }
  | { readonly kind: 'value'; readonly value: BsonValue; readonly range: SqlRange };

/** Resolves the names in one clause (WHERE, HAVING, the ON of a join). */
export interface OperandResolver {
  column(expr: ColumnExpr): Operand;
  aggregate(expr: AggregateExpr): Operand;
  fail(range: SqlRange, reason: string, code?: SqlTranslationErrorCode, hint?: string): never;
}

const COMPARE: Record<CompareOp, string> = {
  '=': '$eq',
  '<>': '$ne',
  '<': '$lt',
  '<=': '$lte',
  '>': '$gt',
  '>=': '$gte',
};
const NEGATED: Record<CompareOp, CompareOp> = {
  '=': '<>',
  '<>': '=',
  '<': '>=',
  '<=': '>',
  '>': '<=',
  '>=': '<',
};
const FLIPPED: Record<CompareOp, CompareOp> = {
  '=': '=',
  '<>': '<>',
  '<': '>',
  '<=': '>=',
  '>': '<',
  '>=': '<=',
};

/** A filter no document matches. */
export const MATCH_NOTHING: BsonDocument = { $expr: false };

function isOperatorDocument(value: BsonValue | undefined): value is BsonDocument {
  if (!isBsonDocument(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

/** Defines a key as an own data property, so "__proto__" is a field like any other. */
export function setField(doc: BsonDocument, key: string, value: BsonValue): void {
  if (key === '__proto__') {
    Object.defineProperty(doc, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    doc[key] = value;
  }
}

/** A one-field document (safe for any key). */
export function field(key: string, value: BsonValue): BsonDocument {
  const doc: BsonDocument = {};
  setField(doc, key, value);
  return doc;
}

/**
 * ANDs filters into one document: different fields sit side by side, operator documents on the
 * same field merge when their operators differ (`{ a: { $gt: 1, $lt: 5 } }`), and anything that
 * would clash goes into `$and`.
 */
export function andFilters(filters: readonly BsonDocument[]): BsonDocument {
  const out: BsonDocument = {};
  const rest: BsonDocument[] = [];
  const nested: BsonDocument[] = [];
  for (const filter of filters) {
    for (const key of Object.keys(filter)) {
      const value = filter[key]!;
      if (key === '$and' && Array.isArray(value)) {
        nested.push(...(value as BsonDocument[]));
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(out, key)) {
        setField(out, key, value);
        continue;
      }
      const existing = out[key];
      if (
        !key.startsWith('$') &&
        isOperatorDocument(existing) &&
        isOperatorDocument(value) &&
        Object.keys(value).every((op) => !(op in existing))
      ) {
        setField(out, key, { ...existing, ...value });
        continue;
      }
      rest.push(field(key, value));
    }
  }
  const and = [...nested, ...rest];
  if (and.length > 0) {
    if (Object.keys(out).length === 0 && and.length === 1) return and[0]!;
    out['$and'] = and;
  }
  return out;
}

/** ORs filters; one that matches everything makes the whole OR match everything. */
export function orFilters(filters: readonly BsonDocument[]): BsonDocument {
  const items: BsonDocument[] = [];
  for (const filter of filters) {
    const keys = Object.keys(filter);
    if (keys.length === 0) return {};
    if (keys.length === 1 && keys[0] === '$or' && Array.isArray(filter['$or'])) {
      items.push(...(filter['$or'] as BsonDocument[]));
    } else if (!isMatchNothing(filter)) {
      items.push(filter);
    }
  }
  if (items.length === 0) return MATCH_NOTHING;
  if (items.length === 1) return items[0]!;
  return { $or: items };
}

function isMatchNothing(filter: BsonDocument): boolean {
  const keys = Object.keys(filter);
  return keys.length === 1 && keys[0] === '$expr' && filter['$expr'] === false;
}

/** A value as an aggregation expression: strings starting with `$` must be `$literal`. */
export function literalExpression(value: BsonValue): BsonValue {
  return typeof value === 'string' && value.startsWith('$') ? { $literal: value } : value;
}

const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}/]/;

/**
 * A LIKE pattern as an anchored regular expression: `%` is `.*`, `_` is `.`, everything else is
 * escaped, and the escape character (backslash unless ESCAPE names another, or none for
 * ESCAPE '') makes the next character literal. A leading or trailing `%` drops that anchor, so
 * `'abc%'` is `/^abc/` (which can use an index). The `s` flag is added when `.` appears, since
 * `%` and `_` match line breaks too; `i` is added for ILIKE.
 */
export function likeRegex(
  pattern: string,
  escape: string | undefined,
  caseInsensitive: boolean,
): BSONRegExp | { readonly error: string } {
  type Piece =
    | { readonly kind: 'text'; readonly text: string }
    | { readonly kind: '%' }
    | { readonly kind: '_' };
  const pieces: Piece[] = [];
  const chars = Array.from(pattern);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (escape !== undefined && c === escape) {
      const next = chars[i + 1];
      if (next === undefined) return { error: 'The LIKE pattern ends with its escape character' };
      pieces.push({ kind: 'text', text: next });
      i += 1;
    } else if (c === '%' || c === '_') {
      // Consecutive %s are one.
      if (c === '%' && pieces[pieces.length - 1]?.kind === '%') continue;
      pieces.push({ kind: c });
    } else {
      pieces.push({ kind: 'text', text: c });
    }
  }
  let start = 0;
  let end = pieces.length;
  const anchoredStart = !(pieces[0]?.kind === '%' && pieces.length > 1);
  const anchoredEnd = !(pieces[pieces.length - 1]?.kind === '%' && pieces.length > 1);
  if (!anchoredStart) start += 1;
  if (!anchoredEnd) end -= 1;
  let source = anchoredStart ? '^' : '';
  let dot = false;
  for (const piece of pieces.slice(start, end)) {
    if (piece.kind === '%') {
      source += '.*';
      dot = true;
    } else if (piece.kind === '_') {
      source += '.';
      dot = true;
    } else {
      source += REGEX_SPECIAL.test(piece.text) ? `\\${piece.text}` : piece.text;
    }
  }
  if (anchoredEnd) source += '$';
  const flags = `${caseInsensitive ? 'i' : ''}${dot ? 's' : ''}`;
  return new BSONRegExp(source, flags);
}

/** Translates conditions into filters; see the module comment for how NOT is handled. */
export class FilterBuilder {
  constructor(private readonly resolver: OperandResolver) {}

  /** The filter matching the rows where `expr` is true (or, with `negate`, false). */
  condition(expr: Expr, negate = false): BsonDocument {
    switch (expr.kind) {
      case 'and':
      case 'or': {
        const parts = expr.items.map((item) => this.condition(item, negate));
        return (expr.kind === 'and') !== negate ? andFilters(parts) : orFilters(parts);
      }
      case 'not':
        return this.condition(expr.expr, !negate);
      case 'compare':
        return this.compare(expr.op, expr.left, expr.right, negate, expr);
      case 'in':
        return this.in(expr.expr, expr.list, expr.negated !== negate);
      case 'between':
        return this.between(expr.expr, expr.low, expr.high, expr.negated !== negate);
      case 'like':
        return this.like(expr, expr.negated !== negate);
      case 'is':
        return this.is(expr.expr, expr.test, expr.negated !== negate);
      case 'column':
      case 'aggregate': {
        // A boolean column on its own: `WHERE active`.
        const path = this.field(expr, 'a condition');
        return field(path, !negate);
      }
      case 'literal':
        if (expr.value === true) return negate ? MATCH_NOTHING : {};
        if (expr.value === false) return negate ? {} : MATCH_NOTHING;
        if (expr.value === null) return MATCH_NOTHING;
        return this.resolver.fail(expr, 'This value is not a condition');
    }
  }

  private operand(expr: Expr): Operand {
    switch (expr.kind) {
      case 'column':
        return this.resolver.column(expr);
      case 'aggregate':
        return this.resolver.aggregate(expr);
      case 'literal':
        return { kind: 'value', value: expr.value, range: expr };
      default:
        return this.resolver.fail(
          expr,
          'Only columns, values and aggregate functions can be compared',
          'NOT_SUPPORTED',
        );
    }
  }

  /** The field path an operand must be; `what` names its role in the error. */
  private field(expr: Expr, what: string): string {
    const operand = this.operand(expr);
    if (operand.kind !== 'field') {
      this.resolver.fail(expr, `Expected a column as ${what}`, 'NOT_SUPPORTED');
    }
    return operand.path;
  }

  /** A value operand that is not NULL. */
  private value(expr: Expr, what: string): BsonValue {
    const operand = this.operand(expr);
    if (operand.kind !== 'value') {
      this.resolver.fail(expr, `Expected a value as ${what}`, 'NOT_SUPPORTED');
    }
    if (operand.value === null) this.nullComparison(expr);
    return operand.value;
  }

  private nullComparison(range: SqlRange): never {
    return this.resolver.fail(
      range,
      'A comparison with NULL is never true in SQL',
      'VALIDATION_FAILED',
      'Use IS NULL or IS NOT NULL',
    );
  }

  private compare(op: CompareOp, leftExpr: Expr, rightExpr: Expr, negate: boolean, at: SqlRange) {
    const left = this.operand(leftExpr);
    const right = this.operand(rightExpr);
    const effective = negate ? NEGATED[op] : op;
    if (left.kind === 'value' && left.value === null) this.nullComparison(at);
    if (right.kind === 'value' && right.value === null) this.nullComparison(at);
    if (left.kind === 'field' && right.kind === 'value') {
      return this.fieldCompare(left.path, effective, right.value);
    }
    if (left.kind === 'value' && right.kind === 'field') {
      return this.fieldCompare(right.path, FLIPPED[effective], left.value);
    }
    if (left.kind === 'field' && right.kind === 'field') {
      // Both sides must be non-null, as SQL requires, before $expr compares them (in $expr a
      // null or missing field is a value like any other).
      return andFilters([
        field(left.path, { $ne: null }),
        field(right.path, { $ne: null }),
        { $expr: { [COMPARE[effective]]: [`$${left.path}`, `$${right.path}`] } },
      ]);
    }
    // Two values: the server compares them.
    return {
      $expr: {
        [COMPARE[effective]]: [
          literalExpression((left as { value: BsonValue }).value),
          literalExpression((right as { value: BsonValue }).value),
        ],
      },
    };
  }

  private fieldCompare(path: string, op: CompareOp, value: BsonValue): BsonDocument {
    switch (op) {
      case '=':
        return field(path, value);
      case '<>':
        return field(path, { $nin: [value, null] });
      default:
        return field(path, { [COMPARE[op]]: value });
    }
  }

  private in(expr: Expr, list: readonly Expr[], negate: boolean): BsonDocument {
    const path = this.field(expr, 'the left side of IN');
    const values = list.map((item) => {
      const operand = this.operand(item);
      if (operand.kind !== 'value') {
        this.resolver.fail(item, 'IN lists can only hold values', 'NOT_SUPPORTED');
      }
      if (operand.value === null) {
        this.resolver.fail(
          item,
          'NULL in an IN list never matches in SQL',
          'VALIDATION_FAILED',
          'Remove it, or add OR ... IS NULL',
        );
      }
      return operand.value;
    });
    return field(path, negate ? { $nin: [...values, null] } : { $in: values });
  }

  private between(expr: Expr, lowExpr: Expr, highExpr: Expr, negate: boolean): BsonDocument {
    const path = this.field(expr, 'the left side of BETWEEN');
    const low = this.value(lowExpr, 'the lower bound');
    const high = this.value(highExpr, 'the upper bound');
    if (!negate) return field(path, { $gte: low, $lte: high });
    return orFilters([field(path, { $lt: low }), field(path, { $gt: high })]);
  }

  private like(expr: LikeExpr, negate: boolean): BsonDocument {
    const path = this.field(expr.expr, 'the left side of LIKE');
    const pattern = this.operand(expr.pattern);
    if (pattern.kind !== 'value' || typeof pattern.value !== 'string') {
      this.resolver.fail(expr.pattern, 'A LIKE pattern must be a string', 'NOT_SUPPORTED');
    }
    let escape: string | undefined = '\\';
    if (expr.escape !== undefined) {
      const operand = this.operand(expr.escape);
      if (operand.kind !== 'value' || typeof operand.value !== 'string') {
        this.resolver.fail(expr.escape, 'ESCAPE must be a string');
      }
      const chars = Array.from(operand.value);
      if (chars.length > 1) this.resolver.fail(expr.escape, 'ESCAPE must be one character');
      escape = chars[0];
    }
    const regex = likeRegex(pattern.value, escape, expr.caseInsensitive);
    if ('error' in regex) this.resolver.fail(expr.pattern, regex.error);
    return field(path, negate ? { $not: regex, $ne: null } : regex);
  }

  private is(expr: Expr, test: null | boolean, negate: boolean): BsonDocument {
    const path = this.field(expr, 'the left side of IS');
    // `IS` is two-valued: `x IS TRUE` is false (not unknown) when x is NULL.
    if (test === null) return field(path, negate ? { $ne: null } : null);
    return field(path, negate ? { $ne: test } : test);
  }
}
