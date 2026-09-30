import type { TypeDef } from '@joinery/core';
import { quoteIdent, quoteString } from '@joinery/sql-tools';

import type { SyncWarning } from '../model';
import type { NormalizeContext } from '../normalize';
import { canonicalDefault, canonicalExpression } from '../normalize';
import { tokenizeSql, trimStatement, wrapParens } from '../sql-text';
import type { SqlToken } from '../sql-text';
import { canonicalType, typeChangeRisk } from '../types';
import type { TypeChangeRisk } from '../types';

/**
 * In-place changes of PostgreSQL domains and composite types that columns use. Dropping and
 * re-creating such a type is impossible while columns use it, but most changes do not need
 * that: ALTER DOMAIN changes the default, NOT NULL and checks, and ALTER TYPE adds and drops
 * attributes. A new base type, collation or attribute type (PostgreSQL: "cannot alter type
 * because column uses it") or a different attribute order still needs the type rebuilt.
 */

interface Part {
  readonly name: string;
  /** Clause text after the name (attribute type, check condition). */
  readonly text: string;
}

export interface DomainParts {
  readonly base: string;
  readonly collation?: string;
  readonly default?: string;
  readonly notNull: boolean;
  readonly checks: readonly Part[];
}

export interface CompositeParts {
  readonly attributes: readonly {
    readonly name: string;
    readonly type: string;
    readonly collation?: string;
  }[];
}

const significant = (tokens: readonly SqlToken[]): SqlToken[] =>
  tokens.filter((t) => t.kind !== 'comment');

const isWord = (t: SqlToken | undefined, word: string): boolean =>
  t !== undefined && t.kind === 'word' && t.text.toLowerCase() === word;

const identName = (t: SqlToken): string =>
  t.kind === 'quoted-ident' ? (t.value ?? '') : t.text.toLowerCase();

const join = (tokens: readonly SqlToken[]): string =>
  tokens
    .map((t) => t.text)
    .join('')
    .trim();

/** Index just past `CREATE DOMAIN|TYPE <qualified name> AS`, or -1. */
function bodyStart(tokens: readonly SqlToken[]): number {
  let i = 0;
  const skipWs = (): void => {
    while (tokens[i]?.kind === 'ws') i++;
  };
  skipWs();
  if (!isWord(tokens[i], 'create')) return -1;
  i++;
  skipWs();
  if (!isWord(tokens[i], 'domain') && !isWord(tokens[i], 'type')) return -1;
  i++;
  skipWs();
  // The (possibly qualified) name.
  for (;;) {
    const t = tokens[i];
    if (t === undefined || (t.kind !== 'word' && t.kind !== 'quoted-ident')) return -1;
    i++;
    if (tokens[i]?.kind === 'punct' && tokens[i]!.text === '.') {
      i++;
      continue;
    }
    break;
  }
  skipWs();
  if (isWord(tokens[i], 'as')) i++;
  return i;
}

/**
 * Splits a domain body into its clauses at depth 0: the base type, then COLLATE, DEFAULT,
 * [NOT] NULL, and [CONSTRAINT name] CHECK clauses. The token right after DEFAULT always belongs
 * to the default expression (DEFAULT NULL).
 */
function domainClauses(tokens: readonly SqlToken[]): SqlToken[][] {
  const out: SqlToken[][] = [[]];
  let depth = 0;
  const words: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) depth++;
    if (t.kind === 'punct' && (t.text === ')' || t.text === ']')) depth--;
    if (t.kind !== 'ws' && depth === 0 && t.kind === 'word') {
      const word = t.text.toLowerCase();
      const prev = words[words.length - 1];
      const afterDefault = prev === 'default';
      const starts =
        !afterDefault &&
        (word === 'collate' ||
          word === 'default' ||
          word === 'constraint' ||
          (word === 'check' && words[words.length - 2] !== 'constraint') ||
          word === 'not' ||
          (word === 'null' && prev !== 'not'));
      if (starts) out.push([]);
    }
    if (t.kind !== 'ws')
      words.push(depth === 0 && t.kind === 'word' ? t.text.toLowerCase() : t.text);
    out[out.length - 1]!.push(t);
  }
  return out;
}

/** Parses `CREATE DOMAIN name AS type [COLLATE c] [DEFAULT e] [NOT NULL] [CONSTRAINT n CHECK (...)]...`. */
export function parseDomain(definition: string): DomainParts | undefined {
  const tokens = significant(tokenizeSql(trimStatement(definition), 'postgres'));
  const start = bodyStart(tokens);
  if (start < 0) return undefined;
  const [head, ...rest] = domainClauses(tokens.slice(start));
  const base = join(head ?? []);
  if (base === '') return undefined;
  let collation: string | undefined;
  let defaultExpr: string | undefined;
  let notNull = false;
  const checks: Part[] = [];
  let unnamed = 0;
  for (const clause of rest) {
    const words = clause.filter((t) => t.kind !== 'ws');
    const first = words[0]!;
    const keyword = first.text.toLowerCase();
    if (keyword === 'collate') {
      if (words[1] === undefined) return undefined;
      collation = identName(words[1]);
    } else if (keyword === 'default') {
      defaultExpr = join(clause.slice(clause.indexOf(first) + 1));
    } else if (keyword === 'not') {
      notNull = true;
    } else if (keyword === 'null') {
      notNull = false;
    } else {
      const checkAt = words.findIndex((t) => isWord(t, 'check'));
      if (checkAt < 0) return undefined;
      const name =
        keyword === 'constraint' && words[1] !== undefined ? identName(words[1]) : `#${unnamed++}`;
      const condition = clause.slice(clause.indexOf(words[checkAt]!) + 1);
      checks.push({ name, text: join(condition).replace(/\s+NOT\s+VALID$/i, '') });
    }
  }
  return {
    base,
    ...(collation !== undefined ? { collation } : {}),
    ...(defaultExpr !== undefined ? { default: defaultExpr } : {}),
    notNull,
    checks,
  };
}

/** Parses `CREATE TYPE name AS (attr type [COLLATE c], ...)`. */
export function parseComposite(definition: string): CompositeParts | undefined {
  const tokens = significant(tokenizeSql(trimStatement(definition), 'postgres'));
  const start = bodyStart(tokens);
  if (start < 0) return undefined;
  let i = start;
  while (tokens[i]?.kind === 'ws') i++;
  if (tokens[i]?.text !== '(') return undefined;
  const attributes: { name: string; type: string; collation?: string }[] = [];
  let depth = 0;
  let current: SqlToken[] = [];
  const flush = (): boolean => {
    const words = current.filter((t) => t.kind !== 'ws');
    current = [];
    if (words.length === 0) return true;
    const name = words[0]!;
    if (name.kind !== 'word' && name.kind !== 'quoted-ident') return false;
    const collateAt = words.findIndex((t, k) => k > 0 && isWord(t, 'collate'));
    const typeTokens = words.slice(1, collateAt < 0 ? undefined : collateAt);
    attributes.push({
      name: identName(name),
      type: typeTokens
        .map((t) => t.text)
        .join(' ')
        .replace(/\s*([()[\],.])\s*/g, '$1'),
      ...(collateAt >= 0 && words[collateAt + 1] !== undefined
        ? { collation: identName(words[collateAt + 1]!) }
        : {}),
    });
    return true;
  };
  for (i = i + 1; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'punct' && t.text === '(') depth++;
    if (t.kind === 'punct' && t.text === ')') {
      if (depth === 0) return flush() ? { attributes } : undefined;
      depth--;
    }
    if (depth === 0 && t.kind === 'punct' && t.text === ',') {
      if (!flush()) return undefined;
      continue;
    }
    current.push(t);
  }
  return undefined;
}

/** The statements that turn the target type into the source one in place, when possible. */
export interface InPlaceChange {
  readonly statements: string[];
  readonly warnings: SyncWarning[];
  readonly destructive: boolean;
}

/**
 * ALTER DOMAIN / ALTER TYPE statements for a domain or composite type that columns use, or
 * undefined when the change needs the type rebuilt (see the module comment).
 */
export function alterTypeInPlace(
  name: string,
  source: TypeDef,
  target: TypeDef,
  src: NormalizeContext,
  tgt: NormalizeContext,
): InPlaceChange | undefined {
  if (source.kind !== target.kind) return undefined;
  if (source.kind === 'domain') return alterDomain(name, source, target, src, tgt);
  if (source.kind === 'composite') return alterComposite(name, source, target);
  return undefined;
}

function alterDomain(
  name: string,
  source: TypeDef,
  target: TypeDef,
  src: NormalizeContext,
  tgt: NormalizeContext,
): InPlaceChange | undefined {
  const a = parseDomain(target.definition);
  const b = parseDomain(source.definition);
  if (a === undefined || b === undefined) return undefined;
  const baseA = canonicalType(a.base, 'postgres');
  const baseB = canonicalType(b.base, 'postgres');
  if (baseA !== baseB || (a.collation ?? null) !== (b.collation ?? null)) return undefined;
  if ([...a.checks, ...b.checks].some((c) => c.name.startsWith('#'))) return undefined;
  const statements: string[] = [];
  const warnings: SyncWarning[] = [];
  const alter = (clause: string): string => `ALTER DOMAIN ${name} ${clause}`;
  if (canonicalDefault(a.default, baseA, tgt) !== canonicalDefault(b.default, baseB, src)) {
    statements.push(alter(b.default !== undefined ? `SET DEFAULT ${b.default}` : 'DROP DEFAULT'));
  }
  const canon = (text: string, ctx: NormalizeContext): string => canonicalExpression(text, ctx);
  const sourceChecks = new Map(b.checks.map((c) => [c.name, c]));
  const targetChecks = new Map(a.checks.map((c) => [c.name, c]));
  for (const check of a.checks) {
    const wanted = sourceChecks.get(check.name);
    if (wanted === undefined || canon(wanted.text, src) !== canon(check.text, tgt)) {
      statements.push(alter(`DROP CONSTRAINT ${quoteIdent(check.name, 'postgres')}`));
    }
  }
  if (a.notNull !== b.notNull) {
    statements.push(alter(b.notNull ? 'SET NOT NULL' : 'DROP NOT NULL'));
    if (b.notNull)
      warnings.push({ code: 'may-fail', message: 'SET NOT NULL fails if a column holds NULLs' });
  }
  let added = false;
  for (const check of b.checks) {
    const existing = targetChecks.get(check.name);
    if (existing !== undefined && canon(existing.text, tgt) === canon(check.text, src)) continue;
    statements.push(
      alter(
        `ADD CONSTRAINT ${quoteIdent(check.name, 'postgres')} CHECK ${wrapParens(check.text, 'postgres')}`,
      ),
    );
    added = true;
  }
  if (added)
    warnings.push({
      code: 'may-fail',
      message: 'Adding the check fails if existing values violate it',
    });
  return { statements, warnings, destructive: false };
}

function alterComposite(name: string, source: TypeDef, target: TypeDef): InPlaceChange | undefined {
  const a = parseComposite(target.definition);
  const b = parseComposite(source.definition);
  if (a === undefined || b === undefined) return undefined;
  const sourceByName = new Map(b.attributes.map((x) => [x.name, x]));
  const targetByName = new Map(a.attributes.map((x) => [x.name, x]));
  const same = (
    x: CompositeParts['attributes'][number],
    y: CompositeParts['attributes'][number],
  ): boolean =>
    canonicalType(x.type, 'postgres') === canonicalType(y.type, 'postgres') &&
    (x.collation ?? null) === (y.collation ?? null);
  for (const attribute of a.attributes) {
    const wanted = sourceByName.get(attribute.name);
    if (wanted !== undefined && !same(wanted, attribute)) return undefined;
  }
  // Kept attributes stay in place and new ones are appended, so the order must allow that.
  const result = [
    ...a.attributes.filter((x) => sourceByName.has(x.name)).map((x) => x.name),
    ...b.attributes.filter((x) => !targetByName.has(x.name)).map((x) => x.name),
  ];
  if (result.join('\u0000') !== b.attributes.map((x) => x.name).join('\u0000')) return undefined;
  const actions = [
    ...a.attributes
      .filter((x) => !sourceByName.has(x.name))
      .map((x) => `DROP ATTRIBUTE ${quoteIdent(x.name, 'postgres')}`),
    ...b.attributes
      .filter((x) => !targetByName.has(x.name))
      .map(
        (x) =>
          `ADD ATTRIBUTE ${quoteIdent(x.name, 'postgres')} ${x.type}${x.collation !== undefined ? ` COLLATE ${quoteIdent(x.collation, 'postgres')}` : ''}`,
      ),
  ];
  const dropped = a.attributes.filter((x) => !sourceByName.has(x.name)).map((x) => x.name);
  return {
    statements: actions.length > 0 ? [`ALTER TYPE ${name} ${actions.join(', ')}`] : [],
    warnings:
      dropped.length > 0
        ? [
            {
              code: 'data-loss',
              message: `Values of ${dropped.map((d) => quoteString(d, 'postgres')).join(', ')} are lost from every column of the type`,
            },
          ]
        : [],
    destructive: dropped.length > 0,
  };
}

/**
 * Whether a domain or composite type that columns use can be rebuilt (created anew, its columns
 * converted through their text form, the old type dropped), with the data risk of the
 * conversion. Composite types qualify only when the attributes keep their names and order, so
 * the text form still lines up.
 */
export function rebuildRisk(
  source: TypeDef,
  target: TypeDef,
): { readonly lossy: boolean; readonly messages: readonly string[] } | undefined {
  if (source.kind !== target.kind) return undefined;
  const risks: (TypeChangeRisk | null)[] = [];
  if (source.kind === 'domain') {
    const a = parseDomain(target.definition);
    const b = parseDomain(source.definition);
    if (a === undefined || b === undefined) return undefined;
    risks.push(
      typeChangeRisk(
        canonicalType(a.base, 'postgres'),
        canonicalType(b.base, 'postgres'),
        'postgres',
      ),
    );
  } else if (source.kind === 'composite') {
    const a = parseComposite(target.definition);
    const b = parseComposite(source.definition);
    if (a === undefined || b === undefined) return undefined;
    if (
      a.attributes.map((x) => x.name).join('\u0000') !==
      b.attributes.map((x) => x.name).join('\u0000')
    )
      return undefined;
    a.attributes.forEach((x, i) => {
      risks.push(
        typeChangeRisk(
          canonicalType(x.type, 'postgres'),
          canonicalType(b.attributes[i]!.type, 'postgres'),
          'postgres',
        ),
      );
    });
  } else {
    return undefined;
  }
  const present = risks.filter((r): r is TypeChangeRisk => r !== null);
  return { lossy: present.some((r) => r.lossy), messages: present.map((r) => r.message) };
}
