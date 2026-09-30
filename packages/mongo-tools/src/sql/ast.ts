import type { BsonValue } from '../bson';

/**
 * The syntax tree of the SELECT subset `sqlToMql` reads. Every node keeps its source range
 * (0-based UTF-16 offsets, `end` exclusive) so a translation error can underline it.
 */

export interface SqlRange {
  readonly start: number;
  readonly end: number;
}

/** A column: identifier parts as written, e.g. `o.address.city` is ['o', 'address', 'city']. */
export interface ColumnExpr extends SqlRange {
  readonly kind: 'column';
  readonly parts: readonly string[];
}

export interface LiteralExpr extends SqlRange {
  readonly kind: 'literal';
  readonly value: BsonValue;
}

export type AggregateName = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export interface AggregateExpr extends SqlRange {
  readonly kind: 'aggregate';
  readonly name: AggregateName;
  readonly distinct: boolean;
  /** Undefined for COUNT(*). */
  readonly arg?: Expr;
}

export type CompareOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

export interface CompareExpr extends SqlRange {
  readonly kind: 'compare';
  readonly op: CompareOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface LogicalExpr extends SqlRange {
  readonly kind: 'and' | 'or';
  readonly items: readonly Expr[];
}

export interface NotExpr extends SqlRange {
  readonly kind: 'not';
  readonly expr: Expr;
}

export interface InExpr extends SqlRange {
  readonly kind: 'in';
  readonly expr: Expr;
  readonly list: readonly Expr[];
  readonly negated: boolean;
}

export interface BetweenExpr extends SqlRange {
  readonly kind: 'between';
  readonly expr: Expr;
  readonly low: Expr;
  readonly high: Expr;
  readonly negated: boolean;
}

export interface LikeExpr extends SqlRange {
  readonly kind: 'like';
  readonly expr: Expr;
  readonly pattern: Expr;
  readonly escape?: Expr;
  readonly negated: boolean;
  /** ILIKE. */
  readonly caseInsensitive: boolean;
}

/** `x IS [NOT] NULL`, `x IS [NOT] TRUE`, `x IS [NOT] FALSE`. */
export interface IsExpr extends SqlRange {
  readonly kind: 'is';
  readonly expr: Expr;
  readonly test: null | boolean;
  readonly negated: boolean;
}

export type Expr =
  | ColumnExpr
  | LiteralExpr
  | AggregateExpr
  | CompareExpr
  | LogicalExpr
  | NotExpr
  | InExpr
  | BetweenExpr
  | LikeExpr
  | IsExpr;

/** `*` or `qualifier.*` in the select list. */
export interface StarItem extends SqlRange {
  readonly kind: 'star';
  readonly qualifier?: readonly string[];
}

export interface ExprItem extends SqlRange {
  readonly kind: 'expr';
  readonly expr: Expr;
  readonly alias?: string;
  readonly aliasRange?: SqlRange;
}

export type SelectItem = StarItem | ExprItem;

export interface TableRef extends SqlRange {
  /** The collection name; dots are part of it (`fs.files`). */
  readonly name: string;
  readonly parts: readonly string[];
  readonly alias?: string;
}

export interface JoinClause extends SqlRange {
  readonly type: 'inner' | 'left';
  readonly table: TableRef;
  readonly on: Expr;
}

export interface OrderItem extends SqlRange {
  readonly expr: Expr;
  readonly descending: boolean;
  readonly nulls?: 'first' | 'last';
}

export interface CountClause extends SqlRange {
  readonly value: number;
}

export interface SelectStatement {
  readonly distinct: boolean;
  readonly items: readonly SelectItem[];
  readonly from: TableRef;
  readonly joins: readonly JoinClause[];
  readonly where?: Expr;
  readonly groupBy: readonly Expr[];
  readonly having?: Expr;
  readonly orderBy: readonly OrderItem[];
  readonly limit?: CountClause;
  readonly offset?: CountClause;
}
