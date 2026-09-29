import type { SqlDialect } from '@joinery/core';

import { canonicalPgType } from './types';

/**
 * A small, dialect-aware SQL lexer used to compare definitions (views, routines, triggers,
 * checks, defaults) and to find the objects they reference. It is not a parser: it only needs
 * to know where strings, quoted identifiers and comments begin and end, so that whitespace and
 * keyword case can be normalised outside them.
 */

export type SqlTokenKind =
  | 'ws'
  | 'comment'
  | 'string'
  | 'dollar-string'
  | 'quoted-ident'
  | 'word'
  | 'number'
  | 'param'
  | 'op'
  | 'punct';

export interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly text: string;
  /** Unescaped name for quoted identifiers; body for dollar-quoted strings. */
  readonly value?: string;
}

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;
const OP_CHARS = '+-*/<>=~!@#%^&|?:';
const PUNCT = '(),;.[]{}';

function isMysql(dialect: SqlDialect): boolean {
  return dialect !== 'postgres';
}

/** Splits SQL text into tokens. Unterminated strings and comments run to the end of the text. */
export function tokenizeSql(text: string, dialect: SqlDialect): SqlToken[] {
  const tokens: SqlToken[] = [];
  const n = text.length;
  let i = 0;
  const push = (kind: SqlTokenKind, start: number, end: number, value?: string): void => {
    tokens.push(
      value === undefined
        ? { kind, text: text.slice(start, end) }
        : { kind, text: text.slice(start, end), value },
    );
  };

  while (i < n) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(text[j]!)) j++;
      push('ws', i, j);
      i = j;
      continue;
    }

    // Line comments: "--" (MySQL requires whitespace after it) and MySQL "#".
    if (
      (ch === '-' &&
        next === '-' &&
        (!isMysql(dialect) || i + 2 >= n || /\s/.test(text[i + 2]!))) ||
      (ch === '#' && isMysql(dialect))
    ) {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      push('comment', i, j);
      i = j;
      continue;
    }

    if (ch === '/' && next === '*') {
      // PostgreSQL block comments nest; MySQL ones do not.
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (text[j] === '*' && text[j + 1] === '/') {
          depth--;
          j += 2;
        } else if (!isMysql(dialect) && text[j] === '/' && text[j + 1] === '*') {
          depth++;
          j += 2;
        } else {
          j++;
        }
      }
      push('comment', i, j);
      i = j;
      continue;
    }

    // String literals, with optional PostgreSQL E/U&/B/X prefixes and MySQL introducers handled
    // as separate words.
    if (ch === "'" || (ch === '"' && isMysql(dialect))) {
      const quote = ch;
      const backslash = isMysql(dialect) || isEscapeStringPrefix(tokens);
      let j = i + 1;
      while (j < n) {
        const c = text[j]!;
        if (backslash && c === '\\') {
          j += 2;
          continue;
        }
        if (c === quote) {
          if (text[j + 1] === quote) {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      push('string', i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }

    if ((ch === '"' && !isMysql(dialect)) || (ch === '`' && isMysql(dialect))) {
      const quote = ch;
      let j = i + 1;
      let value = '';
      while (j < n) {
        const c = text[j]!;
        if (c === quote) {
          if (text[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          j++;
          break;
        }
        value += c;
        j++;
      }
      push('quoted-ident', i, Math.min(j, n), value);
      i = Math.min(j, n);
      continue;
    }

    if (ch === '$' && !isMysql(dialect)) {
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(text.slice(i));
      if (tag) {
        const delimiter = tag[0];
        const bodyStart = i + delimiter.length;
        const close = text.indexOf(delimiter, bodyStart);
        const end = close === -1 ? n : close + delimiter.length;
        push('dollar-string', i, end, text.slice(bodyStart, close === -1 ? n : close));
        i = end;
        continue;
      }
      const param = /^\$\d+/.exec(text.slice(i));
      if (param) {
        push('param', i, i + param[0].length);
        i += param[0].length;
        continue;
      }
    }

    if (/\d/.test(ch) || (ch === '.' && next !== undefined && /\d/.test(next))) {
      const match = /^(?:0x[0-9A-Fa-f]+|\d*\.?\d+(?:[eE][+-]?\d+)?|\d+\.(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
      const len = match ? match[0].length : 1;
      push('number', i, i + len);
      i += len;
      continue;
    }

    if (WORD_START.test(ch)) {
      let j = i + 1;
      while (j < n && WORD_PART.test(text[j]!)) j++;
      push('word', i, j);
      i = j;
      continue;
    }

    if (ch === '?' && isMysql(dialect)) {
      push('param', i, i + 1);
      i++;
      continue;
    }

    if (PUNCT.includes(ch)) {
      push('punct', i, i + 1);
      i++;
      continue;
    }

    if (OP_CHARS.includes(ch)) {
      let j = i + 1;
      while (
        j < n &&
        OP_CHARS.includes(text[j]!) &&
        !(text[j] === '-' && text[j + 1] === '-') &&
        !(text[j] === '/' && text[j + 1] === '*') &&
        !(text[j] === '#' && isMysql(dialect))
      ) {
        j++;
      }
      push('op', i, j);
      i = j;
      continue;
    }

    push('op', i, i + 1);
    i++;
  }
  return tokens;
}

function isEscapeStringPrefix(tokens: readonly SqlToken[]): boolean {
  const last = tokens[tokens.length - 1];
  return last !== undefined && last.kind === 'word' && /^[eE]$/.test(last.text);
}

/**
 * Words folded to lower case during normalisation. Unquoted identifiers keep their case in
 * MySQL (table names are case-sensitive on most platforms), so only keywords and common
 * built-in function names are folded there. PostgreSQL folds every unquoted word, exactly as
 * the server does.
 */
const KEYWORDS = new Set(
  `add after algorithm all alter always and any array as asc at authorization before begin
  between bigint binary bit blob bool boolean both by call called cascade cascaded case cast
  char character check close coalesce collate column comment commit completion concat constraint
  contains continue convert cost count create cross current current_date current_time
  current_timestamp current_user cursor data date datetime day declare decimal default
  deferrable deferred definer delete desc deterministic disable distinct div do double drop each
  else elseif elsif enable end ends enum escape every except exception exec execute exists exit
  extract false fetch filter first float following for foreign from full function generated get
  greatest group having hour if ifnull ilike immutable in index inner inout insert instead int
  integer intersect interval into invoker is isnull iterate join json jsonb key language last
  lateral leading leakproof least leave left length like limit local localtime localtimestamp
  loop lower max merge min minute mod modifies month natural new next no not notice now null
  nullif nulls numeric of offset old on only open or order out outer over parallel partition
  perform position preceding precision preserve primary procedure raise range reads real
  recursive references repeat replace restrict restricted return returning returns right rlike
  row rows safe schedule second security select set setof signal similar smallint some sql
  sqlexception sqlstate sqlwarning stable starts statement stored strict substring sum table
  temptable text then time timestamp to trailing trigger trim true unbounded undefined union
  unique unsafe unsigned until update upper using values varchar variadic varying view virtual
  volatile when where while window with within without xor year zone zerofill`.split(/\s+/),
);

export function isSqlKeyword(word: string): boolean {
  return KEYWORDS.has(word.toLowerCase());
}

export interface NormalizeSqlOptions {
  /** Fold identifiers too (ignore name case). */
  readonly foldIdentifiers?: boolean;
  /**
   * Normalise the inside of PostgreSQL dollar-quoted bodies as SQL. Only safe for sql and
   * plpgsql bodies: other languages (plpython...) are whitespace-sensitive.
   */
  readonly normalizeDollarBodies?: boolean;
  /** MySQL: drop qualifications with this database name ("`shop`.`users`" → "users"). */
  readonly stripQualifier?: string;
  /** Keep comments (routine bodies); views and expressions drop them. */
  readonly keepComments?: boolean;
  /**
   * Identifier substitutions applied before comparing, for objects the script renames
   * (PostgreSQL rewrites dependent definitions on rename, so old names compare as new ones).
   */
  readonly renamedIdentifiers?: ReadonlyMap<string, string>;
  /**
   * PostgreSQL expressions of one table (checks, index expressions and predicates, generated
   * columns): its columns as the normalised text spells them → their type without typmod
   * (`pgBaseType`). Redundant casts of literals are dropped (see simplifyPgLiteralCasts).
   */
  readonly columnTypes?: ReadonlyMap<string, string>;
}

const SIMPLE_PG_IDENT = /^[a-z_][a-z0-9_$]*$/;
const SIMPLE_MYSQL_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Canonical text for comparing two definitions: whitespace collapsed outside literals, keywords
 * lower-cased, redundant identifier quotes removed, trailing semicolons dropped. The result is
 * for comparison only; scripts always use the original text.
 */
export function normalizeSql(
  text: string,
  dialect: SqlDialect,
  options: NormalizeSqlOptions = {},
): string {
  const tokens = tokenizeSql(text, dialect);
  const out: string[] = [];
  const pg = dialect === 'postgres';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    switch (token.kind) {
      case 'ws':
        break;
      case 'comment':
        if (options.keepComments) out.push(canonicalComment(token.text));
        break;
      case 'word': {
        if (
          options.stripQualifier !== undefined &&
          isQualifierAt(tokens, i, options.stripQualifier)
        ) {
          i += 1; // the qualifier's dot
          break;
        }
        const folded =
          pg || options.foldIdentifiers || isSqlKeyword(token.text)
            ? token.text.toLowerCase()
            : token.text;
        out.push(options.renamedIdentifiers?.get(folded) ?? folded);
        break;
      }
      case 'quoted-ident': {
        const name = options.renamedIdentifiers?.get(token.value ?? '') ?? token.value ?? '';
        if (
          options.stripQualifier !== undefined &&
          isQualifierAt(tokens, i, options.stripQualifier)
        ) {
          i += 1; // the qualifier's dot
          break;
        }
        if (options.foldIdentifiers) {
          out.push(pg ? `"${name.toLowerCase()}"` : name.toLowerCase());
        } else if (pg) {
          out.push(SIMPLE_PG_IDENT.test(name) ? name : `"${name.replaceAll('"', '""')}"`);
        } else {
          out.push(
            SIMPLE_MYSQL_IDENT.test(name) && !isSqlKeyword(name)
              ? name
              : `\`${name.replaceAll('`', '``')}\``,
          );
        }
        break;
      }
      case 'dollar-string':
        if (options.normalizeDollarBodies) {
          out.push(
            `$$ ${normalizeSql(token.value ?? '', dialect, { ...options, keepComments: true })} $$`,
          );
        } else {
          out.push(`$$${token.value ?? ''}$$`);
        }
        break;
      default:
        out.push(token.text);
    }
  }
  while (out.length > 0 && out[out.length - 1] === ';') out.pop();
  if (!pg) return out.join(' ');
  const simplified = simplifyPgStringCasts(out);
  return (
    options.columnTypes === undefined
      ? simplified
      : simplifyPgLiteralCasts(simplified, options.columnTypes)
  ).join(' ');
}

const STRING_TYPES: readonly (readonly string[])[] = [
  ['character', 'varying'],
  ['varchar'],
  ['text'],
  ['bpchar'],
];

/** Length of an unconstrained string type name at `i` (0 when none): `text`, `character varying`... */
function stringTypeAt(out: readonly string[], i: number): number {
  for (const words of STRING_TYPES) {
    if (words.every((w, k) => out[i + k] === w) && out[i + words.length] !== '(')
      return words.length;
  }
  return 0;
}

const isStringLiteral = (token: string | undefined): boolean =>
  token !== undefined && token.startsWith("'");

/**
 * PostgreSQL does not deparse string-literal casts idempotently: a check written as
 * `status IN ('a', 'b')` on a varchar column reads back as
 * `(status)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])`,
 * and re-creating it from that text reads back as
 * `... ANY (ARRAY[('a'::character varying)::text, ('b'::character varying)::text])`.
 * Casts of string literals (and of arrays of them) between unconstrained string types change
 * nothing, so they are dropped before comparing.
 */
function simplifyPgStringCasts(tokens: readonly string[]): string[] {
  let out = [...tokens];
  let changed = true;
  while (changed) {
    changed = false;
    const next: string[] = [];
    for (let i = 0; i < out.length; i++) {
      const t = out[i]!;
      // 'x'::text → 'x'
      if (isStringLiteral(t) && out[i + 1] === '::') {
        const len = stringTypeAt(out, i + 2);
        if (len > 0 && out[i + 2 + len] !== '[') {
          next.push(t);
          i += 1 + len;
          changed = true;
          continue;
        }
      }
      // ('x') :: ... → 'x' :: ...
      if (t === '(' && isStringLiteral(out[i + 1]) && out[i + 2] === ')' && out[i + 3] === '::') {
        next.push(out[i + 1]!);
        i += 2;
        changed = true;
        continue;
      }
      // (ARRAY[...])::text[] and ARRAY[...]::text[] → ARRAY[...]
      const parenthesised = t === '(' && out[i + 1] === 'array' && out[i + 2] === '[';
      if (parenthesised || (t === 'array' && out[i + 1] === '[')) {
        const open = parenthesised ? i + 2 : i + 1;
        let depth = 0;
        let close = -1;
        for (let j = open; j < out.length; j++) {
          if (out[j] === '[') depth++;
          else if (out[j] === ']' && --depth === 0) {
            close = j;
            break;
          }
        }
        const after = parenthesised ? close + 1 : close;
        if (close !== -1 && (!parenthesised || out[after] === ')') && out[after + 1] === '::') {
          const len = stringTypeAt(out, after + 2);
          if (len > 0 && out[after + 2 + len] === '[' && out[after + 3 + len] === ']') {
            next.push(...out.slice(parenthesised ? i + 1 : i, close + 1));
            i = after + 3 + len;
            changed = true;
            continue;
          }
        }
      }
      next.push(t);
    }
    out = next;
  }
  return out;
}

/**
 * A PostgreSQL type without its typmod and schema, for telling whether a literal cast targets a
 * column's type: numeric(10,2) → numeric, timestamp(3) with time zone → timestamp with time
 * zone, public.mood → mood. Arrays keep their [].
 */
export function pgBaseType(type: string): string {
  let text = canonicalPgType(type).replace(/\((?:[^()'"]|'[^']*')*\)/g, '');
  for (;;) {
    const qualifier = /^(?:"(?:[^"]|"")*"|[^".\s]+)\./.exec(text);
    if (qualifier === null) break;
    text = text.slice(qualifier[0].length);
  }
  return text.replace(/\s+/g, ' ').trim();
}

const PG_NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const PG_INT4_MIN = -2147483648n;
const PG_INT4_MAX = 2147483647n;

/**
 * The number a PostgreSQL constant `'text'::type` prints for, as tokens (`- 5` for negatives),
 * or undefined. PostgreSQL deparses constants that would not re-read as their own type that
 * way: negative integers ('-5'::integer), integers beyond int4 ('3000000000'::bigint) and
 * negative decimals ('-2.5'::numeric). Each equals the bare literal.
 */
function pgNumericConstant(literal: string, type: string): string[] | undefined {
  if (!literal.startsWith("'") || !literal.endsWith("'")) return undefined;
  const text = literal.slice(1, -1);
  const tokens = (): string[] => (text.startsWith('-') ? ['-', text.slice(1)] : [text]);
  if (type === 'integer' || type === 'bigint') {
    if (!/^-?(?:0|[1-9]\d*)$/.test(text)) return undefined;
    const value = BigInt(text);
    const int4 = value >= PG_INT4_MIN && value <= PG_INT4_MAX;
    return int4 === (type === 'integer') ? tokens() : undefined;
  }
  if (type === 'numeric') {
    return /^-?(?:\d+\.\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? tokens() : undefined;
  }
  return undefined;
}

const PG_TYPE_CONTINUATION: Readonly<Record<string, readonly string[]>> = {
  double: ['precision'],
  character: ['varying'],
  bit: ['varying'],
};

/**
 * The cast target at `out[i]` (after `::`): where it ends, and its base type, or null when it
 * has a typmod or is an array (such casts change values, so they are never dropped).
 */
function pgCastTypeAt(
  out: readonly string[],
  i: number,
): { end: number; type: string | null } | undefined {
  const first = out[i];
  if (first === undefined || !/^[a-z_"]/.test(first)) return undefined;
  const words = [first];
  let k = i + 1;
  while (out[k] === '.' && out[k + 1] !== undefined && /^[a-z_"]/.test(out[k + 1]!)) {
    words.push('.', out[k + 1]!);
    k += 2;
  }
  for (const next of PG_TYPE_CONTINUATION[first] ?? []) {
    if (out[k] === next) {
      words.push(' ', next);
      k++;
    }
  }
  let plain = true;
  if (out[k] === '(') {
    plain = false;
    while (k < out.length && out[k] !== ')') k++;
    k++;
  }
  if (
    (first === 'timestamp' || first === 'time') &&
    (out[k] === 'with' || out[k] === 'without') &&
    out[k + 1] === 'time' &&
    out[k + 2] === 'zone'
  ) {
    words.push(' ', out[k]!, ' time zone');
    k += 3;
  }
  while (out[k] === '[') {
    plain = false;
    while (k < out.length && out[k] !== ']') k++;
    k++;
  }
  return { end: k, type: plain ? pgBaseType(words.join('')) : null };
}

/**
 * A literal with a cast at `out[i]`: `0::numeric`, `(0)::numeric`, `'x'::date`, `(- 1)::numeric`
 * (a negative constant after pgNumericConstant), with where it ends and the literal alone.
 */
function pgLiteralCastAt(
  out: readonly string[],
  i: number,
): { end: number; literal: string[]; type: string | null } | undefined {
  const isLiteral = (t: string | undefined): boolean =>
    t !== undefined && (PG_NUMBER.test(t) || isStringLiteral(t));
  let literal: string[];
  let k: number;
  if (isLiteral(out[i])) {
    literal = [out[i]!];
    k = i + 1;
  } else if (out[i] === '(' && PG_NUMBER.test(out[i + 1] ?? '') && out[i + 2] === ')') {
    literal = [out[i + 1]!];
    k = i + 3;
  } else if (
    out[i] === '(' &&
    out[i + 1] === '-' &&
    PG_NUMBER.test(out[i + 2] ?? '') &&
    out[i + 3] === ')'
  ) {
    literal = ['-', out[i + 2]!];
    k = i + 4;
  } else {
    return undefined;
  }
  if (out[k] !== '::') return undefined;
  const cast = pgCastTypeAt(out, k + 1);
  return cast === undefined ? undefined : { end: cast.end, literal, type: cast.type };
}

const PG_BINARY_OPERATORS = new Set([
  '=',
  '<>',
  '!=',
  '<',
  '>',
  '<=',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
]);
/** Tokens that end an operand on its left or right: nothing binds tighter across them. */
const PG_OPERAND_START = new Set(['(', ',', 'and', 'or', 'not', 'when', 'then', 'else', 'where']);
const PG_OPERAND_END = new Set([')', ',', 'and', 'or', 'then', 'else', 'end', 'when']);

/**
 * PostgreSQL prints the coercions it applies to operator arguments: a check written as
 * `price > 0` on a numeric column reads back as `(price > (0)::numeric)`, `d > '2020-01-01'`
 * on a date column as `(d > '2020-01-01'::date)`, and negative or large constants as
 * `'-1'::integer` or `'3000000000'::bigint`. Those constants become bare literals, and a cast
 * of a literal is dropped when the literal is a whole operand of a comparison or arithmetic
 * operator whose other whole operand is a column of exactly the cast's type (without typmod):
 * the server would apply that coercion anyway. Casts of columns, casts with a typmod, casts to
 * another type and casts between literals are kept, since they can change the result.
 */
function simplifyPgLiteralCasts(
  tokens: readonly string[],
  columnTypes: ReadonlyMap<string, string>,
): string[] {
  const constants: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const cast = tokens[i + 1] === '::' ? pgCastTypeAt(tokens, i + 2) : undefined;
    const number =
      cast !== undefined && cast.type !== null ? pgNumericConstant(t, cast.type) : undefined;
    if (cast !== undefined && number !== undefined) {
      constants.push(...number);
      i = cast.end - 1;
      continue;
    }
    constants.push(t);
  }
  let out = constants;
  let changed = true;
  while (changed) {
    changed = false;
    const next: string[] = [];
    for (let i = 0; i < out.length; i++) {
      const group = pgLiteralCastAt(out, i);
      if (group !== undefined && group.type !== null) {
        const startsOperand = i === 0 || PG_OPERAND_START.has(out[i - 1]!);
        const endsOperand = (k: number): boolean => k >= out.length || PG_OPERAND_END.has(out[k]!);
        const right =
          PG_BINARY_OPERATORS.has(out[i - 1] ?? '') &&
          columnTypes.get(out[i - 2] ?? '') === group.type &&
          (i - 3 < 0 || PG_OPERAND_START.has(out[i - 3]!)) &&
          endsOperand(group.end);
        const left =
          startsOperand &&
          PG_BINARY_OPERATORS.has(out[group.end] ?? '') &&
          columnTypes.get(out[group.end + 1] ?? '') === group.type &&
          endsOperand(group.end + 2);
        if (right || left) {
          next.push(...group.literal);
          i = group.end - 1;
          changed = true;
          continue;
        }
      }
      next.push(out[i]!);
    }
    out = next;
  }
  return out;
}

/** Line comments become block comments so the canonical text re-tokenises identically. */
function canonicalComment(text: string): string {
  const body = text.startsWith('/*')
    ? text.slice(2, text.endsWith('*/') ? -2 : undefined)
    : text.replace(/^(--|#)/, '');
  return `/* ${body.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */`;
}

function isQualifierAt(tokens: readonly SqlToken[], i: number, qualifier: string): boolean {
  const token = tokens[i]!;
  const name = token.kind === 'quoted-ident' ? token.value : token.text;
  if (name !== qualifier) return false;
  const dot = tokens[i + 1];
  return dot !== undefined && dot.kind === 'punct' && dot.text === '.';
}

/** True when the whole text is wrapped in one pair of matching parentheses. */
export function isFullyParenthesized(text: string, dialect: SqlDialect): boolean {
  const tokens = tokenizeSql(text, dialect).filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  if (tokens.length < 2) return false;
  if (tokens[0]!.text !== '(' || tokens[tokens.length - 1]!.text !== ')') return false;
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'punct') continue;
    if (t.text === '(') depth++;
    else if (t.text === ')') {
      depth--;
      if (depth === 0 && i < tokens.length - 1) return false;
    }
  }
  return depth === 0;
}

/** Removes every pair of parentheses that encloses the whole expression. */
export function stripOuterParens(text: string, dialect: SqlDialect): string {
  let current = text.trim();
  while (isFullyParenthesized(current, dialect)) {
    current = current.slice(current.indexOf('(') + 1, current.lastIndexOf(')')).trim();
  }
  return current;
}

/** Wraps an expression in parentheses unless it already is. */
export function wrapParens(text: string, dialect: SqlDialect): string {
  const trimmed = text.trim();
  return isFullyParenthesized(trimmed, dialect) ? trimmed : `(${trimmed})`;
}

/** Drops trailing semicolons and surrounding whitespace from a statement. */
export function trimStatement(text: string): string {
  let current = text.trim();
  while (current.endsWith(';')) current = current.slice(0, -1).trimEnd();
  return current;
}

/** A name mentioned in a definition: optionally qualified by a schema. */
export interface NameReference {
  readonly schema?: string;
  readonly name: string;
}

/**
 * Identifiers a definition mentions, in PostgreSQL case-folded form for unquoted words. The
 * caller matches them against known object names, so keywords and column names in the list are
 * harmless: they simply match nothing (or cause an extra, safe ordering edge).
 */
export function referencedNames(text: string, dialect: SqlDialect): NameReference[] {
  const tokens = tokenizeSql(text, dialect).filter((t) => t.kind !== 'ws' && t.kind !== 'comment');
  const refs: NameReference[] = [];
  const pg = dialect === 'postgres';
  const nameOf = (t: SqlToken): string | undefined => {
    if (t.kind === 'quoted-ident') return t.value ?? '';
    if (t.kind === 'word') return pg ? t.text.toLowerCase() : t.text;
    return undefined;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === 'dollar-string') {
      refs.push(...referencedNames(token.value ?? '', dialect));
      continue;
    }
    if (token.kind === 'string') {
      // nextval('schema.seq'::regclass) and similar regclass literals.
      const inner = token.text.slice(1, -1).replaceAll("''", "'");
      if (/^[A-Za-z_"][\w$".]*$/.test(inner)) refs.push(...referencedNames(inner, dialect));
      continue;
    }
    const name = nameOf(token);
    if (name === undefined) continue;
    const dot = tokens[i + 1];
    const after = tokens[i + 2];
    if (dot?.kind === 'punct' && dot.text === '.' && after !== undefined) {
      const second = nameOf(after);
      if (second !== undefined) {
        refs.push({ schema: name, name: second });
        refs.push({ name });
        refs.push({ name: second });
        i += 2;
        continue;
      }
    }
    refs.push({ name });
  }
  return refs;
}
