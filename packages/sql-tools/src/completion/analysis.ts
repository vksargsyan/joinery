import type { SqlDialect } from '@querybara/core';

import { isTrivia, Scanner, tokenize, type Token, type TokenKind } from '../lexer';
import { splitStatements, statementAt } from '../splitter';
import { CLAUSE_WORDS } from './keywords';
import { identOf, unquote, type Ident } from './names';

/**
 * The statement under the cursor, as tokens with the structure completion needs: parenthesis
 * groups (with recovery for groups the user has not closed yet), query blocks with their CTEs and
 * set-operation segments, and the clause markers and table references of each segment. Purely
 * token-based: it tolerates any incomplete SQL and never throws.
 */

export interface Tok {
  readonly kind: TokenKind;
  readonly text: string;
  /** Absolute offsets into the text passed to complete(). */
  readonly start: number;
  readonly end: number;
  /** Upper-case text for words, '' for everything else. */
  readonly upper: string;
  readonly unterminated: boolean;
}

/** Where the cursor is, and the tokens of the statement it edits. */
export interface Located {
  /** Significant tokens of the statement (or routine-body statement) at the cursor. */
  readonly toks: readonly Tok[];
  /** Index in toks of the word being typed, or of the first token after the cursor. */
  readonly at: number;
  /** True when toks[at] is the word (or quoted identifier) being typed. */
  readonly inWord: boolean;
  /** Range of the word being replaced. */
  readonly from: number;
  readonly to: number;
  /** What has been typed of the word, without quotes. */
  readonly prefix: string;
  /** The quote the user opened (`"` or `` ` ``), when typing a quoted identifier. */
  readonly quote?: string;
  /** The tokens are one statement of a routine body (the text was cut at a `;`). */
  readonly inBody: boolean;
}

const COMMENT_OR_LITERAL: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'line-comment',
  'block-comment',
  'executable-comment',
  'string',
  'dollar-string',
  'client-command',
]);

/** Tokens a cursor glued to their end cannot usefully be completed after. */
const LITERAL_END: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'number',
  'string',
  'dollar-string',
  'parameter',
  'variable',
]);

function toTok(token: Token, base: number): Tok {
  return {
    kind: token.kind,
    text: token.text,
    start: token.start + base,
    end: token.end + base,
    upper: token.kind === 'word' ? token.text.toUpperCase() : '',
    unterminated: token.unterminated === true,
  };
}

/** The cursor sits inside this token's text (comments and unterminated tokens include their end). */
function contains(token: Tok, offset: number): boolean {
  if (token.start < offset && offset < token.end) return true;
  return offset === token.end && (token.unterminated || token.kind === 'line-comment');
}

const EMPTY: readonly Tok[] = [];

/**
 * Finds the statement at `offset` and the word being typed there. Undefined when the cursor is
 * in a comment, string, dollar-quoted body or DELIMITER line, or glued to the end of a literal:
 * no completions at all there. With `inLiterals` (signature help) strings do not count.
 */
export function locate(
  text: string,
  offset: number,
  dialect: SqlDialect,
  inLiterals = false,
): Located | undefined {
  const statements = splitStatements(text, dialect);
  const statement = statementAt(statements, offset);
  const empty = (): Located => ({
    toks: EMPTY,
    at: 0,
    inWord: false,
    from: offset,
    to: offset,
    prefix: '',
    inBody: false,
  });

  // The cursor between statements: a gap of whitespace, comments and delimiters.
  const gap = (start: number, end: number, delimiter: string): 'none' | 'new' | 'continue' => {
    let separated = false;
    for (const token of tokenize(text.slice(start, end), dialect, { delimiter })) {
      const tok = toTok(token, start);
      if (tok.start >= offset) break;
      if (COMMENT_OR_LITERAL.has(tok.kind) && contains(tok, offset)) return 'none';
      if (tok.kind === 'client-command' && tok.end >= offset) return 'none';
      if (tok.kind === 'delimiter' || tok.kind === 'client-command') separated = true;
    }
    return separated ? 'new' : 'continue';
  };

  if (!statement) return gap(0, text.length, ';') === 'none' ? undefined : empty();
  if (offset < statement.start) {
    return gap(0, statement.start, ';') === 'none' ? undefined : empty();
  }
  if (offset > statement.end) {
    const index = statements.indexOf(statement);
    const next = statements[index + 1];
    const result = gap(statement.end, next ? next.start : text.length, statement.delimiter || ';');
    if (result === 'none') return undefined;
    if (result === 'new') return empty();
  }

  // Tokenize the statement alone with no delimiter: `;` inside routine bodies is punctuation.
  const scanner = new Scanner(dialect, '');
  scanner.load(statement.text, 0, true);
  const base = statement.start;
  const toks: Tok[] = [];
  let at = -1;
  let word: Tok | undefined;
  while (scanner.scan() === 'token') {
    const kind = scanner.kind;
    const start = scanner.start + base;
    const end = scanner.end + base;
    const unterminated = scanner.unterminated;
    const inside =
      (start < offset && offset < end) ||
      (offset === end && (unterminated || kind === 'line-comment'));
    const literal = kind === 'string' || kind === 'dollar-string';
    if (COMMENT_OR_LITERAL.has(kind) && inside && !(inLiterals && literal)) return undefined;
    if (!inLiterals && LITERAL_END.has(kind) && end === offset && offset > start) return undefined;
    if (isTrivia(kind) || kind === 'executable-comment') continue;
    const text = scanner.tokenText();
    const tok: Tok = {
      kind,
      text,
      start,
      end,
      upper: kind === 'word' ? text.toUpperCase() : '',
      unterminated,
    };
    if (at < 0) {
      if ((kind === 'word' || kind === 'quoted-identifier') && start < offset && offset <= end) {
        at = toks.length;
        word = tok;
      } else if (start >= offset) {
        at = toks.length;
      }
    }
    toks.push(tok);
  }
  if (at < 0) at = toks.length;

  // Routine bodies hold several statements separated by `;`: keep the one at the cursor.
  let first = 0;
  let last = toks.length;
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.text !== ';' || toks[i]!.kind !== 'punctuation') continue;
    if (i < at) first = i + 1;
    else {
      last = i;
      break;
    }
  }
  const sliced = first === 0 && last === toks.length ? toks : toks.slice(first, last);

  let from = offset;
  let to = offset;
  let prefix = '';
  let quote: string | undefined;
  if (word) {
    from = word.start;
    if (word.kind === 'quoted-identifier') {
      quote = word.text.startsWith('U&') || word.text.startsWith('u&') ? '"' : word.text.charAt(0);
      to = word.unterminated ? offset : word.end;
      prefix = unquote(text.slice(word.start, Math.min(offset, word.end)));
      if (offset === word.end && !word.unterminated) prefix = unquote(word.text);
    } else {
      to = word.end;
      prefix = text.slice(word.start, offset);
    }
  }
  const located: {
    toks: readonly Tok[];
    at: number;
    inWord: boolean;
    from: number;
    to: number;
    prefix: string;
    quote?: string;
    inBody: boolean;
  } = {
    toks: sliced,
    at: at - first,
    inWord: word !== undefined,
    from,
    to,
    prefix,
    inBody: first > 0,
  };
  if (quote !== undefined) located.quote = quote;
  return located;
}

// ---------------------------------------------------------------------------------------------

/** Clause markers of a query or DML segment. */
export type Clause =
  | 'select'
  | 'select-into'
  | 'from'
  | 'join'
  | 'on'
  | 'using'
  | 'where'
  | 'group-by'
  | 'having'
  | 'window'
  | 'order-by'
  | 'limit'
  | 'lock'
  | 'insert'
  | 'into'
  | 'values'
  | 'set'
  | 'update'
  | 'delete'
  | 'returning'
  | 'conflict'
  | 'conflict-do'
  | 'duplicate'
  | 'merge'
  | 'merge-when'
  | 'merge-insert';

export interface Marker {
  readonly clause: Clause;
  /** Token index of the marker's first word. */
  readonly token: number;
  /** Token index where the clause body starts (after GROUP BY, ON DUPLICATE KEY UPDATE...). */
  readonly body: number;
}

export type RefRole = 'from' | 'join' | 'update' | 'target' | 'merge-target';

/** A table reference in FROM, JOIN, UPDATE, INSERT INTO, MERGE... */
export interface RelationRef {
  readonly kind: 'table' | 'subquery' | 'function';
  /** Table or function name parts; empty for subqueries. */
  readonly parts: readonly Ident[];
  readonly alias?: Ident;
  readonly aliasColumns?: readonly string[];
  /** Subquery or function-argument group ('(' token index). */
  readonly group?: number;
  /** `INSERT INTO t (` column list group. */
  readonly columnList?: number;
  /** `AS x (a, b)` column alias group. */
  readonly aliasColumnsGroup?: number;
  /** Token index of the reference's first token. */
  readonly index: number;
  readonly role: RefRole;
}

export interface Cte {
  readonly name: Ident;
  readonly columns?: readonly string[];
  /** Column list group, if any. */
  readonly columnsGroup?: number;
  /** Body group ('(' token index). */
  readonly body?: number;
  readonly recursive: boolean;
}

export interface Segment {
  /** Token index where the segment begins (after UNION [ALL] for later segments). */
  readonly start: number;
  /** Token indices at the block's depth. */
  readonly tokens: readonly number[];
  readonly markers: readonly Marker[];
  readonly refs: readonly RelationRef[];
}

export interface Block {
  /** '(' token index, -1 for the statement itself. */
  readonly open: number;
  readonly tokens: readonly number[];
  readonly ctes: readonly Cte[];
  /** Token index where the WITH clause ends (the main statement's first token), or -1. */
  readonly withEnd: number;
  readonly segments: readonly Segment[];
}

const QUERY_OPENERS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);

/** Words after which a group the user has not closed yet cannot continue (they end it). */
const IMPLICIT_CLOSERS = new Set([
  'FROM',
  'WHERE',
  'GROUP',
  'HAVING',
  'LIMIT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'JOIN',
  'LEFT',
  'RIGHT',
  'INNER',
  'CROSS',
  'WINDOW',
  'RETURNING',
  'SET',
  'VALUES',
  'INTO',
]);

const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);

const ROUTINE_KINDS = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT']);

const CONTROL_STARTS = new Set(['IF', 'ELSEIF', 'WHEN', 'CASE', 'WHILE', 'ELSE', 'FOR']);

const DML_STARTS = new Set([
  'SELECT',
  'WITH',
  'INSERT',
  'UPDATE',
  'DELETE',
  'REPLACE',
  'MERGE',
  'VALUES',
]);

const EXPLAIN_OPTIONS = new Set([
  'ANALYZE',
  'ANALYSE',
  'VERBOSE',
  'EXTENDED',
  'PARTITIONS',
  'FORMAT',
  '=',
  'JSON',
  'TREE',
  'TRADITIONAL',
]);

const INSERT_MODIFIERS = new Set(['IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY']);

/** Parenthesis structure, blocks and segments of the located statement. */
export class StatementModel {
  readonly toks: readonly Tok[];
  readonly at: number;
  /** Index of the word being typed, or -1. */
  readonly word: number;
  /** For '(' tokens: index of the matching ')', or where the group implicitly ends. */
  private readonly close: Int32Array;
  /** Innermost enclosing '(' of each token, -1 at statement level. */
  readonly owner: Int32Array;
  private readonly members = new Map<number, number[]>();
  /** First token of the statement proper (after routine-body and EXPLAIN / CREATE ... AS prefixes). */
  readonly rootStart: number;
  private readonly blocks = new Map<number, Block>();
  private readonly inBody: boolean;

  constructor(located: Located) {
    this.inBody = located.inBody;
    const toks = located.toks;
    this.toks = toks;
    this.at = located.at;
    this.word = located.inWord ? located.at : -1;
    const n = toks.length;
    this.close = new Int32Array(n).fill(-1);
    this.owner = new Int32Array(n).fill(-1);
    this.buildGroups();
    for (let i = 0; i < n; i++) {
      const key = this.owner[i]!;
      let list = this.members.get(key);
      if (!list) this.members.set(key, (list = []));
      list.push(i);
    }
    this.rootStart = this.findRootStart();
  }

  upper(i: number): string {
    return this.toks[i]?.upper ?? '';
  }

  isPunct(i: number, text: string): boolean {
    const tok = this.toks[i];
    return tok !== undefined && tok.kind === 'punctuation' && tok.text === text;
  }

  /** The end of a group: its ')' index, or where it implicitly ends. */
  closeOf(open: number): number {
    return this.close[open] ?? -1;
  }

  /** Tokens directly inside a group (-1: the statement level from rootStart). */
  membersOf(open: number): readonly number[] {
    const list = this.members.get(open) ?? [];
    if (open !== -1 || this.rootStart === 0) return list;
    return list.filter((i) => i >= this.rootStart);
  }

  /** A '(' whose first token starts a query (the word being typed does not count). */
  isQuery(open: number): boolean {
    if (open < 0) return true;
    const first = open + 1;
    return first !== this.word && QUERY_OPENERS.has(this.upper(first));
  }

  /** The parent group of a group or token. */
  parentOf(index: number): number {
    return index < 0 ? -1 : this.owner[index]!;
  }

  /** Innermost group containing token position `index` (a position between tokens counts). */
  groupAt(index: number): number {
    let found = -1;
    for (let i = 0; i < index && i < this.toks.length; i++) {
      if (!this.isPunct(i, '(')) continue;
      const end = this.close[i]!;
      if (index <= end) found = i;
    }
    return found;
  }

  /** The query block (or statement) that owns `group`, walking up through expression groups. */
  blockOf(group: number): number {
    let g = group;
    while (g >= 0 && !this.isQuery(g)) g = this.owner[g]!;
    return g;
  }

  block(open: number): Block {
    let block = this.blocks.get(open);
    if (!block) {
      block = this.buildBlock(open);
      this.blocks.set(open, block);
    }
    return block;
  }

  /** The segment of `block` that contains token position `index`. */
  segmentAt(block: Block, index: number): Segment {
    let found = block.segments[0]!;
    for (const segment of block.segments) {
      if (segment.start <= index) found = segment;
      else break;
    }
    return found;
  }

  /** CTEs visible from a group: those of every enclosing block, innermost first. */
  ctesVisibleFrom(group: number): Cte[] {
    const out: Cte[] = [];
    let g = group;
    for (;;) {
      if (this.isQuery(g)) out.push(...this.block(g).ctes);
      if (g < 0) break;
      g = this.owner[g]!;
    }
    return out;
  }

  /** Identifiers in a group, e.g. `(a, b, "C")` → ['a', 'b', 'C']. */
  identList(open: number): string[] {
    const out: string[] = [];
    for (const i of this.members.get(open) ?? []) {
      const ident = identOf(this.toks[i]!);
      if (ident && i !== this.word) out.push(ident.name);
    }
    return out;
  }

  private buildGroups(): void {
    const toks = this.toks;
    const n = toks.length;
    const at = this.at;
    // Pass 1: plain matching, to learn which groups the user has not closed.
    const unmatched = new Set<number>();
    {
      const stack: number[] = [];
      for (let i = 0; i < n; i++) {
        if (this.isPunct(i, '(')) stack.push(i);
        else if (this.isPunct(i, ')')) stack.pop();
      }
      for (const open of stack) unmatched.add(open);
    }
    // Pass 2: an unclosed expression group opened before the cursor ends at the first clause
    // keyword after the cursor, so `SELECT count( FROM t` still sees FROM t at statement level.
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      if (unmatched.size > 0 && i >= at && IMPLICIT_CLOSERS.has(toks[i]!.upper)) {
        for (;;) {
          const top = stack[stack.length - 1];
          if (top === undefined || !unmatched.has(top) || top >= at || this.isQuery(top)) break;
          stack.pop();
          this.close[top] = i;
        }
      }
      // Both parentheses of a group belong to the enclosing group.
      if (this.isPunct(i, ')') && stack.length > 0) this.close[stack.pop()!] = i;
      this.owner[i] = stack[stack.length - 1] ?? -1;
      if (this.isPunct(i, '(')) stack.push(i);
    }
    for (const open of stack) this.close[open] = n;
  }

  /** Skips routine-body scaffolding and EXPLAIN / CREATE ... AS prefixes before the cursor. */
  private findRootStart(): number {
    const root = this.members.get(-1) ?? [];
    const before = root.filter((i) => i < this.at);
    if (before.length === 0) return 0;
    const w0 = this.upper(before[0]!);

    // Routine bodies: CREATE [DEFINER=...] PROCEDURE|FUNCTION|TRIGGER|EVENT ... BEGIN ..., and
    // MariaDB's anonymous BEGIN NOT ATOMIC ... END.
    let body = this.inBody;
    let routineKind = '';
    if (w0 === 'CREATE') {
      for (let k = 1; k < Math.min(before.length, 12); k++) {
        const w = this.upper(before[k]!);
        if (ROUTINE_KINDS.has(w)) {
          body = true;
          routineKind = w;
          break;
        }
        if (w === 'TABLE' || w === 'VIEW' || w === 'INDEX') break;
      }
    } else if (w0 === 'BEGIN' && this.upper(before[1] ?? -1) === 'NOT') {
      body = true;
    }

    let current = 0;
    if (body) {
      for (let k = 0; k < before.length; k++) {
        const i = before[k]!;
        const w = this.upper(i);
        const firstWord = this.upper(before[current] ?? -1);
        let cut = -1;
        if (w === 'BEGIN') {
          cut = k + 1;
          if (this.upper(before[cut] ?? -1) === 'NOT') cut++;
          if (this.upper(before[cut] ?? -1) === 'ATOMIC') cut++;
        } else if (w === 'LOOP' || w === 'REPEAT') {
          cut = k + 1;
        } else if (w === 'THEN' || w === 'ELSE' || w === 'DO') {
          if (
            CONTROL_STARTS.has(firstWord) ||
            (w === 'DO' && routineKind === 'EVENT') ||
            (w === 'ELSE' && k === current)
          ) {
            cut = k + 1;
          }
        } else if (w === 'ROW' && this.upper(before[k - 1] ?? -1) === 'EACH') {
          cut = k + 1;
        } else if (this.isPunct(i, ':') && k === current + 1) {
          cut = k + 1;
        }
        if (cut >= 0) {
          current = cut;
          k = cut - 1;
        }
      }
      if (current >= before.length) return this.at;
    }

    // The statement proper inside EXPLAIN, CREATE VIEW/TABLE ... AS, DECLARE ... CURSOR FOR.
    const first = this.upper(before[current]!);
    if (first === 'EXPLAIN' || first === 'DESCRIBE' || first === 'DESC') {
      let k = current + 1;
      while (k < before.length) {
        const i = before[k]!;
        if (EXPLAIN_OPTIONS.has(this.upper(i)) || EXPLAIN_OPTIONS.has(this.toks[i]!.text)) k++;
        else if (this.isPunct(i, '(') || this.isPunct(i, ')')) k++;
        else break;
      }
      const i = before[k];
      if (i !== undefined && DML_STARTS.has(this.upper(i))) return i;
    } else if (first === 'CREATE' || first === 'PREPARE' || first === 'DECLARE') {
      for (let k = current + 1; k < before.length; k++) {
        const w = this.upper(before[k]!);
        if (w !== 'SELECT' && w !== 'WITH' && w !== 'VALUES') continue;
        // CREATE TABLE ... WITH (options) is not a query.
        if (w === 'WITH' && this.isPunct(before[k + 1] ?? -1, '(')) continue;
        return before[k]!;
      }
    }
    return before[current]!;
  }

  private buildBlock(open: number): Block {
    const tokens = this.membersOf(open);
    const ctes: Cte[] = [];
    let p = 0;
    let withEnd = -1;
    if (this.upper(tokens[0] ?? -1) === 'WITH') {
      p = 1;
      const recursive = this.upper(tokens[1] ?? -1) === 'RECURSIVE';
      if (recursive) p++;
      for (;;) {
        const nameIndex = tokens[p];
        if (nameIndex === undefined || nameIndex === this.word) break;
        const name = identOf(this.toks[nameIndex]!);
        if (!name || (name.quoted === false && CLAUSE_WORDS.has(this.upper(nameIndex)))) break;
        p++;
        const cte: {
          name: Ident;
          recursive: boolean;
          columns?: string[];
          columnsGroup?: number;
          body?: number;
        } = {
          name,
          recursive,
        };
        if (this.isPunct(tokens[p] ?? -1, '(')) {
          cte.columnsGroup = tokens[p]!;
          cte.columns = this.identList(tokens[p]!);
          p = this.skipGroup(tokens, p);
        }
        if (this.upper(tokens[p] ?? -1) !== 'AS') {
          ctes.push(cte);
          break;
        }
        p++;
        if (this.upper(tokens[p] ?? -1) === 'NOT') p++;
        if (this.upper(tokens[p] ?? -1) === 'MATERIALIZED') p++;
        if (this.isPunct(tokens[p] ?? -1, '(')) {
          cte.body = tokens[p]!;
          p = this.skipGroup(tokens, p);
        }
        ctes.push(cte);
        if (!this.isPunct(tokens[p] ?? -1, ',')) break;
        p++;
      }
      withEnd = tokens[p] ?? this.toks.length;
    }

    const segments: Segment[] = [];
    let current: number[] = [];
    let start = tokens[p] ?? (open < 0 ? this.toks.length : this.closeOf(open));
    for (let k = p; k < tokens.length; k++) {
      const i = tokens[k]!;
      if (SET_OPERATORS.has(this.upper(i)) && i !== this.word) {
        segments.push(this.buildSegment(start, current));
        current = [];
        const next = this.upper(tokens[k + 1] ?? -1);
        if ((next === 'ALL' || next === 'DISTINCT') && tokens[k + 1] !== this.word) k++;
        start = tokens[k]! + 1;
        continue;
      }
      current.push(i);
    }
    segments.push(this.buildSegment(start, current));
    return { open, tokens, ctes, withEnd, segments };
  }

  /** Position after a '(' at tokens[p] and its ')' (when that is the next member). */
  private skipGroup(tokens: readonly number[], p: number): number {
    const open = tokens[p]!;
    const next = tokens[p + 1];
    if (next !== undefined && next === this.close[open] && this.isPunct(next, ')')) return p + 2;
    return p + 1;
  }

  private buildSegment(start: number, tokens: readonly number[]): Segment {
    const markers: Marker[] = [];
    const refs: RelationRef[] = [];
    const verb = this.upper(tokens[0] ?? -1);
    let last: Clause | undefined;
    const mark = (clause: Clause, k: number, bodyK: number): void => {
      markers.push({ clause, token: tokens[k]!, body: tokens[bodyK] ?? this.endOf(tokens) });
      last = clause;
    };

    for (let k = 0; k < tokens.length; k++) {
      const i = tokens[k]!;
      if (i === this.word) continue;
      const w = this.upper(i);
      const next = this.upper(tokens[k + 1] ?? -1);
      switch (w) {
        case 'SELECT':
          mark('select', k, k + 1);
          break;
        case 'FROM':
          if (this.upper(tokens[k - 1] ?? -1) === 'DISTINCT') break;
          mark('from', k, k + 1);
          k = this.parseRefs(tokens, k + 1, 'from', true, refs) - 1;
          break;
        case 'JOIN':
        case 'STRAIGHT_JOIN':
          mark('join', k, k + 1);
          k = this.parseRefs(tokens, k + 1, 'join', false, refs) - 1;
          break;
        case 'ON':
          if (next === 'CONFLICT') mark('conflict', k, k + 2);
          else if (next === 'DUPLICATE') mark('duplicate', k, k + 4);
          else if (last === 'join' || last === 'from' || verb === 'MERGE') mark('on', k, k + 1);
          break;
        case 'USING':
          if (last === 'join') mark('using', k, k + 1);
          else if (verb === 'DELETE' || verb === 'MERGE') {
            mark('from', k, k + 1);
            k = this.parseRefs(tokens, k + 1, 'from', true, refs) - 1;
          }
          break;
        case 'WHERE':
          mark('where', k, k + 1);
          break;
        case 'GROUP':
          if (next === 'BY') mark('group-by', k, k + 2);
          break;
        case 'ORDER':
          if (next === 'BY') mark('order-by', k, k + 2);
          break;
        case 'HAVING':
          mark('having', k, k + 1);
          break;
        case 'WINDOW':
          mark('window', k, k + 1);
          break;
        case 'LIMIT':
        case 'OFFSET':
        case 'FETCH':
          mark('limit', k, k + 1);
          break;
        case 'FOR':
          if (next === 'UPDATE' || next === 'SHARE' || next === 'NO' || next === 'KEY') {
            mark('lock', k, k + 2);
            k++;
          }
          break;
        case 'INTO':
          if (verb === 'INSERT' || verb === 'REPLACE') {
            mark('into', k, k + 1);
            k = this.parseRefs(tokens, k + 1, 'target', false, refs) - 1;
          } else if (verb === 'MERGE') {
            mark('from', k, k + 1);
            k = this.parseRefs(tokens, k + 1, 'merge-target', false, refs) - 1;
          } else {
            mark('select-into', k, k + 1);
          }
          break;
        case 'VALUES':
        case 'VALUE':
          // VALUES(col) inside ON DUPLICATE KEY UPDATE is a function, not a clause.
          if (last === 'duplicate' || last === 'set') break;
          if (w === 'VALUES' || verb === 'INSERT' || verb === 'REPLACE') mark('values', k, k + 1);
          break;
        case 'SET':
          mark('set', k, k + 1);
          break;
        case 'UPDATE':
          if (k === 0) {
            mark('update', k, k + 1);
            k = this.parseRefs(tokens, k + 1, 'update', true, refs) - 1;
          }
          break;
        case 'DELETE':
          if (k === 0) mark('delete', k, k + 1);
          break;
        case 'INSERT':
        case 'REPLACE':
          if (k === 0) {
            mark('insert', k, k + 1);
            let j = k + 1;
            while (INSERT_MODIFIERS.has(this.upper(tokens[j] ?? -1))) j++;
            if (this.upper(tokens[j] ?? -1) !== 'INTO' && tokens[j] !== undefined) {
              k = this.parseRefs(tokens, j, 'target', false, refs) - 1;
            }
          } else if (verb === 'MERGE' && w === 'INSERT') {
            mark('merge-insert', k, k + 1);
          }
          break;
        case 'RETURNING':
          mark('returning', k, k + 1);
          break;
        case 'DO':
          if (last === 'conflict') mark('conflict-do', k, k + 1);
          break;
        case 'MERGE':
          if (k === 0) mark('merge', k, k + 1);
          break;
        case 'WHEN':
          if (verb === 'MERGE') mark('merge-when', k, k + 1);
          break;
        case 'TABLE':
          if (k === 0) {
            mark('from', k, k + 1);
            k = this.parseRefs(tokens, k + 1, 'from', false, refs) - 1;
          }
          break;
        default:
          break;
      }
    }
    return { start, tokens, markers, refs };
  }

  private endOf(tokens: readonly number[]): number {
    const lastToken = tokens[tokens.length - 1];
    return lastToken === undefined ? this.toks.length : lastToken + 1;
  }

  /**
   * Parses table references from tokens[k]: `ref [AS] alias [(cols)] [, ref ...]` where a ref is
   * `[LATERAL|ONLY] name[.name...] [(args)]` or `(subquery)`. Returns the position after them.
   */
  private parseRefs(
    tokens: readonly number[],
    k: number,
    role: RefRole,
    list: boolean,
    out: RelationRef[],
  ): number {
    let p = k;
    for (;;) {
      while (
        p < tokens.length &&
        (this.upper(tokens[p]!) === 'LATERAL' || this.upper(tokens[p]!) === 'ONLY')
      ) {
        p++;
      }
      const startIndex = tokens[p];
      if (startIndex === undefined || startIndex === this.word) return p;
      const ref: {
        kind: 'table' | 'subquery' | 'function';
        parts: Ident[];
        alias?: Ident;
        aliasColumns?: string[];
        group?: number;
        columnList?: number;
        aliasColumnsGroup?: number;
        index: number;
        role: RefRole;
      } = { kind: 'table', parts: [], index: startIndex, role };

      if (this.isPunct(startIndex, '(')) {
        ref.kind = 'subquery';
        ref.group = startIndex;
        if (!this.isQuery(startIndex)) {
          // A parenthesised join: its references are in scope too.
          const inner = this.members.get(startIndex) ?? [];
          const saved = out.length;
          this.parseRefs(inner, 0, role, true, out);
          for (let q = 0; q < inner.length; q++) {
            if (this.upper(inner[q]!) === 'JOIN') this.parseRefs(inner, q + 1, 'join', false, out);
          }
          if (out.length > saved) {
            p = this.skipGroup(tokens, p);
            if (!list || !this.isPunct(tokens[p] ?? -1, ',')) return p;
            p++;
            continue;
          }
        }
        p = this.skipGroup(tokens, p);
      } else {
        const first = identOf(this.toks[startIndex]!);
        if (!first || (!first.quoted && CLAUSE_WORDS.has(this.upper(startIndex)))) return p;
        ref.parts.push(first);
        p++;
        while (this.isPunct(tokens[p] ?? -1, '.')) {
          const partIndex = tokens[p + 1];
          const part = partIndex === undefined ? undefined : identOf(this.toks[partIndex]!);
          if (!part || partIndex === this.word) {
            p++;
            break;
          }
          ref.parts.push(part);
          p += 2;
        }
        if (this.isPunct(tokens[p] ?? -1, '(')) {
          if (role === 'target' || role === 'merge-target') {
            ref.columnList = tokens[p]!;
          } else {
            ref.kind = 'function';
            ref.group = tokens[p]!;
          }
          p = this.skipGroup(tokens, p);
        }
      }

      // Alias.
      let aliasAt = p;
      if (this.upper(tokens[p] ?? -1) === 'AS') aliasAt = p + 1;
      const aliasIndex = tokens[aliasAt];
      if (aliasIndex !== undefined && aliasIndex !== this.word) {
        const alias = identOf(this.toks[aliasIndex]!);
        if (alias && (alias.quoted || !CLAUSE_WORDS.has(this.upper(aliasIndex)))) {
          ref.alias = alias;
          p = aliasAt + 1;
          const targets = role === 'target' || role === 'merge-target';
          if (this.isPunct(tokens[p] ?? -1, '(') && !targets) {
            ref.aliasColumnsGroup = tokens[p]!;
            ref.aliasColumns = this.identList(tokens[p]!);
            p = this.skipGroup(tokens, p);
          }
        }
      }
      if (
        ref.alias === undefined &&
        ref.columnList === undefined &&
        (role === 'target' || role === 'merge-target') &&
        this.isPunct(tokens[p] ?? -1, '(')
      ) {
        ref.columnList = tokens[p]!;
        p = this.skipGroup(tokens, p);
      }
      out.push(ref);
      if (!list || !this.isPunct(tokens[p] ?? -1, ',')) return p;
      p++;
    }
  }
}
