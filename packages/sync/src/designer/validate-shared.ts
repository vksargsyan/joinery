import type { ColumnDef, TableDef } from '@querybara/core';

import { referencedNames, tokenizeSql } from '../sql-text';
import { findType, parseType } from './catalog';
import type { ParsedType, TypeCatalogEntry } from './catalog';
import { identifierLength, isReservedWord, maxIdentifierLength } from './names';
import type { Prepared } from './prepare';
import type { ValidationIssue } from './types';

/** Building blocks shared by the validation rules (see validate.ts). */

export type Severity = ValidationIssue['severity'];

/** The issues a validation pass collects. */
export class Issues {
  readonly list: ValidationIssue[] = [];
  add(path: string, code: string, message: string, severity: Severity = 'error'): void {
    this.list.push({ path, code, message, severity });
  }
}

/** Character sets MySQL/MariaDB know, with their longest character in bytes. */
export const MYSQL_CHARSETS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(
    `latin1 latin2 latin5 latin7 ascii binary cp1250 cp1251 cp1256 cp1257 cp850 cp852 cp866 dec8
    greek hebrew hp8 keybcs2 koi8r koi8u macce macroman swe7 tis620 armscii8 geostd8`
      .split(/\s+/)
      .map((c) => [c, 1]),
  ),
  ...Object.fromEntries('ucs2 big5 gbk gb2312 sjis cp932 euckr'.split(' ').map((c) => [c, 2])),
  ...Object.fromEntries('utf8 utf8mb3 ujis eucjpms'.split(' ').map((c) => [c, 3])),
  ...Object.fromEntries('utf8mb4 utf16 utf16le utf32 gb18030'.split(' ').map((c) => [c, 4])),
};

/** Storage engines MySQL and MariaDB ship (others only warn). */
export const MYSQL_ENGINES = new Set(
  `innodb myisam memory csv archive blackhole merge mrg_myisam federated ndb ndbcluster aria
  rocksdb columnstore spider connect sequence s3`.split(/\s+/),
);
export const MYSQL_ROW_FORMATS = new Set(
  'default dynamic fixed compressed redundant compact page'.split(' '),
);
/** `TableDef.options` keys the MySQL renderer writes. */
export const MYSQL_OPTION_KEYS = ['engine', 'charset', 'collation', 'autoIncrement', 'rowFormat'];

/** Built-in index access methods. */
export const PG_INDEX_METHODS = ['btree', 'hash', 'gist', 'spgist', 'gin', 'brin'];
export const MYSQL_INDEX_METHODS = ['btree', 'hash', 'fulltext', 'spatial', 'rtree'];

/** PostgreSQL table storage parameters and the kind of value each takes. */
export const PG_STORAGE_PARAMETERS: Readonly<Record<string, 'int' | 'bool' | 'real'>> = {
  fillfactor: 'int',
  toast_tuple_target: 'int',
  parallel_workers: 'int',
  autovacuum_enabled: 'bool',
  vacuum_index_cleanup: 'bool',
  vacuum_truncate: 'bool',
  user_catalog_table: 'bool',
  autovacuum_vacuum_threshold: 'int',
  autovacuum_vacuum_insert_threshold: 'int',
  autovacuum_analyze_threshold: 'int',
  autovacuum_vacuum_cost_limit: 'int',
  autovacuum_freeze_min_age: 'int',
  autovacuum_freeze_max_age: 'int',
  autovacuum_freeze_table_age: 'int',
  autovacuum_multixact_freeze_min_age: 'int',
  autovacuum_multixact_freeze_max_age: 'int',
  autovacuum_multixact_freeze_table_age: 'int',
  log_autovacuum_min_duration: 'int',
  autovacuum_vacuum_scale_factor: 'real',
  autovacuum_vacuum_insert_scale_factor: 'real',
  autovacuum_analyze_scale_factor: 'real',
  autovacuum_vacuum_cost_delay: 'real',
};

/** Integer types and their size in bytes. */
export const INT_RANGE_BYTES: Readonly<Record<string, number>> = {
  tinyint: 1,
  smallint: 2,
  mediumint: 3,
  int: 4,
  integer: 4,
  bigint: 8,
};

/** MySQL types that take no literal DEFAULT and need a prefix to be indexed. */
export const BLOB_LIKE = new Set(
  `tinytext text mediumtext longtext tinyblob blob mediumblob longblob json geometry point
  linestring polygon multipoint multilinestring multipolygon geometrycollection`.split(/\s+/),
);

// ---------------------------------------------------------------------------------------------
// Shared helpers

/** A column type as parsed, with its catalogue entry when the type is known. */
export interface Typed {
  readonly parsed?: ParsedType;
  readonly entry?: TypeCatalogEntry;
}

/**
 * Column lookup with the engine's name rules (MySQL column names are case-insensitive). In the
 * edited table, a reference that still uses a renamed column's old name finds the column: the
 * save follows the rename.
 */
export function columnNamed(
  p: Prepared,
  table: TableDef,
  name: string | null,
): ColumnDef | undefined {
  if (name === null) return undefined;
  const find = (n: string): ColumnDef | undefined =>
    p.pg
      ? table.columns.find((c) => c.name === n)
      : table.columns.find((c) => c.name.toLowerCase() === n.toLowerCase());
  const found = find(name);
  if (found !== undefined || table !== p.edited) return found;
  const renamed = p.columnRenames.get(name);
  return renamed !== undefined ? find(renamed) : undefined;
}

/** Name equality with the engine's rules (MySQL names are case-insensitive). */
export function sameName(p: Prepared, a: string, b: string): boolean {
  return p.pg ? a === b : a.toLowerCase() === b.toLowerCase();
}

/** Parses a column type and finds it in the catalogue (unqualified PostgreSQL user types too). */
export function typeOf(p: Prepared, column: ColumnDef): Typed {
  const parsed = parseType(column.dataType, p.engine);
  if (parsed === undefined) return {};
  let entry = findType(p.catalog, parsed);
  if (entry === undefined && p.pg && !parsed.name.includes('.')) {
    entry = p.catalog.find(
      (e) =>
        e.userType !== undefined &&
        e.userType.schema === p.schema &&
        e.name.endsWith(`.${parsed.name}`),
    );
  }
  return { parsed, ...(entry !== undefined ? { entry } : {}) };
}

/** Column names an expression mentions (words that name a column of `table`). */
export function columnsIn(p: Prepared, text: string, columns: readonly string[]): string[] {
  const words = new Set(referencedNames(text, p.dialect).map((r) => r.name.toLowerCase()));
  return columns.filter((c) => words.has(c.toLowerCase()));
}

/** Balanced parentheses and terminated literals: the cheap syntax check for expressions. */
export function expressionProblem(text: string, p: Prepared): string | undefined {
  const tokens = tokenizeSql(text, p.dialect);
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'string' && !/(['"])$/.test(token.text.trim())) return 'unterminated string';
    if (token.kind === 'quoted-ident' && token.text.length < 2) return 'unterminated identifier';
    if (token.kind === 'comment' && token.text.startsWith('/*') && !token.text.endsWith('*/')) {
      return 'unterminated comment';
    }
    if (token.kind === 'punct' && token.text === ';') return 'semicolon in an expression';
    if (token.kind === 'punct' && token.text === '(') depth++;
    if (token.kind === 'punct' && token.text === ')') {
      depth--;
      if (depth < 0) return 'unbalanced parentheses';
    }
  }
  return depth !== 0 ? 'unbalanced parentheses' : undefined;
}

/** Name rules: required, length limit, trailing spaces, reserved or unusual names. */
export function checkName(
  issues: Issues,
  p: Prepared,
  path: string,
  name: string,
  what: string,
  required = true,
): void {
  if (name.trim() === '') {
    if (required) issues.add(path, 'name-required', `The ${what} needs a name`);
    return;
  }
  if (identifierLength(name, p.dialect) > maxIdentifierLength(p.dialect)) {
    issues.add(
      path,
      'name-too-long',
      `${what[0]!.toUpperCase()}${what.slice(1)} names are limited to ${maxIdentifierLength(p.dialect)} ${p.pg ? 'bytes' : 'characters'}`,
    );
  }
  if (!p.pg && name !== name.trimEnd()) {
    issues.add(path, 'name-trailing-space', `MySQL names cannot end with a space`);
  }
  if (isReservedWord(name, p.dialect)) {
    issues.add(
      path,
      'reserved-name',
      `"${name}" is a reserved word: scripts quote it, but hand-written SQL must too`,
      'warning',
    );
  } else if (p.pg && name !== name.toLowerCase()) {
    issues.add(
      path,
      'mixed-case-name',
      `"${name}" has upper-case letters: PostgreSQL only matches it when quoted`,
      'warning',
    );
  } else if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) {
    issues.add(
      path,
      'unusual-name',
      `"${name}" contains characters that need quoting in SQL`,
      'warning',
    );
  }
}

/** Later positions of repeated keys, each mapped to the first position of its key. */
export function duplicates<T>(items: readonly T[], key: (item: T) => string): Map<number, number> {
  const seen = new Map<string, number>();
  const dups = new Map<number, number>();
  items.forEach((item, i) => {
    const k = key(item);
    if (k === '') return;
    const first = seen.get(k);
    if (first !== undefined) dups.set(i, first);
    else seen.set(k, i);
  });
  return dups;
}
