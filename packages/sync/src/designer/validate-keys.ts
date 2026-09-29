import { atLeast } from '@joinery/core';
import type { ColumnDef, ForeignKeyDef, TableDef } from '@joinery/core';

import { canonicalCharset, canonicalCollation } from '../normalize';
import { canonicalType, isMysqlTextType } from '../types';
import { parseType } from './catalog';
import type { TypeCatalogEntry } from './catalog';
import { referencedTable } from './prepare';
import type { Prepared } from './prepare';
import {
  BLOB_LIKE,
  columnNamed,
  duplicates,
  expressionProblem,
  MYSQL_INDEX_METHODS,
  PG_INDEX_METHODS,
} from './validate-shared';
import type { Issues, Severity, Typed } from './validate-shared';

/** Key rules: primary key, unique constraints, indexes and foreign keys. */
// ---------------------------------------------------------------------------------------------
// Keys and indexes

/** A key's column list: not empty, known columns, no repeats. */
export function keyColumns(
  p: Prepared,
  issues: Issues,
  path: string,
  columns: readonly string[],
  what: string,
): void {
  if (columns.length === 0)
    issues.add(path, 'key-columns', `The ${what} needs at least one column`);
  columns.forEach((c, k) => {
    if (columnNamed(p, p.edited, c) === undefined)
      issues.add(`${path}[${k}]`, 'unknown-column', `The ${what} uses unknown column ${c}`);
  });
  for (const [k] of duplicates(columns, (c) => (p.pg ? c : c.toLowerCase()))) {
    issues.add(`${path}[${k}]`, 'duplicate-column', `Column ${columns[k]!} is listed twice`);
  }
}

/** Primary key, unique constraint and index rules. */
export function validateKeys(p: Prepared, issues: Issues, types: Map<number, Typed>): void {
  const t = p.edited;
  if (t.primaryKey !== undefined)
    keyColumns(p, issues, 'primaryKey.columns', t.primaryKey.columns, 'primary key');
  t.uniques.forEach((u, i) =>
    keyColumns(p, issues, `uniques[${i}].columns`, u.columns, 'unique constraint'),
  );
  const entryOf = (name: string | null): TypeCatalogEntry | undefined => {
    const column = columnNamed(p, t, name);
    return column === undefined ? undefined : types.get(t.columns.indexOf(column))?.entry;
  };
  const shapes: { path: string; shape: string }[] = [];
  if (t.primaryKey !== undefined)
    shapes.push({ path: 'primaryKey', shape: JSON.stringify(t.primaryKey.columns) });
  t.indexes.forEach((index, i) => {
    const path = `indexes[${i}]`;
    const method = index.method?.toLowerCase();
    const methods = p.pg ? PG_INDEX_METHODS : MYSQL_INDEX_METHODS;
    if (method !== undefined && !methods.includes(method)) {
      issues.add(
        `${path}.method`,
        'index-method',
        `Unknown index method ${index.method!}`,
        p.pg ? 'warning' : 'error',
      );
    }
    if (p.pg && index.unique && method !== undefined && method !== 'btree')
      issues.add(`${path}.method`, 'unique-method', 'Only btree indexes can be unique');
    if (!p.pg && index.unique && (method === 'fulltext' || method === 'spatial'))
      issues.add(
        `${path}.unique`,
        'unique-method',
        `${method.toUpperCase()} indexes cannot be unique`,
      );
    if (index.columns.length === 0)
      issues.add(`${path}.columns`, 'key-columns', 'The index needs at least one column');
    if (index.where !== undefined) {
      if (!p.pg)
        issues.add(
          `${path}.where`,
          'partial-index-unsupported',
          'Partial indexes are PostgreSQL-only',
        );
      else {
        const problem = expressionProblem(index.where, p);
        if (problem !== undefined)
          issues.add(`${path}.where`, 'expression-syntax', `The predicate has an ${problem}`);
      }
    }
    if (index.include.length > 0) {
      if (!p.pg)
        issues.add(`${path}.include`, 'include-unsupported', 'INCLUDE columns are PostgreSQL-only');
      else if (p.version !== undefined && !atLeast(p.version, '11'))
        issues.add(`${path}.include`, 'include-unsupported', 'INCLUDE needs PostgreSQL 11');
      index.include.forEach((c, k) => {
        if (columnNamed(p, t, c) === undefined)
          issues.add(`${path}.include[${k}]`, 'unknown-column', `INCLUDE uses unknown column ${c}`);
      });
    }
    if (index.invisible) {
      if (p.pg)
        issues.add(
          `${path}.invisible`,
          'invisible-unsupported',
          'PostgreSQL indexes cannot be invisible',
        );
      else if (p.dialect === 'mysql' && p.version !== undefined && !atLeast(p.version, '8.0'))
        issues.add(
          `${path}.invisible`,
          'invisible-unsupported',
          'Invisible indexes need MySQL 8.0',
        );
      else if (p.dialect === 'mariadb' && p.version !== undefined && !atLeast(p.version, '10.6'))
        issues.add(
          `${path}.invisible`,
          'invisible-unsupported',
          'Ignored indexes need MariaDB 10.6',
        );
    }
    if (!p.pg && index.comment !== undefined && [...index.comment].length > 1024)
      issues.add(
        `${path}.comment`,
        'comment-too-long',
        'Index comments are limited to 1,024 characters',
      );
    index.columns.forEach((part, k) => {
      const at = `${path}.columns[${k}]`;
      if (part.name === null) {
        if ((part.expression ?? '').trim() === '') {
          issues.add(
            at,
            'index-expression',
            'The index part has neither a column nor an expression',
          );
          return;
        }
        const problem = expressionProblem(part.expression!, p);
        if (problem !== undefined)
          issues.add(at, 'expression-syntax', `The expression has an ${problem}`);
        if (p.dialect === 'mariadb')
          issues.add(
            at,
            'expression-index-unsupported',
            'MariaDB has no functional indexes; index a generated column',
          );
        if (p.dialect === 'mysql' && p.version !== undefined && !atLeast(p.version, '8.0.13'))
          issues.add(at, 'expression-index-unsupported', 'Functional indexes need MySQL 8.0.13');
        if (!p.pg && (method === 'fulltext' || method === 'spatial'))
          issues.add(
            at,
            'expression-index-unsupported',
            `${method.toUpperCase()} indexes cannot use expressions`,
          );
        return;
      }
      const column = columnNamed(p, t, part.name);
      if (column === undefined) {
        issues.add(at, 'unknown-column', `The index uses unknown column ${part.name}`);
        return;
      }
      if (p.pg) {
        if (part.length !== undefined)
          issues.add(at, 'prefix-unsupported', 'PostgreSQL indexes have no prefix length');
        return;
      }
      if (part.opclass !== undefined || part.nulls !== undefined)
        issues.add(
          at,
          'index-option-unsupported',
          'Operator classes and NULLS FIRST/LAST are PostgreSQL-only',
        );
      const entry = entryOf(part.name);
      if (entry === undefined) return;
      const stringish = entry.category === 'text' || entry.category === 'binary';
      const parsed = parseType(column.dataType, p.engine);
      if (method === 'fulltext') {
        if (!['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext'].includes(entry.name))
          issues.add(at, 'fulltext-type', 'FULLTEXT indexes only cover text columns');
        if (part.length !== undefined)
          issues.add(at, 'prefix-unsupported', 'FULLTEXT indexes take no prefix length');
        return;
      }
      if (method === 'spatial') {
        if (entry.category !== 'spatial')
          issues.add(at, 'spatial-type', 'SPATIAL indexes only cover geometry columns');
        if (column.nullable)
          issues.add(at, 'spatial-nullable', 'SPATIAL index columns must be NOT NULL');
        return;
      }
      if (entry.category === 'json')
        issues.add(
          at,
          'index-json',
          'JSON columns cannot be indexed directly; index an expression or a generated column',
        );
      if (part.length !== undefined) {
        if (!stringish || entry.name === 'enum' || entry.name === 'set')
          issues.add(
            at,
            'prefix-type',
            `A prefix length only applies to string and binary columns, not ${entry.name}`,
          );
        else if (
          parsed?.length !== undefined &&
          !BLOB_LIKE.has(entry.name) &&
          part.length > parsed.length
        )
          issues.add(
            at,
            'prefix-range',
            `The prefix (${part.length}) is longer than the column (${parsed.length})`,
          );
      } else if (BLOB_LIKE.has(entry.name) && entry.category !== 'spatial') {
        issues.add(
          at,
          'prefix-required',
          `Indexing a ${entry.name.toUpperCase()} column needs a prefix length`,
        );
      }
    });
    for (const [k] of duplicates(index.columns, (c) =>
      c.name !== null ? (p.pg ? c.name : c.name.toLowerCase()) : '',
    )) {
      issues.add(
        `${path}.columns[${k}]`,
        'duplicate-column',
        `Column ${index.columns[k]!.name!} is listed twice`,
      );
    }
    const shape = JSON.stringify(index.columns.map((c) => c.name));
    if (
      index.where === undefined &&
      index.columns.every((c) => c.name !== null && c.length === undefined && c.order !== 'desc')
    ) {
      const same = shapes.find((s) => s.shape === shape);
      if (same !== undefined && (method ?? 'btree') === 'btree')
        issues.add(path, 'redundant-index', `The index duplicates ${same.path}`, 'warning');
      shapes.push({ path, shape });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Foreign keys

function typeFamily(canonical: string): string {
  if (/^(tinyint|smallint|mediumint|int|integer|bigint)\b/.test(canonical)) return 'int';
  if (/^(decimal|numeric)\b/.test(canonical)) return 'decimal';
  if (/^(float|double|real)\b/.test(canonical)) return 'float';
  if (/^(char|varchar|character|text|tinytext|mediumtext|longtext|citext)\b/.test(canonical))
    return 'string';
  if (/^(binary|varbinary|bytea|tinyblob|blob|mediumblob|longblob)\b/.test(canonical))
    return 'binary';
  if (/^(timestamp|datetime)\b/.test(canonical)) return 'timestamp';
  return canonical.replace(/\(.*$/, '');
}

function mysqlIntKey(canonical: string): string {
  const m = /^(tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?( unsigned)?/.exec(canonical);
  return m ? `${m[1]!}${m[2] ?? ''}` : canonical;
}

/** Whether a foreign key column and the column it references can be paired. */
export function fkTypeProblem(
  p: Prepared,
  child: ColumnDef,
  childTable: TableDef,
  parent: ColumnDef,
  parentTable: TableDef,
): { message: string; severity: Severity } | undefined {
  const a = canonicalType(child.dataType, p.dialect);
  const b = canonicalType(parent.dataType, p.dialect);
  if (a === b) {
    if (p.pg || !isMysqlTextType(a)) return undefined;
  }
  const fa = typeFamily(a);
  const fb = typeFamily(b);
  if (fa !== fb) {
    return {
      message: `${child.name} (${child.dataType}) cannot reference ${parent.name} (${parent.dataType})`,
      severity: 'error',
    };
  }
  if (p.pg) {
    return a === b
      ? undefined
      : {
          message: `${child.name} is ${child.dataType} but ${parent.name} is ${parent.dataType}; matching types avoid casts in joins`,
          severity: 'warning',
        };
  }
  if (fa === 'int' && mysqlIntKey(a) !== mysqlIntKey(b))
    return {
      message: `MySQL needs the same integer size and sign: ${a} vs ${b}`,
      severity: 'error',
    };
  if (fa === 'decimal' && a !== b)
    return { message: `MySQL needs the same precision and scale: ${a} vs ${b}`, severity: 'error' };
  if (fa === 'string') {
    const charset = (c: ColumnDef, t: TableDef): string | undefined =>
      canonicalCharset(c.charset ?? c.collation?.split('_')[0] ?? t.options.charset);
    const collation = (c: ColumnDef, t: TableDef): string | undefined =>
      canonicalCollation(
        c.collation ?? (c.charset === undefined ? t.options.collation : undefined),
      );
    const ca = charset(child, childTable);
    const cb = charset(parent, parentTable);
    if (ca !== undefined && cb !== undefined && ca !== cb)
      return { message: `MySQL needs the same character set: ${ca} vs ${cb}`, severity: 'error' };
    const la = collation(child, childTable);
    const lb = collation(parent, parentTable);
    if (la !== undefined && lb !== undefined && la !== lb)
      return { message: `MySQL needs the same collation: ${la} vs ${lb}`, severity: 'error' };
  }
  return undefined;
}

/** Unique keys of a table as column lists: primary key, unique constraints, unique indexes. */
function uniqueKeys(table: TableDef, pg: boolean): string[][] {
  return [
    ...(table.primaryKey !== undefined ? [table.primaryKey.columns] : []),
    ...table.uniques.map((u) => u.columns),
    ...table.indexes
      .filter(
        (i) =>
          i.unique &&
          (!pg || i.where === undefined) &&
          i.columns.every((c) => c.name !== null && c.length === undefined),
      )
      .map((i) => i.columns.map((c) => c.name!)),
  ];
}

/**
 * Whether `refColumns` of `refTable` can be referenced: PostgreSQL and MySQL 8.4 need a primary
 * or unique key on exactly those columns; older MySQL and MariaDB an index starting with them.
 */
export function keyProblem(
  p: Prepared,
  refTable: TableDef,
  refColumns: readonly string[],
): { message: string; severity: Severity } | undefined {
  const fold = (c: string): string => (p.pg ? c : c.toLowerCase());
  const wanted = [...refColumns].map(fold).sort().join(',');
  const unique = uniqueKeys(refTable, p.pg).some(
    (k) => [...k].map(fold).sort().join(',') === wanted,
  );
  if (unique) return undefined;
  if (p.pg || (p.dialect === 'mysql' && (p.version === undefined || atLeast(p.version, '8.4')))) {
    return {
      message: `${refTable.name} has no primary key or unique key on (${refColumns.join(', ')})`,
      severity: 'error',
    };
  }
  const leading = [
    ...(refTable.primaryKey !== undefined ? [refTable.primaryKey.columns] : []),
    ...refTable.indexes.map((i) => i.columns.map((c) => c.name ?? '')),
  ].some((cols) => refColumns.every((c, k) => cols[k] !== undefined && fold(cols[k]!) === fold(c)));
  return leading
    ? {
        message: `(${refColumns.join(', ')}) of ${refTable.name} is not unique: references to it are ambiguous`,
        severity: 'warning',
      }
    : {
        message: `${refTable.name} has no index starting with (${refColumns.join(', ')})`,
        severity: 'error',
      };
}

/**
 * MySQL: the index a kept foreign key relies on cannot be dropped ("needed in a foreign key
 * constraint"). The index MySQL itself added, named after the key, is kept automatically.
 */
function backingIndexDropped(p: Prepared, issues: Issues, fk: ForeignKeyDef, path: string): void {
  const live = p.live;
  if (p.pg || live === null) return;
  const leading = (columns: readonly (string | null)[]): boolean =>
    fk.columns.every(
      (c, k) => columns[k] !== undefined && columns[k]?.toLowerCase() === c.toLowerCase(),
    );
  const edited = p.edited;
  const covered =
    (edited.primaryKey !== undefined && leading(edited.primaryKey.columns)) ||
    edited.uniques.some((u) => leading(u.columns)) ||
    edited.indexes.some((i) => leading(i.columns.map((c) => c.name)));
  if (covered) return;
  const gone = live.indexes.find(
    (i) => i.name !== fk.name && leading(i.columns.map((c) => c.name)),
  );
  if (gone !== undefined && live.foreignKeys.some((f) => f.name === fk.name)) {
    issues.add(
      path,
      'index-backs-foreign-key',
      `Foreign key ${fk.name} needs index ${gone.name} (or another index starting with its columns)`,
    );
  }
}

/** Foreign key rules, against the referenced table in the snapshot. */
export function validateForeignKeys(p: Prepared, issues: Issues): void {
  const t = p.table;
  p.edited.foreignKeys.forEach((original, i) => {
    const fk = t.foreignKeys[i] ?? original;
    const path = `foreignKeys[${i}]`;
    keyColumns(p, issues, `${path}.columns`, original.columns, 'foreign key');
    backingIndexDropped(p, issues, fk, path);
    if (fk.refTable.trim() === '') {
      issues.add(`${path}.refTable`, 'fk-table-required', 'Pick the referenced table');
      return;
    }
    if (fk.refColumns.length !== fk.columns.length) {
      issues.add(
        `${path}.refColumns`,
        'fk-column-count',
        `${fk.columns.length} column(s) cannot reference ${fk.refColumns.length}`,
      );
    }
    if (fk.match === 'PARTIAL')
      issues.add(
        `${path}.match`,
        'fk-match',
        'MATCH PARTIAL is not implemented by any supported engine',
      );
    if (!p.pg && (fk.onDelete === 'SET DEFAULT' || fk.onUpdate === 'SET DEFAULT'))
      issues.add(
        `${path}.onDelete`,
        'fk-action-unsupported',
        'InnoDB does not support SET DEFAULT',
      );
    fk.columns.forEach((c) => {
      const column = columnNamed(p, t, c);
      if (
        column !== undefined &&
        !column.nullable &&
        (fk.onDelete === 'SET NULL' || fk.onUpdate === 'SET NULL')
      )
        issues.add(`${path}.onDelete`, 'fk-set-null', `SET NULL needs ${c} to allow NULL`);
    });
    if (!p.pg && t.partitioning !== undefined)
      issues.add(path, 'fk-partitioned', 'Partitioned InnoDB tables cannot have foreign keys');
    if (!p.pg && t.options.engine !== undefined && t.options.engine.toLowerCase() !== 'innodb')
      issues.add(
        path,
        'fk-engine',
        `${t.options.engine} ignores foreign keys; use InnoDB`,
        'warning',
      );
    const refTable = referencedTable(p, fk);
    if (refTable === undefined) {
      if (p.snapshot !== undefined)
        issues.add(
          `${path}.refTable`,
          'fk-unknown-table',
          `Table ${fk.refSchema !== undefined ? `${fk.refSchema}.` : ''}${fk.refTable} does not exist`,
        );
      return;
    }
    let complete = true;
    fk.refColumns.forEach((c, k) => {
      const parent = columnNamed(p, refTable, c);
      if (parent === undefined) {
        complete = false;
        issues.add(
          `${path}.refColumns[${k}]`,
          'unknown-column',
          `${refTable.name} has no column ${c}`,
        );
        return;
      }
      const child = columnNamed(p, t, fk.columns[k] ?? null);
      if (child === undefined) return;
      const problem = fkTypeProblem(p, child, t, parent, refTable);
      if (problem !== undefined)
        issues.add(`${path}.columns[${k}]`, 'fk-type-mismatch', problem.message, problem.severity);
    });
    if (complete && fk.refColumns.length > 0) {
      const problem = keyProblem(p, refTable, fk.refColumns);
      if (problem !== undefined)
        issues.add(`${path}.refColumns`, 'fk-no-unique-key', problem.message, problem.severity);
    }
  });
}
