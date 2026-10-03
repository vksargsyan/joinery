import type { SqlDialect } from '@querybara/core';

import { quoteIdent } from '../dialect';
import { locate, StatementModel, type RelationRef } from './analysis';
import type { Catalog, CatalogRelation, CatalogRoutine, CatalogSchema } from './catalog';
import { Classifier, type Plan } from './classify';
import { builtinFunctions, type FunctionInfo } from './functions';
import { keywordsFor, TYPES } from './keywords';
import { formatName } from './names';
import { routineSignature } from './routines';
import { Resolver } from './scope';

/**
 * Context-aware autocomplete (spec §6) for the editor's language worker: keywords, schemas,
 * tables, columns with alias resolution, join conditions from foreign keys, functions with
 * signatures and user snippets, for the statement at the cursor only. Synchronous, token-based
 * (no parser load) and tolerant of the incomplete SQL the user is typing.
 */

export type CompletionItemKind =
  | 'keyword'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'function'
  | 'alias'
  | 'join'
  | 'snippet'
  | 'sequence'
  | 'type';

export interface CompletionItem {
  /** What the list shows; for qualified columns `u.id`, for joins the whole condition. */
  readonly label: string;
  readonly kind: CompletionItemKind;
  /** Short right-hand text: column type, function signature, object kind. */
  readonly detail?: string;
  readonly documentation?: string;
  /** Replaces the range [from, to): quoted and qualified as needed. */
  readonly insertText: string;
  /** Orders the list: match quality, then kind for the position, then name. */
  readonly sortText: string;
  /** Text Monaco should filter on when it differs from the label (quoted identifiers). */
  readonly filterText?: string;
  /** insertText uses Monaco snippet syntax (`$0`, `${1:name}`). */
  readonly isSnippet?: boolean;
}

/** A user snippet from the snippet library: `body` uses `${1:placeholder}` syntax. */
export interface SqlSnippet {
  readonly prefix: string;
  readonly body: string;
  readonly description?: string;
}

export interface CompletionOptions {
  readonly snippets?: readonly SqlSnippet[];
  /** Case of inserted keywords and built-in function names (default upper). */
  readonly keywordCase?: 'upper' | 'lower';
  /** At most this many items, best first (default 1,000); `incomplete` tells when more matched. */
  readonly maxItems?: number;
}

export interface CompletionResult {
  readonly items: CompletionItem[];
  /** The range of the word being replaced; from <= offset <= to. */
  readonly from: number;
  readonly to: number;
  /**
   * The list is partial (capped at maxItems, or large catalogs held back until a prefix is
   * typed): ask again as the word grows (Monaco `incomplete`) instead of filtering locally.
   */
  readonly incomplete: boolean;
}

const DEFAULT_MAX_ITEMS = 1000;

/** Above this many relations outside the search path, they are offered only for a typed prefix. */
const OTHER_RELATIONS_LIMIT = 500;

/** Rank of each kind of item within a position; lower comes first. */
const RANK = {
  join: 5,
  cte: 8,
  column: 10,
  relation: 10,
  outerColumn: 12,
  userType: 12,
  alias: 20,
  schema: 25,
  qualifiedRelation: 30,
  sequence: 30,
  routine: 38,
  function: 40,
  keyword: 50,
  keywordOnly: 10,
  snippet: 60,
} as const;

interface Candidate {
  label: string;
  kind: CompletionItemKind;
  insertText: string;
  detail?: string;
  documentation?: string;
  filterText?: string;
  isSnippet?: boolean;
  rank: number;
  /** Secondary order within the rank (column position); undefined sorts by label. */
  order?: number;
  tier: number;
}

/** 0: prefix match in the same case, 1: prefix match ignoring case, 2: subsequence, -1: none. */
function matchTier(name: string, prefix: string): number {
  if (prefix.length === 0 || name.startsWith(prefix)) return 0;
  const lowerName = name.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerName.startsWith(lowerPrefix)) return 1;
  let j = 0;
  for (let i = 0; i < lowerName.length && j < lowerPrefix.length; i++) {
    if (lowerName.charCodeAt(i) === lowerPrefix.charCodeAt(j)) j++;
  }
  return j === lowerPrefix.length ? 2 : -1;
}

/** Escapes text for a Monaco snippet: `$`, `}` and `\` are literal. */
function escapeSnippet(text: string): string {
  return text.replace(/[$}\\]/g, (ch) => `\\${ch}`);
}

/**
 * Completions at `offset` in `text`. The desktop's Monaco provider calls this in the language
 * worker with the catalog built from the connection's cached snapshots, and maps `from`/`to` to
 * the replace range. Returns no items inside strings and comments.
 */
export function complete(
  text: string,
  offset: number,
  dialect: SqlDialect,
  catalog: Catalog,
  options: CompletionOptions = {},
): CompletionResult {
  const at = Math.max(0, Math.min(Number.isFinite(offset) ? Math.trunc(offset) : 0, text.length));
  const located = locate(text, at, dialect);
  if (!located) return { items: [], from: at, to: at, incomplete: false };
  const model = new StatementModel(located);
  const resolver = new Resolver(model, catalog, dialect);
  const plan = new Classifier(model, resolver, catalog, dialect, located.inBody).classify();
  const builder = new ItemBuilder(
    dialect,
    catalog,
    resolver,
    located.prefix,
    located.quote,
    options,
    parenthesisAt(text, located.to),
  );
  builder.add(plan);
  const { items, incomplete } = builder.finish(options.maxItems ?? DEFAULT_MAX_ITEMS);
  return { items, from: located.from, to: located.to, incomplete };
}

/** True when the next non-blank character from `offset` is `(`: a call's parentheses exist. */
function parenthesisAt(text: string, offset: number): boolean {
  for (let i = offset; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 32 || ch === 9) continue;
    return ch === 40;
  }
  return false;
}

class ItemBuilder {
  private readonly candidates: Candidate[] = [];
  private readonly seen = new Set<string>();
  /** Some candidates were left out that a longer word could match. */
  private partial = false;
  private readonly upper: boolean;

  constructor(
    private readonly dialect: SqlDialect,
    private readonly catalog: Catalog,
    private readonly resolver: Resolver,
    private readonly prefix: string,
    private readonly quote: string | undefined,
    private readonly options: CompletionOptions,
    /** `(` already follows the word: functions insert their name only. */
    private readonly hasParenthesis: boolean,
  ) {
    this.upper = options.keywordCase !== 'lower';
  }

  /** A call as a snippet with the cursor inside the parentheses, or the bare name. */
  private call(name: string, takesArgs: boolean): { insertText: string; isSnippet?: true } {
    if (this.hasParenthesis) return { insertText: name };
    return { insertText: `${escapeSnippet(name)}(${takesArgs ? '$0' : ''})`, isSnippet: true };
  }

  /** An identifier as inserted: quoted when needed, always when the user opened a quote. */
  private name(name: string): string {
    return this.quote !== undefined
      ? quoteIdent(name, this.dialect)
      : formatName(name, this.dialect);
  }

  private push(
    candidate: Omit<Candidate, 'tier'>,
    names: readonly string[] = [candidate.label],
  ): void {
    let tier = -1;
    for (const name of names) {
      const t = matchTier(name, this.prefix);
      if (t >= 0 && (tier < 0 || t < tier)) tier = t;
    }
    if (tier < 0) return;
    const key = `${candidate.kind}\u0000${candidate.insertText}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const full: Candidate = { ...candidate, tier };
    if (this.quote !== undefined && candidate.kind !== 'keyword' && candidate.kind !== 'snippet') {
      full.filterText = candidate.insertText;
    }
    this.candidates.push(full);
  }

  add(plan: Plan): void {
    if (plan.joins) this.joins(plan.joins);
    if (plan.columnSets) this.columns(plan);
    if (plan.ctes) {
      for (const cte of plan.ctes) {
        this.push({
          label: cte.name.name,
          kind: 'table',
          insertText: this.name(cte.name.name),
          detail: 'CTE',
          rank: RANK.cte,
        });
      }
    }
    if (plan.relations) this.relations(plan.relations.kinds, plan.relations.schema);
    if (plan.schemas) this.schemas();
    if (plan.aliases) this.aliases(plan.aliases);
    if (plan.types) this.types(plan.types.builtin, plan.types.schema);
    if (plan.sequences) this.sequences(plan.sequences.schema);
    if (plan.routines) {
      this.routines(plan.routines.kind, plan.routines.schema, plan.type === 'expression');
    }
    if (plan.functions) this.functions();
    const keywordRank = plan.type === 'other' && !plan.columnSets ? RANK.keywordOnly : RANK.keyword;
    for (const keyword of plan.keywords) {
      const label = this.upper || !/[A-Z]/.test(keyword) ? keyword : keyword.toLowerCase();
      this.push({ label, kind: 'keyword', insertText: label, rank: keywordRank });
    }
    if (plan.snippets) {
      for (const snippet of this.options.snippets ?? []) {
        this.push({
          label: snippet.prefix,
          kind: 'snippet',
          insertText: snippet.body,
          detail: snippet.description ?? 'Snippet',
          documentation: snippet.body,
          isSnippet: true,
          rank: RANK.snippet,
        });
      }
    }
  }

  finish(max: number): { items: CompletionItem[]; incomplete: boolean } {
    const items = this.candidates.map((candidate) => {
      const key =
        candidate.order === undefined
          ? candidate.label.toLowerCase()
          : String(candidate.order).padStart(6, '0');
      const item: {
        label: string;
        kind: CompletionItemKind;
        insertText: string;
        sortText: string;
        detail?: string;
        documentation?: string;
        filterText?: string;
        isSnippet?: boolean;
      } = {
        label: candidate.label,
        kind: candidate.kind,
        insertText: candidate.insertText,
        sortText: `${candidate.tier}${String(candidate.rank).padStart(2, '0')}${key}`,
      };
      if (candidate.detail !== undefined) item.detail = candidate.detail;
      if (candidate.documentation !== undefined) item.documentation = candidate.documentation;
      if (candidate.filterText !== undefined) item.filterText = candidate.filterText;
      if (candidate.isSnippet) item.isSnippet = true;
      return item;
    });
    items.sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : 0));
    const limit = Math.max(0, Math.floor(max));
    if (items.length <= limit) return { items, incomplete: this.partial };
    return { items: items.slice(0, limit), incomplete: true };
  }

  // --- Item kinds ----------------------------------------------------------------------------

  private columns(plan: Plan): void {
    const sets = plan.columnSets ?? [];
    const counts = new Map<string, number>();
    if (!plan.noQualify) {
      for (const set of sets) {
        const names = new Set(set.columns.map((column) => column.name.toLowerCase()));
        for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    sets.forEach((set, setIndex) => {
      set.columns.forEach((column, index) => {
        const lower = column.name.toLowerCase();
        if (plan.exclude?.has(lower)) return;
        const name = this.name(column.name);
        const ambiguous = (counts.get(lower) ?? 0) > 1 && set.qualifier !== undefined;
        const label = ambiguous ? `${set.qualifier}.${column.name}` : column.name;
        const insertText = ambiguous ? `${set.qualifier}.${name}` : name;
        const candidate: Omit<Candidate, 'tier'> = {
          label,
          kind: 'column',
          insertText,
          rank: RANK.column,
          order: setIndex * 10_000 + index,
        };
        const detail = column.dataType ?? column.source;
        if (detail !== undefined) candidate.detail = detail;
        const doc = [column.source, column.comment]
          .filter((part) => part !== undefined)
          .join(' — ');
        if (doc.length > 0) candidate.documentation = doc;
        this.push(candidate, ambiguous ? [column.name, label] : [column.name]);
      });
    });
  }

  private relationItem(relation: CatalogRelation, qualified: boolean): void {
    const view = relation.kind !== 'table';
    const insertText = qualified
      ? `${formatName(relation.schema.name, this.dialect)}.${this.name(relation.name)}`
      : this.name(relation.name);
    const label = qualified ? `${relation.schema.name}.${relation.name}` : relation.name;
    const kindName = relation.kind === 'materialized-view' ? 'materialized view' : relation.kind;
    const candidate: Omit<Candidate, 'tier'> = {
      label,
      kind: view ? 'view' : 'table',
      insertText,
      detail: `${kindName} · ${relation.schema.name}`,
      rank: qualified ? RANK.qualifiedRelation : RANK.relation,
    };
    if (relation.comment) candidate.documentation = relation.comment;
    this.push(candidate, qualified ? [relation.name, label] : [relation.name]);
  }

  private relations(
    kinds: ReadonlySet<string> | undefined,
    schema: CatalogSchema | undefined,
  ): void {
    const accept = (relation: CatalogRelation): boolean => !kinds || kinds.has(relation.kind);
    const prefix = this.prefix;
    // Cheap pre-filter before building items: 10,000 relations per keystroke.
    const matches = (relation: CatalogRelation): boolean =>
      prefix.length === 0 || matchTier(relation.name, prefix) >= 0;
    if (schema) {
      for (const relation of schema.relations) {
        if (accept(relation) && matches(relation)) this.relationItem(relation, false);
      }
      return;
    }
    const catalog = this.catalog;
    const path = new Set(catalog.searchPath);
    for (const pathSchema of catalog.searchPath) {
      for (const relation of pathSchema.relations) {
        if (accept(relation) && matches(relation)) {
          this.relationItem(relation, !catalog.isVisible(relation));
        }
      }
    }
    // Relations of other schemas (databases), qualified. When there are many (a server with many
    // large databases) they come only once a prefix is typed, and only for prefix matches; the
    // result is then partial, so the editor asks again as the word grows.
    const others = catalog.schemas().filter((other) => !path.has(other));
    let total = 0;
    for (const other of others) total += other.relations.length;
    const all = total <= OTHER_RELATIONS_LIMIT;
    if (!all) {
      this.partial = true;
      if (prefix.length === 0) return;
    }
    for (const other of others) {
      for (const relation of other.relations) {
        if (!accept(relation)) continue;
        const byName = matchTier(relation.name, prefix);
        const byPath = matchTier(`${other.name}.${relation.name}`, prefix);
        const best = byName < 0 ? byPath : byPath < 0 ? byName : Math.min(byName, byPath);
        if (best >= 0 && (all || best <= 1)) this.relationItem(relation, true);
      }
    }
  }

  private schemas(): void {
    const kind = this.dialect === 'postgres' ? 'schema' : 'database';
    for (const schema of this.catalog.schemas()) {
      const candidate: Omit<Candidate, 'tier'> = {
        label: schema.name,
        kind,
        insertText: this.name(schema.name),
        detail: kind,
        rank: RANK.schema,
      };
      if (schema.comment) candidate.documentation = schema.comment;
      this.push(candidate);
    }
  }

  private aliases(refs: readonly RelationRef[]): void {
    for (const ref of refs) {
      const qualifier = this.resolver.qualifierOf(ref);
      if (qualifier === undefined) continue;
      const target = ref.parts.map((part) => part.name).join('.');
      const label = (ref.alias ?? ref.parts[ref.parts.length - 1])!.name;
      this.push({
        label,
        kind: ref.alias ? 'alias' : 'table',
        insertText: qualifier,
        detail: ref.alias ? (ref.kind === 'subquery' ? 'subquery' : target) : 'table in FROM',
        rank: RANK.alias,
      });
    }
  }

  private joins(joins: NonNullable<Plan['joins']>): void {
    const resolver = this.resolver;
    const catalog = this.catalog;
    const joined = resolver.relationOf(joins.ref);
    const newQualifier = resolver.qualifierOf(joins.ref);
    if (!joined || newQualifier === undefined) return;
    const column = (name: string): string => formatName(name, this.dialect);
    let order = 0;
    const earlier = [...joins.earlier].reverse();
    for (const ref of earlier) {
      const other = resolver.relationOf(ref);
      const otherQualifier = resolver.qualifierOf(ref);
      if (!other || otherQualifier === undefined) continue;
      const conditions: { text: string; fk: string; describe: string }[] = [];
      for (const fk of catalog.foreignKeysFrom(joined)) {
        if (fk.to !== other) continue;
        conditions.push({
          text: fk.columns
            .map(
              (c, i) =>
                `${newQualifier}.${column(c)} = ${otherQualifier}.${column(fk.refColumns[i] ?? c)}`,
            )
            .join(' AND '),
          fk: fk.name,
          describe: `${joined.name}(${fk.columns.join(', ')}) → ${other.name}(${fk.refColumns.join(', ')})`,
        });
      }
      for (const fk of catalog.foreignKeysFrom(other)) {
        if (fk.to !== joined) continue;
        conditions.push({
          text: fk.refColumns
            .map(
              (c, i) =>
                `${newQualifier}.${column(c)} = ${otherQualifier}.${column(fk.columns[i] ?? c)}`,
            )
            .join(' AND '),
          fk: fk.name,
          describe: `${other.name}(${fk.columns.join(', ')}) → ${joined.name}(${fk.refColumns.join(', ')})`,
        });
      }
      for (const condition of conditions) {
        const on = this.upper ? 'ON' : 'on';
        const text = joins.withOn ? `${on} ${condition.text}` : condition.text;
        this.push({
          label: text,
          kind: 'join',
          insertText: text,
          detail: `foreign key ${condition.fk}`,
          documentation: condition.describe,
          rank: RANK.join,
          order: order++,
        });
      }
    }
  }

  private types(builtin: boolean, schema: CatalogSchema | undefined): void {
    if (builtin) {
      for (const name of keywordsFor(this.dialect, TYPES)) {
        // PostgreSQL type names are conventionally lower case; MySQL's follow keywordCase.
        const type = this.upper || this.dialect === 'postgres' ? name : name.toLowerCase();
        this.push({
          label: type,
          kind: 'type',
          insertText: type,
          detail: 'type',
          rank: RANK.column,
        });
      }
    }
    const schemas = schema ? [schema] : this.catalog.searchPath;
    for (const owner of schemas) {
      for (const type of owner.types) {
        this.push({
          label: type.name,
          kind: 'type',
          insertText: this.name(type.name),
          detail: `${type.kind} · ${owner.name}`,
          rank: RANK.userType,
        });
      }
    }
  }

  private sequences(schema: CatalogSchema | undefined): void {
    const schemas = schema ? [schema] : this.catalog.searchPath;
    for (const owner of schemas) {
      for (const sequence of owner.sequences) {
        this.push({
          label: sequence.name,
          kind: 'sequence',
          insertText: this.name(sequence.name),
          detail: `sequence · ${owner.name}`,
          rank: RANK.sequence,
        });
      }
    }
  }

  private routineItem(routine: CatalogRoutine, call: boolean, qualified: boolean): void {
    const signature = routineSignature(routine, this.dialect);
    const name = this.name(routine.name);
    const qualifiedName = qualified
      ? `${formatName(routine.schema.name, this.dialect)}.${name}`
      : name;
    const insert = call
      ? this.call(qualifiedName, signature.parameters.length > 0)
      : { insertText: qualifiedName };
    const candidate: Omit<Candidate, 'tier'> = {
      label: qualified ? `${routine.schema.name}.${routine.name}` : routine.name,
      kind: 'function',
      ...insert,
      detail: signature.label,
      rank: RANK.routine,
    };
    if (signature.documentation) candidate.documentation = signature.documentation;
    this.push(candidate, [routine.name]);
  }

  private routines(
    kind: 'function' | 'procedure' | 'any',
    schema: CatalogSchema | undefined,
    call: boolean,
  ): void {
    const accept = (routine: CatalogRoutine): boolean =>
      kind === 'any' ||
      (kind === 'procedure' ? routine.def.kind === 'procedure' : routine.def.kind !== 'procedure');
    if (schema) {
      for (const routine of schema.routines)
        if (accept(routine)) this.routineItem(routine, call, false);
      return;
    }
    const path = new Set(this.catalog.searchPath);
    for (const owner of this.catalog.searchPath) {
      for (const routine of owner.routines)
        if (accept(routine)) this.routineItem(routine, call, false);
    }
    for (const owner of this.catalog.schemas()) {
      if (path.has(owner)) continue;
      for (const routine of owner.routines)
        if (accept(routine)) this.routineItem(routine, call, true);
    }
  }

  private functions(): void {
    for (const info of builtinFunctions(this.dialect).values()) this.functionItem(info);
    for (const owner of this.catalog.searchPath) {
      for (const routine of owner.routines) {
        if (routine.def.kind !== 'procedure') this.routineItem(routine, true, false);
      }
    }
  }

  private functionItem(info: FunctionInfo): void {
    const name = this.upper ? info.name.toUpperCase() : info.name;
    const first = info.signatures[0]!;
    const takesArgs = info.signatures.some((signature) => signature.maxArgs > 0);
    const overloads =
      info.signatures.length > 1 ? ` (+${info.signatures.length - 1} overloads)` : '';
    this.push({
      label: name,
      kind: 'function',
      ...this.call(name, takesArgs),
      detail: `${first.label}${overloads}`,
      documentation: info.description,
      rank: RANK.function,
    });
  }
}
