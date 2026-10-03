import type { SqlDialect } from '@querybara/core';

import type { StatementModel, RelationRef, Cte } from './analysis';
import type { Catalog, CatalogRelation } from './catalog';
import { CLAUSE_WORDS, VALUE_WORDS } from './keywords';
import { formatName, identOf, type Ident } from './names';

/**
 * Column resolution for table references in scope: catalog tables and views, CTEs (explicit
 * column lists or their select lists), subqueries (their select lists) and table functions with
 * column aliases. Select lists are resolved when they are plain: `*`, `t.*`, column references
 * and aliased expressions (PostgreSQL also names bare function calls after the function).
 */

export interface ResolvedColumn {
  readonly name: string;
  readonly dataType?: string;
  readonly comment?: string;
  /** Where the column comes from, for the item detail: `public.users`, `cte recent`... */
  readonly source?: string;
}

/** CTE and subquery nesting followed while resolving select lists. */
const MAX_DEPTH = 6;

/** Case-insensitive equality with the dialect's folding tried first. */
export function sameIdent(a: Ident, b: Ident, dialect: SqlDialect): boolean {
  if (dialect === 'postgres') {
    const fa = a.quoted ? a.name : a.name.toLowerCase();
    const fb = b.quoted ? b.name : b.name.toLowerCase();
    if (fa === fb) return true;
  } else if (a.name === b.name) {
    return true;
  }
  return a.name.toLowerCase() === b.name.toLowerCase();
}

/** The reference among `refs` a qualifier names: its alias, or its table name when it has none. */
export function findRef(
  refs: readonly RelationRef[],
  qualifier: Ident,
  dialect: SqlDialect,
): RelationRef | undefined {
  let loose: RelationRef | undefined;
  for (const ref of refs) {
    const name = ref.alias ?? ref.parts[ref.parts.length - 1];
    if (!name) continue;
    const exact =
      dialect === 'postgres'
        ? (name.quoted ? name.name : name.name.toLowerCase()) ===
          (qualifier.quoted ? qualifier.name : qualifier.name.toLowerCase())
        : name.name === qualifier.name;
    if (exact) return ref;
    if (!loose && name.name.toLowerCase() === qualifier.name.toLowerCase()) loose = ref;
  }
  return loose;
}

export class Resolver {
  private readonly cache = new Map<number, readonly ResolvedColumn[]>();

  constructor(
    readonly model: StatementModel,
    readonly catalog: Catalog,
    readonly dialect: SqlDialect,
  ) {}

  /** The name a reference is qualified with in SQL: its alias or its table name. */
  qualifierOf(ref: RelationRef): string | undefined {
    const name = ref.alias ?? ref.parts[ref.parts.length - 1];
    if (!name) return undefined;
    // An unquoted name is valid as written; a quoted one is re-quoted only when it must be.
    return name.quoted ? formatName(name.name, this.dialect) : name.name;
  }

  /** The CTE a one-part table name refers to, if one is visible there. */
  cteOf(ref: RelationRef): Cte | undefined {
    if (ref.kind !== 'table' || ref.parts.length !== 1) return undefined;
    const name = ref.parts[0]!;
    return this.model
      .ctesVisibleFrom(this.model.parentOf(ref.index))
      .find((cte) => sameIdent(cte.name, name, this.dialect));
  }

  /** The catalog table or view a reference names (not when a CTE shadows it). */
  relationOf(ref: RelationRef): CatalogRelation | undefined {
    if (ref.kind !== 'table' || this.cteOf(ref)) return undefined;
    return this.catalog.findRelation(ref.parts);
  }

  columnsOf(ref: RelationRef, depth = 0): readonly ResolvedColumn[] {
    const cached = this.cache.get(ref.index);
    if (cached) return cached;
    let columns: ResolvedColumn[] = [];
    if (depth <= MAX_DEPTH) {
      if (ref.kind === 'table') {
        const cte = this.cteOf(ref);
        if (cte) {
          columns = this.cteColumns(cte, depth);
        } else {
          const relation = this.catalog.findRelation(ref.parts);
          if (relation) columns = this.relationColumns(relation);
        }
      } else if (ref.kind === 'subquery') {
        if (ref.group !== undefined && this.model.isQuery(ref.group)) {
          columns = this.outputColumns(ref.group, depth + 1);
        }
      } else if (!ref.aliasColumns && ref.alias && this.dialect === 'postgres') {
        // A scalar table function yields one column named after its alias.
        columns = [{ name: ref.alias.name }];
      }
    }
    if (ref.aliasColumns) {
      const renamed: ResolvedColumn[] = ref.aliasColumns.map((name, index) => {
        const base = columns[index];
        return base ? { ...base, name } : { name };
      });
      columns = [...renamed, ...columns.slice(ref.aliasColumns.length)];
    }
    if (depth === 0) this.cache.set(ref.index, columns);
    return columns;
  }

  relationColumns(relation: CatalogRelation): ResolvedColumn[] {
    const source = `${relation.schema.name}.${relation.name}`;
    return relation.columns.map((column) => {
      const out: { name: string; dataType?: string; comment?: string; source: string } = {
        name: column.name,
        source,
      };
      if (column.dataType !== undefined) out.dataType = column.dataType;
      if (column.comment !== undefined) out.comment = column.comment;
      return out;
    });
  }

  private cteColumns(cte: Cte, depth: number): ResolvedColumn[] {
    const body =
      cte.body !== undefined && this.model.isQuery(cte.body)
        ? this.outputColumns(cte.body, depth + 1)
        : [];
    const source = `cte ${cte.name.name}`;
    if (!cte.columns) return body.map((column) => ({ ...column, source }));
    return cte.columns.map((name, index) => {
      const base = body[index];
      return base ? { ...base, name, source } : { name, source };
    });
  }

  /** The columns a query group exposes: its (first) select list, resolved where plain. */
  outputColumns(open: number, depth: number): ResolvedColumn[] {
    if (depth > MAX_DEPTH) return [];
    const model = this.model;
    const block = model.block(open);
    const segment = block.segments[0];
    if (!segment) return [];
    const select = segment.markers.find((marker) => marker.clause === 'select');
    if (!select) return [];
    const end = segment.markers.find((marker) => marker.token > select.token)?.token ?? Infinity;
    const list = segment.tokens.filter((i) => i >= select.body && i < end);
    let k = 0;
    const first = model.upper(list[0] ?? -1);
    if (first === 'DISTINCT' || first === 'ALL') {
      k = 1;
      if (model.upper(list[1] ?? -1) === 'ON') {
        k = 2;
        if (model.isPunct(list[2] ?? -1, '(')) k++;
        if (model.isPunct(list[k] ?? -1, ')')) k++;
      }
    }
    const items: number[][] = [[]];
    for (; k < list.length; k++) {
      const i = list[k]!;
      if (model.isPunct(i, ',')) items.push([]);
      else items[items.length - 1]!.push(i);
    }
    const out: ResolvedColumn[] = [];
    for (const item of items) out.push(...this.itemColumns(item, segment.refs, depth));
    return out;
  }

  private itemColumns(
    item: readonly number[],
    refs: readonly RelationRef[],
    depth: number,
  ): ResolvedColumn[] {
    const model = this.model;
    const toks = model.toks;
    if (item.length === 0) return [];
    const lastIndex = item[item.length - 1]!;
    const lastTok = toks[lastIndex]!;

    // `*` and `t.*`.
    if (lastTok.kind === 'operator' && lastTok.text === '*') {
      if (item.length === 1) {
        return refs
          .filter((ref) => ref.role !== 'target')
          .flatMap((ref) => this.columnsOfNested(ref, depth));
      }
      if (!model.isPunct(item[item.length - 2] ?? -1, '.')) return [];
      const parts = this.path(item.slice(0, -2));
      const qualifier = parts?.[parts.length - 1];
      const ref = qualifier ? findRef(refs, qualifier, this.dialect) : undefined;
      return ref ? [...this.columnsOfNested(ref, depth)] : [];
    }

    // `expr AS name` and `expr name`.
    const alias = identOf(lastTok);
    if (item.length >= 2 && alias && (alias.quoted || !CLAUSE_WORDS.has(lastTok.upper))) {
      const before = item[item.length - 2]!;
      const beforeTok = toks[before]!;
      const operandEnd =
        beforeTok.upper === 'AS' ||
        beforeTok.kind === 'quoted-identifier' ||
        beforeTok.kind === 'number' ||
        beforeTok.kind === 'string' ||
        (beforeTok.kind === 'punctuation' && beforeTok.text === ')') ||
        (beforeTok.kind === 'word' &&
          (VALUE_WORDS.has(beforeTok.upper) || !CLAUSE_WORDS.has(beforeTok.upper)));
      if (operandEnd) {
        const expression = beforeTok.upper === 'AS' ? item.slice(0, -2) : item.slice(0, -1);
        const typed = this.columnRef(expression, refs, depth);
        return [typed ? { ...typed, name: alias.name } : { name: alias.name }];
      }
    }

    const column = this.columnRef(item, refs, depth);
    if (column) return [column];
    if (this.dialect === 'postgres' && item.length >= 2 && model.isPunct(item[1]!, '(')) {
      const fn = identOf(toks[item[0]!]!);
      if (fn) return [{ name: fn.quoted ? fn.name : fn.name.toLowerCase() }];
    }
    return [];
  }

  private columnsOfNested(ref: RelationRef, depth: number): readonly ResolvedColumn[] {
    return depth === 0 ? this.columnsOf(ref) : this.columnsOf(ref, depth);
  }

  /** A plain column reference `[q.]name`, resolved against `refs` when possible. */
  private columnRef(
    item: readonly number[],
    refs: readonly RelationRef[],
    depth: number,
  ): ResolvedColumn | undefined {
    const parts = this.path(item);
    if (!parts) return undefined;
    const name = parts[parts.length - 1]!;
    if (parts.length === 1 && !name.quoted && CLAUSE_WORDS.has(name.name.toUpperCase())) {
      return undefined;
    }
    const candidates =
      parts.length >= 2
        ? [findRef(refs, parts[parts.length - 2]!, this.dialect)].filter(
            (ref): ref is RelationRef => ref !== undefined,
          )
        : refs;
    for (const ref of candidates) {
      const found = this.columnsOfNested(ref, depth).find((column) =>
        sameIdent({ name: column.name, quoted: true }, name, this.dialect),
      );
      if (found) return { ...found, name: name.name };
    }
    return { name: name.name };
  }

  /** `a.b.c` as identifiers, or undefined when the tokens are anything else. */
  private path(item: readonly number[]): Ident[] | undefined {
    const toks = this.model.toks;
    const parts: Ident[] = [];
    for (let k = 0; k < item.length; k++) {
      const tok = toks[item[k]!]!;
      if (k % 2 === 1) {
        if (tok.kind !== 'punctuation' || tok.text !== '.') return undefined;
        continue;
      }
      const ident = identOf(tok);
      if (!ident) return undefined;
      parts.push(ident);
    }
    return item.length % 2 === 1 ? parts : undefined;
  }
}
