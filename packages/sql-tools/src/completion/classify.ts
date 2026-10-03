import type { SqlDialect } from '@querybara/core';

import type { Block, Clause, Cte, Marker, RelationRef, Segment, StatementModel } from './analysis';
import type { Catalog, CatalogRelation, CatalogRelationKind, CatalogSchema } from './catalog';
import { builtinFunctions } from './functions';
import * as K from './keywords';
import { identOf, type Ident } from './names';
import { findRef, type ResolvedColumn, type Resolver } from './scope';

/**
 * Decides what to offer at the cursor: which object kinds, which columns, which keywords. The
 * decision is token-based: the enclosing parenthesis group and query block, the clause marker
 * before the cursor and the few tokens after it. complete() turns a Plan into items.
 */

export interface ColumnSet {
  readonly columns: readonly ResolvedColumn[];
  /** Qualifier (alias or table name, as SQL) used when a column name is ambiguous. */
  readonly qualifier?: string;
}

export interface Scope {
  /** References of the query block at the cursor. */
  readonly local: readonly RelationRef[];
  /** References of enclosing blocks (correlated subqueries). */
  readonly outer: readonly RelationRef[];
}

export type PositionType = 'table' | 'expression' | 'other';

export interface Plan {
  type: PositionType;
  keywords: string[];
  /** Tables and views, of one schema when qualified. */
  relations?: { schema?: CatalogSchema; kinds?: ReadonlySet<CatalogRelationKind> };
  ctes?: readonly Cte[];
  schemas?: boolean;
  columnSets?: ColumnSet[];
  /** Never qualify columns (after `alias.`, in column lists). */
  noQualify?: boolean;
  /** Lower-case names of columns already listed. */
  exclude?: ReadonlySet<string>;
  aliases?: readonly RelationRef[];
  functions?: boolean;
  routines?: { schema?: CatalogSchema; kind: 'function' | 'procedure' | 'any' };
  sequences?: { schema?: CatalogSchema };
  types?: { builtin: boolean; schema?: CatalogSchema };
  joins?: { ref: RelationRef; earlier: readonly RelationRef[]; withOn: boolean };
  /** A qualified table position may continue with the relation's columns (COMMENT ON COLUMN t.). */
  qualifiedColumns?: boolean;
  scope?: Scope;
  snippets: boolean;
}

const DML_VERBS = words('SELECT INSERT UPDATE DELETE REPLACE MERGE VALUES TABLE');
const PENDING = words('GROUP ORDER NULLS PRIMARY FOREIGN FETCH SKIP DUPLICATE CONFLICT');
const JOIN_WORDS = words('LEFT RIGHT FULL OUTER INNER CROSS NATURAL');
const ELEMENT_WORDS = words(
  'CONSTRAINT PRIMARY FOREIGN UNIQUE CHECK INDEX KEY FULLTEXT SPATIAL EXCLUDE LIKE',
);
/** Words before '(' that do not make the group a function call. */
const NON_CALL = new Set([
  ...K.OPERAND_BEFORE,
  ...words(
    'FROM JOIN ON USING VALUES AS OVER INTO TABLE LATERAL KEY UNIQUE CHECK INDEX PRIMARY ' +
      'REFERENCES CONFLICT WINDOW PARTITION EXCLUDE',
  ),
]);
const DDL_ANCHORS = words(
  'TABLE TABLES VIEW EXISTS SEQUENCE FUNCTION PROCEDURE ROUTINE SCHEMA DATABASE TYPE DOMAIN ' +
    'INDEX TRUNCATE VACUUM ANALYZE LOCK OPTIMIZE REPAIR CHECK CHECKSUM FULL VERBOSE FREEZE ON ' +
    'ONLY CONCURRENTLY MATERIALIZED',
);
const LIST_VERBS = words(
  'DROP TRUNCATE LOCK ANALYZE OPTIMIZE CHECK REPAIR CHECKSUM VACUUM GRANT REVOKE RENAME',
);
const MAIN_AFTER_WITH = 'SELECT | INSERT INTO@pg | UPDATE | DELETE FROM | VALUES@pg';
const EXTRACT_FIELDS =
  'YEAR | MONTH | DAY | HOUR | MINUTE | SECOND | QUARTER | WEEK | EPOCH@pg | DOW@pg | DOY@pg | ' +
  'ISODOW@pg | MICROSECOND@my | YEAR_MONTH@my | DAY_HOUR@my';
const WINDOW_SPEC = 'PARTITION BY | ORDER BY | ROWS BETWEEN | RANGE BETWEEN | GROUPS BETWEEN@pg';
const FRAME_WORDS =
  'ORDER BY | ASC | DESC | ROWS BETWEEN | RANGE BETWEEN | UNBOUNDED PRECEDING | CURRENT ROW | ' +
  'UNBOUNDED FOLLOWING | PRECEDING | FOLLOWING | AND';
const ALL_RELATIONS: ReadonlySet<CatalogRelationKind> = new Set([
  'table',
  'view',
  'materialized-view',
]);
const TABLES_ONLY: ReadonlySet<CatalogRelationKind> = new Set(['table']);
const VIEWS_ONLY: ReadonlySet<CatalogRelationKind> = new Set(['view', 'materialized-view']);
const MATVIEWS_ONLY: ReadonlySet<CatalogRelationKind> = new Set(['materialized-view']);
const WRITABLE: ReadonlySet<CatalogRelationKind> = new Set(['table', 'view']);

/** True when the group opened at `open` is a function call's argument list. */
export function isCallGroup(model: StatementModel, open: number): boolean {
  const before = model.toks[open - 1];
  if (!before) return false;
  if (before.kind === 'quoted-identifier') return true;
  return before.kind === 'word' && !NON_CALL.has(before.upper);
}

function words(text: string): Set<string> {
  return new Set(text.split(' '));
}

function split(text: string): string[] {
  return text.split('|').map((entry) => entry.trim());
}

export class Classifier {
  private readonly toks;

  constructor(
    private readonly m: StatementModel,
    private readonly r: Resolver,
    private readonly catalog: Catalog,
    private readonly dialect: SqlDialect,
    private readonly inBody: boolean,
  ) {
    this.toks = m.toks;
  }

  classify(): Plan {
    const m = this.m;
    let q = m.at;
    const parts: Ident[] = [];
    while (m.isPunct(q - 1, '.')) {
      const tok = this.toks[q - 2];
      const ident = tok ? identOf(tok) : undefined;
      if (!ident) break;
      parts.unshift(ident);
      q -= 2;
    }
    if (m.isPunct(m.at - 1, '.') && parts.length === 0) return this.none();
    const base = this.position(q);
    return parts.length > 0 ? this.qualified(base, parts) : base;
  }

  // --- Plans ---------------------------------------------------------------------------------

  private none(): Plan {
    return { type: 'other', keywords: [], snippets: false };
  }

  private kw(...lists: (K.KeywordList | string)[]): string[] {
    return K.keywordsFor(
      this.dialect,
      ...lists.map((entry) => (typeof entry === 'string' ? split(entry) : entry)),
    );
  }

  private keywords(...lists: (K.KeywordList | string)[]): Plan {
    return { type: 'other', keywords: this.kw(...lists), snippets: false };
  }

  private statementStart(): Plan {
    const lists: (K.KeywordList | string)[] = [K.STATEMENT_START];
    if (this.inBody) {
      lists.push(
        'DECLARE | IF | ELSEIF | ELSE | END IF | WHILE | LOOP | REPEAT | RETURN | LEAVE | ITERATE | ' +
          'OPEN | FETCH | CLOSE | SIGNAL | END',
      );
    }
    return { type: 'other', keywords: this.kw(...lists), snippets: true };
  }

  private tablePosition(kinds: ReadonlySet<CatalogRelationKind>, ctes?: readonly Cte[]): Plan {
    const plan: Plan = {
      type: 'table',
      keywords: [],
      relations: { kinds },
      schemas: true,
      snippets: false,
    };
    if (ctes && ctes.length > 0) plan.ctes = ctes;
    return plan;
  }

  private typePlan(): Plan {
    return { type: 'table', keywords: [], types: { builtin: true }, snippets: false };
  }

  private columnsPlan(columns: readonly ResolvedColumn[], used?: ReadonlySet<string>): Plan {
    const plan: Plan = {
      type: 'other',
      keywords: [],
      columnSets: [{ columns }],
      noQualify: true,
      snippets: false,
    };
    if (used) plan.exclude = used;
    return plan;
  }

  private operandPlan(scope: Scope, extra: (K.KeywordList | string)[] = []): Plan {
    const refs = scope.local.length > 0 ? scope.local : scope.outer;
    return {
      type: 'expression',
      keywords: this.kw(...extra, K.OPERAND),
      columnSets: refs.map((ref) => this.columnSet(ref)),
      aliases: refs,
      functions: true,
      scope,
      snippets: true,
    };
  }

  private columnSet(ref: RelationRef): ColumnSet {
    const qualifier = this.r.qualifierOf(ref);
    const columns = this.r.columnsOf(ref);
    return qualifier === undefined ? { columns } : { columns, qualifier };
  }

  // --- Qualified names -----------------------------------------------------------------------

  private qualified(base: Plan, parts: readonly Ident[]): Plan {
    const plan: Plan = { type: base.type, keywords: [], snippets: false };
    const catalog = this.catalog;
    if (base.type === 'table') {
      const schema = catalog.findSchema(parts);
      if (schema) {
        if (base.relations) plan.relations = { ...base.relations, schema };
        if (base.routines) plan.routines = { ...base.routines, schema };
        if (base.sequences) plan.sequences = { schema };
        if (base.types) plan.types = { builtin: false, schema };
      }
      if (base.qualifiedColumns) {
        const relation = catalog.findRelation(parts);
        if (relation) {
          plan.columnSets = [{ columns: this.r.relationColumns(relation) }];
          plan.noQualify = true;
        }
      }
      return plan;
    }
    if (base.type !== 'expression') return plan;
    if (parts.length === 1 && base.scope) {
      const ref =
        findRef(base.scope.local, parts[0]!, this.dialect) ??
        findRef(base.scope.outer, parts[0]!, this.dialect);
      if (ref) {
        plan.columnSets = [{ columns: this.r.columnsOf(ref) }];
        plan.noQualify = true;
        return plan;
      }
    }
    const relation = catalog.findRelation(parts);
    if (relation) {
      plan.columnSets = [{ columns: this.r.relationColumns(relation) }];
      plan.noQualify = true;
    }
    const schema = catalog.findSchema(parts);
    if (schema) {
      plan.relations = { schema, kinds: ALL_RELATIONS };
      plan.routines = { schema, kind: 'function' };
    }
    return plan;
  }

  // --- Positions -----------------------------------------------------------------------------

  private position(q: number): Plan {
    const g = this.m.groupAt(q);
    if (g >= 0 && !this.m.isQuery(g)) return this.paren(g, q);
    return this.block(g, q);
  }

  private block(open: number, q: number): Plan {
    const m = this.m;
    const block = m.block(open);
    const before = block.tokens.filter((i) => i < q);
    if (before.length === 0) return open < 0 ? this.statementStart() : this.keywords(K.QUERY_START);
    if (block.withEnd >= 0 && before[before.length - 1]! < block.withEnd) {
      return this.withHeader(block, before);
    }
    const segment = m.segmentAt(block, q);
    const segBefore = segment.tokens.filter((i) => i < q);
    if (segBefore.length === 0) {
      if (segment !== block.segments[0]) return this.keywords(K.QUERY_START);
      if (block.withEnd >= 0) return this.keywords(MAIN_AFTER_WITH);
      return open < 0 ? this.statementStart() : this.keywords(K.QUERY_START);
    }
    const verb = m.upper(segment.tokens[0]!);
    if (!DML_VERBS.has(verb)) return open < 0 ? this.utility(segBefore) : this.none();
    return this.dml(open, segment, segBefore, q, verb);
  }

  private withHeader(block: Block, before: readonly number[]): Plan {
    const m = this.m;
    const prev = before[before.length - 1]!;
    const word = m.upper(prev);
    if (word === 'WITH') return this.keywords('RECURSIVE');
    if (word === 'RECURSIVE' || m.isPunct(prev, ',')) return this.none();
    if (word === 'AS') return this.keywords('MATERIALIZED@pg | NOT MATERIALIZED@pg');
    if (word === 'NOT') return this.keywords('MATERIALIZED');
    if (m.isPunct(prev, ')')) {
      const body = block.ctes.some((cte) => cte.body !== undefined && m.closeOf(cte.body) === prev);
      return body ? this.keywords(MAIN_AFTER_WITH) : this.keywords('AS');
    }
    return identOf(this.toks[prev]!) ? this.keywords('AS') : this.none();
  }

  private dml(
    open: number,
    segment: Segment,
    segBefore: readonly number[],
    q: number,
    verb: string,
  ): Plan {
    const m = this.m;
    let marker: Marker | undefined;
    for (const candidate of segment.markers) {
      if (candidate.token < q && candidate.body <= q) marker = candidate;
    }
    const body = marker ? segBefore.filter((i) => i >= marker.body) : segBefore;
    const prev = segBefore[segBefore.length - 1]!;
    const word = this.toks[prev]!.kind === 'word' ? m.upper(prev) : '';
    const clause = marker?.clause;

    // MariaDB: NEXT VALUE FOR seq, PREVIOUS VALUE FOR seq.
    if (word === 'FOR' && m.upper(prev - 1) === 'VALUE') {
      return { type: 'table', keywords: [], sequences: {}, snippets: false };
    }
    if (word === 'NEXT' || word === 'PREVIOUS') return this.keywords('VALUE FOR');
    if (word === 'IS') return this.keywords(K.FOLLOW.IS!);
    if (word === 'NOT' && m.upper(segBefore[segBefore.length - 2] ?? -1) === 'IS') {
      return this.keywords('NULL | TRUE | FALSE | UNKNOWN | DISTINCT FROM');
    }
    if (PENDING.has(word)) return this.keywords(K.FOLLOW[word]!);
    if ((word === 'INSERT' || word === 'REPLACE') && prev === segment.tokens[0]) {
      return this.keywords(K.FOLLOW[word]!);
    }
    if (
      JOIN_WORDS.has(word) &&
      (clause === 'from' || clause === 'join' || clause === 'on' || clause === 'update')
    ) {
      return this.keywords(K.FOLLOW[word]!);
    }

    switch (clause) {
      case 'select':
        return this.expression('select', open, segment, body, prev, verb);
      case 'from': {
        // DELETE FROM target: only writable relations.
        const target =
          verb === 'DELETE' && segment.markers.find((m) => m.clause === 'from') === marker;
        const role = target ? 'delete' : verb === 'UPDATE' ? 'update-from' : 'from';
        return this.tableItem(role, open, segment, body);
      }
      case 'join':
        return this.tableItem('join', open, segment, body);
      case 'update':
        return this.tableItem('update', open, segment, body);
      case 'into':
        return this.tableItem('target', open, segment, body);
      case 'insert': {
        const target = segment.refs.find((ref) => ref.role === 'target' && ref.index < q);
        if (target) return this.tableItem('target', open, segment, body);
        return this.keywords('INTO | IGNORE INTO@my');
      }
      case 'delete':
        return this.keywords('FROM | LOW_PRIORITY@my | QUICK@my | IGNORE@my');
      case 'on':
      case 'where':
      case 'having':
      case 'group-by':
      case 'order-by':
      case 'returning':
        return this.expression(clause, open, segment, body, prev, verb, marker);
      case 'values':
        // VALUES (...) rows are parenthesised; at statement level only row separators follow.
        return body.length === 0
          ? this.none()
          : this.expression('values', open, segment, body, prev, verb);
      case 'limit':
        return this.isOperand(prev) ? this.none() : this.keywords(K.AFTER_LIMIT);
      case 'lock':
        if (word === 'OF') {
          return { type: 'other', keywords: [], aliases: segment.refs, snippets: false };
        }
        return this.keywords(K.LOCK_TAIL);
      case 'set':
      case 'duplicate':
        return this.setItem(clause, open, segment, body, verb);
      case 'conflict':
        return this.keywords(K.AFTER_CONFLICT);
      case 'conflict-do':
        return body.length === 0 ? this.keywords('NOTHING | UPDATE SET') : this.none();
      case 'merge':
        return this.keywords('INTO');
      case 'merge-when':
        if (word === 'WHEN') return this.keywords('MATCHED | NOT MATCHED');
        if (word === 'NOT') return this.keywords('MATCHED');
        if (word === 'MATCHED') return this.keywords('THEN | AND');
        if (word === 'THEN') return this.keywords('UPDATE SET | DELETE | INSERT | DO NOTHING');
        return this.expression('merge-when', open, segment, body, prev, verb);
      case 'merge-insert':
        return this.keywords('VALUES | DEFAULT VALUES');
      case 'using':
      case 'select-into':
      case 'window':
      default:
        return this.none();
    }
  }

  // --- Table references ----------------------------------------------------------------------

  private tableItem(
    role: 'from' | 'update-from' | 'join' | 'update' | 'target' | 'delete',
    open: number,
    segment: Segment,
    body: readonly number[],
  ): Plan {
    const m = this.m;
    let item = body;
    if (role === 'from' || role === 'update-from' || role === 'update') {
      let comma = -1;
      body.forEach((i, k) => {
        if (m.isPunct(i, ',')) comma = k;
      });
      item = body.slice(comma + 1);
    }
    let k = 0;
    while (k < item.length && (m.upper(item[k]!) === 'LATERAL' || m.upper(item[k]!) === 'ONLY')) {
      k++;
    }
    item = item.slice(k);
    if (item.length === 0) {
      if (role === 'target' || role === 'update' || role === 'delete') {
        return this.tablePosition(WRITABLE);
      }
      const plan = this.tablePosition(ALL_RELATIONS, m.ctesVisibleFrom(open));
      plan.keywords = this.kw(K.TABLE_POSITION);
      return plan;
    }
    if (m.upper(item[item.length - 1]!) === 'AS') return this.none();
    const ref = segment.refs.find((candidate) => candidate.index === item[0]);
    const aliased = ref?.alias !== undefined;
    switch (role) {
      case 'target':
        return this.keywords(K.AFTER_INSERT_TARGET);
      case 'update':
        return this.keywords(
          aliased ? K.AFTER_UPDATE_TARGET.filter((w) => w !== 'AS') : K.AFTER_UPDATE_TARGET,
        );
      case 'update-from':
        return this.keywords(aliased ? [] : K.AFTER_TABLE, K.JOINS, 'WHERE | RETURNING@pg');
      case 'delete':
        return this.keywords(K.AFTER_DELETE_TARGET);
      case 'from':
        return this.keywords(aliased ? [] : K.AFTER_TABLE, K.JOINS, K.QUERY_TAIL);
      case 'join': {
        const plan = this.keywords(
          K.AFTER_JOINED_TABLE,
          aliased ? [] : K.AFTER_TABLE,
          K.JOINS,
          K.QUERY_TAIL,
        );
        if (ref) {
          plan.joins = {
            ref,
            earlier: segment.refs.filter(
              (other) => other.index < ref.index && other.role !== 'target',
            ),
            withOn: true,
          };
        }
        return plan;
      }
    }
  }

  // --- Expressions ---------------------------------------------------------------------------

  /** True when an operand (column, function, literal) may follow token `prev`. */
  private isOperand(prev: number): boolean {
    const tok = this.toks[prev];
    if (!tok) return true;
    switch (tok.kind) {
      case 'punctuation':
        return tok.text !== ')';
      case 'operator': {
        if (tok.text !== '*') return true;
        // `SELECT *`, `t.*`, `count(*)`: a star is an operand.
        const before = this.toks[prev - 1];
        if (!before) return false;
        if (before.kind === 'punctuation') return before.text === ')';
        if (before.kind === 'word') return !K.OPERAND_BEFORE.has(before.upper);
        return true;
      }
      case 'word':
        if (K.VALUE_WORDS.has(tok.upper)) return false;
        return K.OPERAND_BEFORE.has(tok.upper) || K.CLAUSE_WORDS.has(tok.upper);
      default:
        return false;
    }
  }

  private scope(
    open: number,
    segment: Segment,
    clause: Clause | 'merge-when' | undefined,
    verb: string,
  ): Scope {
    const m = this.m;
    let local: RelationRef[] = [...segment.refs];
    if (verb === 'INSERT' || verb === 'REPLACE') {
      const targets = segment.refs.filter((ref) => ref.role === 'target');
      if (
        clause === 'set' ||
        clause === 'duplicate' ||
        clause === 'conflict' ||
        clause === 'conflict-do' ||
        clause === 'returning'
      ) {
        local = targets;
        const target = targets[0];
        if (target && this.dialect === 'postgres' && clause === 'set') {
          local = [...targets, { ...target, alias: { name: 'excluded', quoted: false } }];
        }
      } else {
        local = segment.refs.filter((ref) => ref.role !== 'target');
      }
    }
    const outer: RelationRef[] = [];
    let current = open;
    while (current >= 0) {
      const parentOpen = m.blockOf(m.parentOf(current));
      const parentSegment = m.segmentAt(m.block(parentOpen), current);
      outer.push(...parentSegment.refs.filter((ref) => ref.role !== 'target'));
      current = parentOpen;
    }
    return { local, outer };
  }

  private openCase(tokens: readonly number[]): boolean {
    let depth = 0;
    for (const i of tokens) {
      const word = this.m.upper(i);
      if (word === 'CASE') depth++;
      else if (word === 'END' && depth > 0) depth--;
    }
    return depth > 0;
  }

  private expression(
    clause: Clause | 'merge-when',
    open: number,
    segment: Segment,
    body: readonly number[],
    prev: number,
    verb: string,
    marker?: Marker,
  ): Plan {
    const m = this.m;
    const tok = this.toks[prev]!;
    if (tok.upper === 'AS') return this.none();
    if (tok.kind === 'operator' && tok.text === '::') return this.typePlan();
    const scope = this.scope(open, segment, clause === 'merge-when' ? undefined : clause, verb);
    const inCase = this.openCase(body);
    if (this.isOperand(prev)) {
      const extra: (K.KeywordList | string)[] = [];
      if (clause === 'select' && body.length === 0) extra.push(K.SELECT_START);
      if (clause === 'select' && body.length === 1 && m.upper(body[0]!) === 'DISTINCT') {
        extra.push('ON@pg');
      }
      if (clause === 'set' || clause === 'duplicate' || clause === 'values') extra.push('DEFAULT');
      if (tok.upper === 'CASE') extra.push('WHEN');
      const plan = this.operandPlan(scope, extra);
      if (clause === 'order-by' || clause === 'group-by') this.addOutputAliases(plan, open);
      if (clause === 'on' && body.length === 0 && marker) {
        const joins = this.joinsForOn(segment, marker);
        if (joins) plan.joins = joins;
      }
      return plan;
    }
    const tail: (K.KeywordList | string)[] = [];
    switch (clause) {
      case 'select':
        tail.push(K.OPERATORS, K.AFTER_SELECT_ITEM);
        break;
      case 'where':
        tail.push(K.OPERATORS, K.AFTER_WHERE);
        break;
      case 'on':
        tail.push(K.OPERATORS, K.JOINS, K.AFTER_ON);
        break;
      case 'having':
        tail.push(K.OPERATORS, K.AFTER_HAVING);
        break;
      case 'group-by':
        tail.push(K.AFTER_GROUP_BY);
        break;
      case 'order-by':
        tail.push(K.AFTER_ORDER_ITEM);
        break;
      case 'returning':
        tail.push('AS');
        break;
      case 'values':
        tail.push(K.AFTER_VALUES);
        break;
      case 'set':
      case 'duplicate':
        tail.push(K.OPERATORS, K.AFTER_SET_ITEM);
        break;
      case 'merge-when':
        tail.push('THEN | AND');
        break;
      default:
        break;
    }
    if (inCase) tail.unshift('WHEN | THEN | ELSE | END');
    if (this.afterCall(prev)) tail.unshift('OVER | FILTER@pg');
    return { type: 'expression', keywords: this.kw(...tail), scope, snippets: false };
  }

  /** ORDER BY and GROUP BY may name select-list aliases (`SELECT count(*) AS n ... ORDER BY n`). */
  private addOutputAliases(plan: Plan, open: number): void {
    const known = new Set<string>();
    for (const set of plan.columnSets ?? []) {
      for (const column of set.columns) known.add(column.name.toLowerCase());
    }
    const aliases = this.r
      .outputColumns(open, 0)
      .filter((column) => !known.has(column.name.toLowerCase()))
      .map((column): ResolvedColumn => ({ ...column, source: 'select list' }));
    if (aliases.length > 0) (plan.columnSets ??= []).push({ columns: aliases });
  }

  /** True when `prev` is the ')' of a function call. */
  private afterCall(prev: number): boolean {
    const m = this.m;
    if (!m.isPunct(prev, ')')) return false;
    let open = -1;
    for (let i = prev - 1; i >= 0; i--) {
      if (m.isPunct(i, '(') && m.closeOf(i) === prev) {
        open = i;
        break;
      }
    }
    return open > 0 && this.isCall(open);
  }

  private isCall(open: number): boolean {
    return isCallGroup(this.m, open);
  }

  private joinsForOn(segment: Segment, marker: Marker): Plan['joins'] {
    let ref: RelationRef | undefined;
    for (const candidate of segment.refs) {
      if (candidate.role === 'join' && candidate.index < marker.token) ref = candidate;
    }
    if (!ref) return undefined;
    const joined = ref;
    return {
      ref: joined,
      earlier: segment.refs.filter(
        (other) => other.index < joined.index && other.role !== 'target',
      ),
      withOn: false,
    };
  }

  private setItem(
    clause: 'set' | 'duplicate',
    open: number,
    segment: Segment,
    body: readonly number[],
    verb: string,
  ): Plan {
    const m = this.m;
    let comma = -1;
    body.forEach((i, k) => {
      if (m.isPunct(i, ',')) comma = k;
    });
    const item = body.slice(comma + 1);
    if (item.length === 0) {
      // MySQL multi-table UPDATE assigns columns of any joined table; PostgreSQL only the target's.
      const targets = segment.refs.filter((ref) =>
        verb === 'UPDATE'
          ? ref.role === 'update' || (this.dialect !== 'postgres' && ref.role !== 'target')
          : ref.role === 'target' || ref.role === 'merge-target',
      );
      const plan: Plan = {
        type: 'expression',
        keywords: [],
        columnSets: targets.map((ref) => this.columnSet(ref)),
        scope: { local: targets, outer: [] },
        snippets: false,
      };
      if (targets.length === 1) plan.noQualify = true;
      return plan;
    }
    const eq = item.findIndex(
      (i) => this.toks[i]!.kind === 'operator' && this.toks[i]!.text === '=',
    );
    if (eq < 0) return this.none();
    const rhs = item.slice(eq + 1);
    const prev = rhs.length > 0 ? rhs[rhs.length - 1]! : item[eq]!;
    return this.expression(clause, open, segment, rhs, prev, verb);
  }

  // --- Parenthesis groups --------------------------------------------------------------------

  private paren(g: number, q: number): Plan {
    const m = this.m;
    const inner = m.membersOf(g).filter((i) => i < q);
    const w1 = m.upper(g - 1);
    const blockOpen = m.blockOf(m.parentOf(g));
    const block = m.block(blockOpen);
    const segment = m.segmentAt(block, g);
    const verb = m.upper(segment.tokens[0] ?? -1);
    let clause: Clause | undefined;
    for (const marker of segment.markers) if (marker.token < g) clause = marker.clause;

    for (const ref of segment.refs) {
      if (ref.columnList === g) return this.columnList(ref, inner);
      if (ref.aliasColumnsGroup === g) return this.none();
    }
    for (const cte of block.ctes) {
      if (cte.columnsGroup === g) return this.none();
      if (cte.body === g) return this.keywords(K.CTE_BODY_START);
    }
    if (this.isTableElements(g)) return this.tableElements(g, inner);
    const parent = m.parentOf(g);
    if (parent >= 0 && this.isTableElements(parent)) return this.elementParen(g, parent, inner);

    // REFERENCES t (, CREATE INDEX ... ON t (, ALTER TABLE t ADD PRIMARY KEY (.
    const referenced = this.referencedBefore(g);
    if (referenced !== undefined) return this.catalogColumnsPlan(referenced, inner);
    if (blockOpen < 0 && m.parentOf(g) < 0) {
      const first = m.upper(block.tokens[0] ?? -1);
      const second = m.upper(block.tokens[1] ?? -1);
      if (first === 'CREATE' && (second === 'INDEX' || second === 'UNIQUE')) {
        const on = block.tokens.find((i) => i < g && m.upper(i) === 'ON');
        const relation = on === undefined ? undefined : this.relationAfter(on + 1);
        if (relation) {
          const plan = this.catalogColumnsPlan(relation, inner);
          plan.functions = true;
          return plan;
        }
      }
      if (first === 'ALTER' && second === 'TABLE') {
        const relation = this.relationAfter(block.tokens[2] ?? -1);
        if (relation) return this.catalogColumnsPlan(relation, inner);
      }
      if (first === 'COPY') {
        const relation = this.relationAfter(block.tokens[1] ?? -1);
        if (relation) return this.catalogColumnsPlan(relation, inner);
      }
    }

    if (w1 === 'OVER' || (w1 === 'AS' && clause === 'window')) {
      return this.windowSpec(inner, blockOpen, segment, clause, verb);
    }
    if (w1 === 'EXISTS') {
      return inner.length === 0 ? this.keywords(K.QUERY_START) : this.none();
    }
    if (w1 === 'USING' && clause === 'using') return this.usingColumns(segment, g, inner);
    if (w1 === 'CONFLICT') {
      const target = segment.refs.find((ref) => ref.role === 'target');
      return target ? this.columnList(target, inner) : this.none();
    }
    if (
      w1 === 'FROM' ||
      w1 === 'JOIN' ||
      w1 === 'LATERAL' ||
      (m.isPunct(g - 1, ',') && (clause === 'from' || clause === 'join'))
    ) {
      if (inner.length > 0) return this.none();
      const plan = this.tablePosition(ALL_RELATIONS, m.ctesVisibleFrom(blockOpen));
      plan.keywords = this.kw(K.QUERY_START);
      return plan;
    }
    if (
      (w1 === 'NEXTVAL' || w1 === 'LASTVAL' || w1 === 'SETVAL') &&
      this.dialect === 'mariadb' &&
      inner.length === 0
    ) {
      return { type: 'table', keywords: [], sequences: {}, snippets: false };
    }
    if (w1 === 'EXTRACT' && !inner.some((i) => m.upper(i) === 'FROM')) {
      return inner.length === 0 ? this.keywords(EXTRACT_FIELDS) : this.keywords('FROM');
    }
    const extra: (K.KeywordList | string)[] = [];
    const call = this.isCall(g);
    if (inner.length === 0) {
      if (!call) extra.push(K.QUERY_START);
      else if (builtinFunctions(this.dialect).get(w1.toLowerCase())?.category === 'aggregate') {
        extra.push('DISTINCT');
      }
    }
    return this.parenExpression(g, inner, blockOpen, segment, clause, verb, extra);
  }

  private parenExpression(
    g: number,
    inner: readonly number[],
    blockOpen: number,
    segment: Segment,
    clause: Clause | undefined,
    verb: string,
    extra: (K.KeywordList | string)[],
  ): Plan {
    const m = this.m;
    const prev = inner.length > 0 ? inner[inner.length - 1]! : g;
    const tok = this.toks[prev]!;
    const fn = m.upper(g - 1);
    if (tok.upper === 'AS') {
      return fn === 'CAST' || fn === 'CONVERT' ? this.typePlan() : this.none();
    }
    if (tok.kind === 'operator' && tok.text === '::') return this.typePlan();
    if (fn === 'CONVERT' && m.isPunct(prev, ',') && this.dialect !== 'postgres') {
      return this.typePlan();
    }
    const scope = this.scope(blockOpen, segment, clause, verb);
    if (this.isOperand(prev)) {
      const plan = this.operandPlan(scope, extra);
      if (tok.upper === 'CASE') plan.keywords.push(...this.kw('WHEN'));
      return plan;
    }
    const tail: (K.KeywordList | string)[] = [K.OPERATORS];
    if (this.openCase(inner)) tail.unshift('WHEN | THEN | ELSE | END');
    if (this.afterCall(prev)) tail.unshift('OVER | FILTER@pg');
    if (fn === 'GROUP_CONCAT') tail.push('ORDER BY | SEPARATOR');
    if (fn === 'STRING_AGG' || fn === 'ARRAY_AGG' || fn === 'JSON_AGG' || fn === 'JSONB_AGG') {
      tail.push('ORDER BY');
    }
    if (inner.some((i) => m.upper(i) === 'BY')) tail.push('ASC | DESC');
    return { type: 'expression', keywords: this.kw(...tail), scope, snippets: false };
  }

  private windowSpec(
    inner: readonly number[],
    blockOpen: number,
    segment: Segment,
    clause: Clause | undefined,
    verb: string,
  ): Plan {
    const m = this.m;
    if (inner.length === 0) return this.keywords(WINDOW_SPEC);
    const prev = inner[inner.length - 1]!;
    const word = m.upper(prev);
    if (word === 'PARTITION' || word === 'ORDER') return this.keywords('BY');
    if (word === 'BY' || m.isPunct(prev, ',')) {
      return this.operandPlan(this.scope(blockOpen, segment, clause, verb));
    }
    return this.keywords(FRAME_WORDS);
  }

  private columnList(ref: RelationRef, inner: readonly number[]): Plan {
    const prev = inner[inner.length - 1];
    if (prev !== undefined && !this.m.isPunct(prev, ',')) return this.none();
    return this.columnsPlan(this.r.columnsOf(ref), this.usedNames(inner));
  }

  private usedNames(inner: readonly number[]): Set<string> {
    const used = new Set<string>();
    for (const i of inner) {
      const ident = identOf(this.toks[i]!);
      if (ident) used.add(ident.name.toLowerCase());
    }
    return used;
  }

  private usingColumns(segment: Segment, g: number, inner: readonly number[]): Plan {
    let ref: RelationRef | undefined;
    for (const candidate of segment.refs) {
      if (candidate.role === 'join' && candidate.index < g) ref = candidate;
    }
    if (!ref) return this.none();
    const joined = ref;
    const earlier = new Set<string>();
    for (const other of segment.refs) {
      if (other.index >= joined.index) continue;
      for (const column of this.r.columnsOf(other)) earlier.add(column.name.toLowerCase());
    }
    const columns = this.r.columnsOf(joined);
    const shared = columns.filter((column) => earlier.has(column.name.toLowerCase()));
    const prev = inner[inner.length - 1];
    if (prev !== undefined && !this.m.isPunct(prev, ',')) return this.none();
    return this.columnsPlan(shared.length > 0 ? shared : columns, this.usedNames(inner));
  }

  private catalogColumnsPlan(relation: CatalogRelation, inner: readonly number[]): Plan {
    const prev = inner[inner.length - 1];
    if (prev !== undefined && !this.m.isPunct(prev, ',')) return this.none();
    return this.columnsPlan(this.r.relationColumns(relation), this.usedNames(inner));
  }

  /** `REFERENCES name (`: the referenced relation. */
  private referencedBefore(g: number): CatalogRelation | undefined {
    const m = this.m;
    const parts: Ident[] = [];
    let k = g - 1;
    for (;;) {
      const tok = this.toks[k];
      const ident = tok ? identOf(tok) : undefined;
      if (!ident) return undefined;
      parts.unshift(ident);
      if (!m.isPunct(k - 1, '.')) break;
      k -= 2;
    }
    if (m.upper(k - 1) !== 'REFERENCES') return undefined;
    return this.catalog.findRelation(parts);
  }

  /** The relation named at token k (skipping IF [NOT] EXISTS and ONLY). */
  private relationAfter(k: number): CatalogRelation | undefined {
    const m = this.m;
    let i = k;
    if (m.upper(i) === 'IF') i += m.upper(i + 1) === 'NOT' ? 3 : 2;
    if (m.upper(i) === 'ONLY') i++;
    const parts: Ident[] = [];
    for (;;) {
      const tok = this.toks[i];
      const ident = tok ? identOf(tok) : undefined;
      if (!ident || i === m.word) break;
      parts.push(ident);
      if (!m.isPunct(i + 1, '.')) break;
      i += 2;
    }
    return parts.length > 0 ? this.catalog.findRelation(parts) : undefined;
  }

  // --- CREATE TABLE ---------------------------------------------------------------------------

  /** The column and constraint list of CREATE TABLE name ( ... ). */
  private isTableElements(g: number): boolean {
    const m = this.m;
    if (m.parentOf(g) >= 0) return false;
    let k = g - 1;
    while (k >= 0 && identOf(this.toks[k]!) && (k === g - 1 || m.isPunct(k + 1, '.'))) {
      if (!m.isPunct(k - 1, '.')) break;
      k -= 2;
    }
    if (k < 0 || !identOf(this.toks[k]!)) return false;
    const anchor = m.upper(k - 1);
    if (anchor !== 'TABLE' && anchor !== 'EXISTS') return false;
    return m.upper(m.membersOf(-1)[0] ?? -1) === 'CREATE';
  }

  private elementItems(g: number): number[][] {
    const items: number[][] = [[]];
    for (const i of this.m.membersOf(g)) {
      if (this.m.isPunct(i, ',')) items.push([]);
      else items[items.length - 1]!.push(i);
    }
    return items;
  }

  private definedColumns(g: number): ResolvedColumn[] {
    const out: ResolvedColumn[] = [];
    for (const item of this.elementItems(g)) {
      const first = item[0];
      if (first === undefined || first === this.m.word) continue;
      const ident = identOf(this.toks[first]!);
      if (!ident || (!ident.quoted && ELEMENT_WORDS.has(ident.name.toUpperCase()))) continue;
      const type = item[1] === undefined ? undefined : this.toks[item[1]]!.text;
      out.push(type === undefined ? { name: ident.name } : { name: ident.name, dataType: type });
    }
    return out;
  }

  private tableElements(g: number, inner: readonly number[]): Plan {
    const m = this.m;
    let comma = -1;
    inner.forEach((i, k) => {
      if (m.isPunct(i, ',')) comma = k;
    });
    const item = inner.slice(comma + 1);
    if (item.length === 0) return this.keywords(K.TABLE_ELEMENT_START);
    const first = m.upper(item[0]!);
    const prev = item[item.length - 1]!;
    const word = m.upper(prev);
    const before = m.upper(item[item.length - 2] ?? -1);
    if (word === 'REFERENCES' || word === 'LIKE') return this.tablePosition(ALL_RELATIONS);
    if (word === 'PRIMARY' || word === 'FOREIGN') return this.keywords('KEY');
    if (word === 'ON') return this.keywords('DELETE | UPDATE');
    if ((word === 'DELETE' || word === 'UPDATE') && before === 'ON') {
      return this.keywords(K.REFERENTIAL_ACTIONS, 'CURRENT_TIMESTAMP@my');
    }
    if (ELEMENT_WORDS.has(first) && identOf(this.toks[item[0]!]!)?.quoted !== true) {
      if (first === 'CONSTRAINT' && item.length === 2) return this.keywords(K.CONSTRAINT_KINDS);
      if (m.isPunct(prev, ')')) {
        if (item.some((i) => m.upper(i) === 'REFERENCES')) return this.keywords(K.AFTER_REFERENCES);
        if (first === 'FOREIGN' || m.upper(item[1] ?? -1) === 'FOREIGN') {
          return this.keywords('REFERENCES');
        }
      }
      return this.none();
    }
    if (item.length === 1) return this.typePlan();
    if (word === 'DEFAULT') {
      return { type: 'expression', keywords: this.kw(K.OPERAND), functions: true, snippets: false };
    }
    if (word === 'NOT') return this.keywords('NULL');
    if (word === 'GENERATED') {
      return this.keywords('ALWAYS AS | BY DEFAULT AS IDENTITY@pg | ALWAYS AS IDENTITY@pg');
    }
    if (word === 'COLLATE' || word === 'COMMENT' || word === 'CHARACTER') return this.none();
    if (m.isPunct(prev, ')') && item.some((i) => m.upper(i) === 'REFERENCES')) {
      return this.keywords(K.AFTER_REFERENCES, K.COLUMN_CONSTRAINTS);
    }
    return this.keywords(K.COLUMN_CONSTRAINTS);
  }

  /** A group nested in the CREATE TABLE element list. */
  private elementParen(g: number, elements: number, inner: readonly number[]): Plan {
    const m = this.m;
    const referenced = this.referencedBefore(g);
    if (referenced) return this.catalogColumnsPlan(referenced, inner);
    // The element this group belongs to, up to the group.
    const item: number[] = [];
    for (const i of m.membersOf(elements)) {
      if (i >= g) break;
      if (m.isPunct(i, ',')) item.length = 0;
      else item.push(i);
    }
    const first = m.upper(item[0] ?? -1);
    const columns = this.definedColumns(elements);
    if (first === 'CHECK' || m.upper(g - 1) === 'CHECK' || m.upper(g - 1) === 'AS') {
      const prev = inner[inner.length - 1] ?? g;
      if (!this.isOperand(prev)) return this.keywords(K.OPERATORS);
      return {
        type: 'expression',
        keywords: this.kw(K.OPERAND),
        columnSets: [{ columns }],
        noQualify: true,
        functions: true,
        snippets: false,
      };
    }
    if (ELEMENT_WORDS.has(first)) {
      const prev = inner[inner.length - 1];
      if (prev !== undefined && !m.isPunct(prev, ',')) return this.none();
      return this.columnsPlan(columns, this.usedNames(inner));
    }
    // Type arguments: varchar(255), numeric(10, 2).
    return this.none();
  }

  // --- Utility and DDL statements ------------------------------------------------------------

  private utility(before: readonly number[]): Plan {
    const m = this.m;
    const verb = m.upper(before[0]!);
    let words = [...before];
    if (m.isPunct(words[words.length - 1]!, ',') && LIST_VERBS.has(verb)) {
      let k = words.length - 1;
      while (k >= 0 && m.isPunct(words[k]!, ',')) {
        k--;
        while (k >= 0) {
          const tok = this.toks[words[k]!]!;
          const ident = identOf(tok);
          const nameLike = ident && (ident.quoted || !DDL_ANCHORS.has(tok.upper));
          if (nameLike || m.isPunct(words[k]!, '.')) k--;
          else break;
        }
      }
      words = words.slice(0, k + 1);
    }
    for (;;) {
      const last = m.upper(words[words.length - 1] ?? -1);
      if (last === 'EXISTS') {
        words.pop();
        if (m.upper(words[words.length - 1] ?? -1) === 'NOT') words.pop();
        if (m.upper(words[words.length - 1] ?? -1) === 'IF') words.pop();
      } else if (last === 'ONLY' || last === 'CONCURRENTLY') {
        words.pop();
      } else {
        break;
      }
    }
    if (words.length === 0) return this.none();
    const w = (k: number): string => m.upper(words[words.length - k] ?? -1);
    const w1 = w(1);
    const creating = verb === 'CREATE';

    if (verb === 'ALTER' && m.upper(words[1] ?? -1) === 'TABLE') {
      const plan = this.alterTable(words);
      if (plan) return plan;
    }
    if (verb === 'USE') return words.length === 1 ? this.schemasPlan() : this.none();
    if ((w1 === 'TABLE' || w1 === 'TABLES') && (!creating || w(2) === 'LIKE')) {
      if (creating) return this.none();
      const kinds =
        verb === 'LOCK' || verb === 'SHOW' || verb === 'GRANT' || verb === 'REVOKE'
          ? ALL_RELATIONS
          : TABLES_ONLY;
      const plan = this.tablePosition(kinds);
      if (verb === 'COMMENT') plan.keywords = [];
      return plan;
    }
    if (w1 === 'LIKE' && creating) return this.tablePosition(ALL_RELATIONS);
    if (w1 === 'VIEW' && !creating) {
      return this.tablePosition(w(2) === 'MATERIALIZED' ? MATVIEWS_ONLY : VIEWS_ONLY);
    }
    if (w1 === 'SEQUENCE' && !creating) {
      return { type: 'table', keywords: [], sequences: {}, snippets: false };
    }
    if ((w1 === 'FUNCTION' || w1 === 'PROCEDURE' || w1 === 'ROUTINE') && !creating) {
      const kind = w1 === 'FUNCTION' ? 'function' : w1 === 'PROCEDURE' ? 'procedure' : 'any';
      return { type: 'table', keywords: [], routines: { kind }, snippets: false };
    }
    if (verb === 'CALL' && words.length === 1) {
      return { type: 'table', keywords: [], routines: { kind: 'procedure' }, snippets: false };
    }
    if ((w1 === 'SCHEMA' || w1 === 'DATABASE' || w1 === 'SCHEMAS') && !creating) {
      return this.schemasPlan();
    }
    if ((w1 === 'TYPE' || w1 === 'DOMAIN') && !creating) {
      return { type: 'table', keywords: [], types: { builtin: false }, snippets: false };
    }
    if (w1 === 'REFERENCES') return this.tablePosition(ALL_RELATIONS);
    if (w1 === 'ON') {
      if (verb === 'COMMENT') {
        return this.keywords(
          'TABLE | COLUMN | VIEW | MATERIALIZED VIEW | SCHEMA | FUNCTION | INDEX | SEQUENCE | TYPE',
        );
      }
      if (verb === 'GRANT' || verb === 'REVOKE') {
        const plan = this.tablePosition(ALL_RELATIONS);
        plan.keywords = this.kw(K.GRANT_ON);
        return plan;
      }
      return this.tablePosition(creating ? ALL_RELATIONS : TABLES_ONLY);
    }
    if (w1 === 'COLUMN' && verb === 'COMMENT') {
      const plan = this.tablePosition(ALL_RELATIONS);
      plan.qualifiedColumns = true;
      return plan;
    }
    if (verb === 'TRUNCATE' && words.length === 1) {
      const plan = this.tablePosition(TABLES_ONLY);
      plan.keywords = this.kw('TABLE');
      return plan;
    }
    if ((verb === 'DESCRIBE' || verb === 'DESC') && words.length === 1) {
      return this.tablePosition(ALL_RELATIONS);
    }
    if (verb === 'EXPLAIN' && words.length === 1) {
      if (this.dialect === 'postgres') return this.keywords(K.EXPLAIN_OPTIONS);
      const plan = this.tablePosition(ALL_RELATIONS);
      plan.keywords = this.kw(K.EXPLAIN_OPTIONS);
      return plan;
    }
    if (verb === 'SHOW') {
      if (words.length === 1) return this.keywords(K.SHOW_TARGETS);
      if (w1 === 'FROM' || w1 === 'IN') {
        const what = w(2);
        if (
          what === 'COLUMNS' ||
          what === 'FIELDS' ||
          what === 'INDEX' ||
          what === 'INDEXES' ||
          what === 'KEYS'
        ) {
          return this.tablePosition(ALL_RELATIONS);
        }
        return this.schemasPlan();
      }
      if (w1 === 'CREATE') {
        return this.keywords('TABLE | VIEW | PROCEDURE | FUNCTION | TRIGGER | EVENT | DATABASE');
      }
      if (w1 === 'FULL') return this.keywords('TABLES | COLUMNS FROM | PROCESSLIST');
      return this.none();
    }
    if (
      (verb === 'VACUUM' || verb === 'ANALYZE' || verb === 'CLUSTER') &&
      this.dialect === 'postgres'
    ) {
      const options = ['VACUUM', 'ANALYZE', 'ANALYSE', 'FULL', 'VERBOSE', 'FREEZE', 'CLUSTER'];
      if (!m.isPunct(words[words.length - 1]!, ')') && !options.includes(w1)) return this.none();
      const plan = this.tablePosition(verb === 'CLUSTER' ? TABLES_ONLY : ALL_RELATIONS);
      if (words.length === 1 && verb === 'VACUUM') {
        plan.keywords = this.kw('FULL | VERBOSE | ANALYZE | FREEZE');
      }
      return plan;
    }
    if (
      verb === 'ANALYZE' ||
      verb === 'OPTIMIZE' ||
      verb === 'REPAIR' ||
      verb === 'CHECKSUM' ||
      verb === 'CHECK'
    ) {
      return words.length === 1 ? this.keywords('TABLE') : this.none();
    }
    if (verb === 'COPY' && this.dialect === 'postgres') {
      if (words.length === 1) return this.tablePosition(ALL_RELATIONS);
      return words.length === 2 ? this.keywords('FROM | TO') : this.none();
    }
    if (verb === 'LOCK' && words.length === 1) {
      if (this.dialect !== 'postgres') return this.keywords('TABLES | TABLE');
      const plan = this.tablePosition(TABLES_ONLY);
      plan.keywords = this.kw('TABLE');
      return plan;
    }
    if (verb === 'REFRESH' && words.length === 1) return this.keywords('MATERIALIZED VIEW');
    if (verb === 'SET') return this.setStatement(words);
    if (verb === 'GRANT' && words.length === 1) return this.keywords(K.PRIVILEGES);
    if (verb === 'REVOKE' && words.length === 1) {
      return this.keywords(K.PRIVILEGES, 'GRANT OPTION FOR');
    }
    if (verb === 'CREATE' || verb === 'DROP' || verb === 'ALTER') {
      if (words.length === 1) {
        const kinds = this.kw(K.OBJECT_KINDS).filter((kind) =>
          verb === 'CREATE'
            ? kind !== 'IF EXISTS'
            : kind !== 'IF NOT EXISTS' && kind !== 'OR REPLACE',
        );
        return {
          type: 'other',
          keywords: verb === 'ALTER' ? kinds.filter((k) => !k.startsWith('IF')) : kinds,
          snippets: false,
        };
      }
      if (w1 === 'REPLACE') {
        return this.keywords(
          'VIEW | FUNCTION | PROCEDURE | TRIGGER | TABLE@mariadb | RULE@pg | AGGREGATE@pg',
        );
      }
      if (w1 === 'UNIQUE') return this.keywords('INDEX');
      if (w1 === 'MATERIALIZED') return this.keywords('VIEW');
      if (w1 === 'TEMPORARY' || w1 === 'TEMP') return this.keywords('TABLE');
      if (creating && w(2) === 'INDEX' && words.length >= 3) return this.keywords('ON');
      if (creating && w(2) === 'VIEW') return this.keywords('AS');
      return this.none();
    }
    if (verb === 'COMMENT' && words.length === 1) return this.keywords('ON');
    if (verb === 'RENAME' && words.length === 1) return this.keywords('TABLE | USER');
    if (words.length === 1 && K.FOLLOW[verb]) return this.keywords(K.FOLLOW[verb]!);
    return this.none();
  }

  private schemasPlan(): Plan {
    return { type: 'other', keywords: [], schemas: true, snippets: false };
  }

  private setStatement(words: readonly number[]): Plan {
    const m = this.m;
    const w1 = m.upper(words[words.length - 1]!);
    const last = this.toks[words[words.length - 1]!]!;
    if (this.dialect === 'postgres') {
      const target =
        m.upper(words[1] ?? -1) === 'SESSION' || m.upper(words[1] ?? -1) === 'LOCAL' ? 2 : 1;
      const setting = this.toks[words[target] ?? -1];
      if (words.length === 1) {
        return this.keywords(
          'search_path | TIME ZONE | ROLE | SESSION | LOCAL | SCHEMA | statement_timeout | TRANSACTION',
        );
      }
      if (w1 === 'SCHEMA') return this.schemasPlan();
      if (setting && setting.text.toLowerCase() === 'search_path') {
        const listed =
          words.length > target + 1 &&
          (w1 === 'TO' || last.text === '=' || m.isPunct(words[words.length - 1]!, ','));
        if (listed) return this.schemasPlan();
        if (words.length === target + 1) return this.keywords('TO');
      }
      return this.none();
    }
    if (words.length === 1) {
      return this.keywords(
        'NAMES | SESSION | GLOBAL | PERSIST@mysql | TRANSACTION | CHARACTER SET | autocommit | sql_mode | time_zone | foreign_key_checks',
      );
    }
    return this.none();
  }

  /** ALTER TABLE name ... */
  private alterTable(words: readonly number[]): Plan | undefined {
    const m = this.m;
    let k = 2;
    if (m.upper(words[k] ?? -1) === 'IF') k += 2;
    if (m.upper(words[k] ?? -1) === 'ONLY') k++;
    const parts: Ident[] = [];
    while (k < words.length) {
      const ident = identOf(this.toks[words[k]!]!);
      if (!ident) break;
      parts.push(ident);
      k++;
      if (!m.isPunct(words[k] ?? -1, '.')) break;
      k++;
    }
    if (parts.length === 0) return undefined;
    const relation = this.catalog.findRelation(parts);
    const tail = words.slice(k);
    const t = (n: number): string => m.upper(tail[tail.length - n] ?? -1);
    const columns = (): Plan =>
      relation ? this.columnsPlan(this.r.relationColumns(relation)) : this.none();
    if (tail.length === 0 || m.isPunct(tail[tail.length - 1]!, ',')) {
      return this.keywords(K.ALTER_TABLE_ACTIONS);
    }
    const w1 = t(1);
    const w2 = t(2);
    const w3 = t(3);
    if (
      w1 === 'COLUMN' &&
      (w2 === 'DROP' || w2 === 'ALTER' || w2 === 'MODIFY' || w2 === 'CHANGE' || w2 === 'RENAME')
    ) {
      return columns();
    }
    if (w1 === 'DROP') {
      const plan = columns();
      plan.keywords = this.kw(K.DROP_TARGETS);
      return plan;
    }
    if (w1 === 'ALTER' || w1 === 'MODIFY' || w1 === 'CHANGE') {
      const plan = columns();
      plan.keywords = this.kw('COLUMN');
      return plan;
    }
    if (w1 === 'AFTER') return columns();
    if (w1 === 'RENAME') return this.keywords('TO | COLUMN | CONSTRAINT@pg | INDEX@my | KEY@my');
    if (w1 === 'ADD') {
      return this.keywords(
        'COLUMN | CONSTRAINT | PRIMARY KEY | FOREIGN KEY | UNIQUE | CHECK | INDEX@my | KEY@my',
      );
    }
    if (w1 === 'CONSTRAINT' && w2 === 'ADD') return this.none();
    if (w2 === 'CONSTRAINT' && w3 === 'ADD') return this.keywords(K.CONSTRAINT_KINDS);
    if (w1 === 'TYPE') return this.typePlan();
    if (w1 === 'SCHEMA' && w2 === 'SET') return this.schemasPlan();
    if (w1 === 'REFERENCES') return this.tablePosition(ALL_RELATIONS);
    if (w1 === 'ON') return this.keywords('DELETE | UPDATE');
    if ((w1 === 'DELETE' || w1 === 'UPDATE') && w2 === 'ON') {
      return this.keywords(K.REFERENTIAL_ACTIONS);
    }
    // ADD [COLUMN] [IF NOT EXISTS] name |, MODIFY [COLUMN] name |, CHANGE [COLUMN] old new |.
    let action = tail.length - 1;
    while (action >= 0 && !['ADD', 'MODIFY', 'CHANGE', 'ALTER'].includes(m.upper(tail[action]!))) {
      action--;
    }
    if (action >= 0) {
      const verb = m.upper(tail[action]!);
      let j = action + 1;
      if (m.upper(tail[j] ?? -1) === 'COLUMN') j++;
      if (m.upper(tail[j] ?? -1) === 'IF') j += m.upper(tail[j + 1] ?? -1) === 'NOT' ? 3 : 2;
      const names = tail.length - j;
      const nameCount = verb === 'CHANGE' ? 2 : 1;
      if (ELEMENT_WORDS.has(m.upper(tail[j] ?? -1))) return this.none();
      if (verb === 'ALTER') {
        if (names === 1) {
          return this.keywords(
            'TYPE@pg | SET DATA TYPE@pg | SET DEFAULT | DROP DEFAULT | SET NOT NULL@pg | DROP NOT NULL@pg | SET VISIBLE@my | SET INVISIBLE@my',
          );
        }
        return this.none();
      }
      if (names === nameCount) return this.typePlan();
      if (names > nameCount) return this.keywords(K.COLUMN_CONSTRAINTS);
    }
    return this.none();
  }
}
