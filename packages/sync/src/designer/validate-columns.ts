import { atLeast } from '@joinery/core';
import type { ColumnDef } from '@joinery/core';

import { canonicalCharset, canonicalCollation } from '../normalize';
import { isFullyParenthesized } from '../sql-text';
import { isMysqlTextType } from '../types';
import { findType, typeCatalog } from './catalog';
import type { ParsedType, TypeCatalogEntry, TypeParameterName } from './catalog';
import type { Prepared } from './prepare';
import {
  BLOB_LIKE,
  duplicates,
  expressionProblem,
  INT_RANGE_BYTES,
  MYSQL_CHARSETS,
  typeOf,
} from './validate-shared';
import type { Issues, Typed } from './validate-shared';

/** Column rules: types and their parameters, defaults, auto-numbering, generation, charsets. */
// ---------------------------------------------------------------------------------------------
// Columns

function parameterValue(parsed: ParsedType, name: TypeParameterName): unknown {
  switch (name) {
    case 'length':
      return parsed.length;
    case 'precision':
      return parsed.precision;
    case 'scale':
      return parsed.scale;
    case 'fsp':
      return parsed.fsp;
    case 'values':
      return parsed.values;
    case 'fields':
      return parsed.fields;
    case 'displayWidth':
      return parsed.displayWidth;
  }
}

function validateType(p: Prepared, issues: Issues, column: ColumnDef, i: number): Typed {
  const path = `columns[${i}].dataType`;
  if (column.dataType.trim() === '') {
    issues.add(path, 'type-required', `Column ${column.name} needs a type`);
    return {};
  }
  const typed = typeOf(p, column);
  const parsed = typed.parsed;
  if (parsed === undefined) {
    issues.add(path, 'malformed-type', `"${column.dataType}" is not a valid type`);
    return {};
  }
  const entry = typed.entry;
  if (entry === undefined) {
    const everything = typeCatalog(p.engine, undefined, p.snapshot);
    const later = findType(everything, parsed);
    if (later !== undefined) {
      issues.add(path, 'type-version', `${later.name} is not available on this server version`);
    } else if (p.pg && (parsed.name.includes('.') || parsed.name.includes('"'))) {
      if (p.snapshot !== undefined)
        issues.add(path, 'unknown-type', `Type ${parsed.name} is not in the schema`, 'warning');
    } else if (
      p.pg &&
      ['citext', 'hstore', 'ltree', 'vector', 'geometry', 'geography'].includes(parsed.name)
    ) {
      issues.add(
        path,
        'extension-type',
        `${parsed.name} comes from an extension that is not installed in this database`,
        p.snapshot !== undefined ? 'error' : 'warning',
      );
    } else {
      issues.add(path, 'unknown-type', `Unknown type ${parsed.name}`);
    }
    return typed;
  }
  const params = new Map(entry.parameters.map((x) => [x.name, x]));
  const numeric: TypeParameterName[] = ['length', 'precision', 'scale', 'fsp', 'displayWidth'];
  for (const name of numeric) {
    const value = parameterValue(parsed, name) as number | undefined;
    if (value === undefined) continue;
    const param = params.get(name);
    if (param === undefined) {
      issues.add(path, 'unexpected-parameter', `${entry.name} takes no ${name}`);
      continue;
    }
    if (
      (param.min !== undefined && value < param.min) ||
      (param.max !== undefined && value > param.max)
    ) {
      issues.add(
        path,
        'parameter-range',
        `${name} of ${entry.name} must be between ${param.min ?? '-∞'} and ${param.max ?? '∞'}`,
      );
    }
  }
  for (const param of entry.parameters) {
    const value = parameterValue(parsed, param.name);
    if (param.required && value === undefined && parsed.modifier === undefined) {
      issues.add(path, 'parameter-required', `${entry.name} needs a ${param.name}`);
    }
  }
  if (
    parsed.modifier !== undefined &&
    entry.userType === undefined &&
    entry.extension === undefined
  ) {
    issues.add(path, 'unexpected-parameter', `${entry.name} does not take (${parsed.modifier})`);
  }
  if (parsed.values !== undefined) {
    if (parsed.values.length === 0)
      issues.add(path, 'parameter-required', `${entry.name} needs at least one label`);
    const max = params.get('values')?.max;
    if (max !== undefined && parsed.values.length > max)
      issues.add(path, 'parameter-range', `${entry.name} holds at most ${max} labels`);
    for (const [k] of duplicates(parsed.values, (v) => v.toLowerCase().trimEnd())) {
      issues.add(path, 'duplicate-label', `Label '${parsed.values[k]!}' is listed twice`);
    }
    if (entry.name === 'set' && parsed.values.some((v) => v.includes(','))) {
      issues.add(path, 'set-label-comma', 'SET labels cannot contain commas');
    }
  }
  if (
    parsed.precision !== undefined &&
    parsed.scale !== undefined &&
    parsed.scale > parsed.precision
  ) {
    const allowed = p.pg && (p.version === undefined || atLeast(p.version, '15'));
    if (!allowed)
      issues.add(path, 'parameter-range', `The scale of ${entry.name} cannot exceed its precision`);
  }
  if (
    !p.pg &&
    entry.name === 'float' &&
    parsed.precision !== undefined &&
    parsed.scale === undefined &&
    parsed.precision > 53
  ) {
    issues.add(path, 'parameter-range', 'float(p) takes a precision from 0 to 53');
  }
  if ((parsed.unsigned === true || parsed.zerofill === true) && !entry.unsigned) {
    issues.add(path, 'unsigned-type', `${entry.name} cannot be UNSIGNED or ZEROFILL`);
  }
  if ((parsed.arrayDimensions ?? 0) > 0 && !entry.array) {
    issues.add(path, 'array-type', `${entry.name} cannot be an array element type`);
  }
  if (entry.deprecated !== undefined) {
    const used =
      entry.name === 'year'
        ? parsed.displayWidth !== undefined
        : INT_RANGE_BYTES[entry.name] !== undefined && !p.pg
          ? parsed.displayWidth !== undefined &&
            !(entry.name === 'tinyint' && parsed.displayWidth === 1)
          : entry.name === 'float' || entry.name === 'double'
            ? parsed.unsigned === true || parsed.zerofill === true || parsed.scale !== undefined
            : entry.name === 'decimal'
              ? parsed.unsigned === true
              : true;
    if (used) issues.add(path, 'deprecated', entry.deprecated, 'warning');
  }
  if (!p.pg && parsed.zerofill === true && p.dialect === 'mysql') {
    issues.add(path, 'deprecated', 'ZEROFILL is deprecated (MySQL 8.0.17)', 'warning');
  }
  if (!p.pg && entry.name === 'varchar' && parsed.length !== undefined) {
    const charset =
      canonicalCharset(
        column.charset ?? column.collation?.split('_')[0] ?? p.table.options.charset,
      ) ?? 'utf8mb4';
    const bytes = MYSQL_CHARSETS[charset] ?? 4;
    if (parsed.length * bytes > 65535) {
      issues.add(
        path,
        'parameter-range',
        `varchar(${parsed.length}) in ${charset} exceeds the 65,535-byte row limit (max ${Math.floor(65535 / bytes)}); use TEXT`,
      );
    }
  }
  if (!p.pg && (entry.name === 'text' || entry.name === 'blob') && parsed.length !== undefined) {
    issues.add(
      path,
      'sized-text',
      `${entry.name}(${parsed.length}) makes the server pick the smallest ${entry.name} type that fits`,
      'warning',
    );
  }
  if (!p.pg && /^serial$/i.test(column.dataType.trim())) {
    issues.add(
      path,
      'serial-alias',
      'SERIAL adds a UNIQUE key; use bigint unsigned AUTO_INCREMENT',
    );
  }
  return typed;
}

function isTemporal(entry: TypeCatalogEntry | undefined): boolean {
  return entry !== undefined && ['datetime', 'timestamp'].includes(entry.name);
}

const NOW_DEFAULT = /^(?:current_timestamp|now|localtime|localtimestamp)\s*(?:\(\s*\d*\s*\))?$/i;

function validateDefault(
  p: Prepared,
  issues: Issues,
  column: ColumnDef,
  i: number,
  typed: Typed,
): void {
  const path = `columns[${i}].default`;
  if (column.default === null) return;
  const text = column.default.trim();
  if (text === '') {
    issues.add(path, 'empty-default', "The default is empty; clear it for no default, or write ''");
    return;
  }
  if (column.generated !== undefined)
    issues.add(path, 'generated-default', 'A generated column cannot have a default');
  if (p.pg && column.identity !== undefined)
    issues.add(path, 'identity-default', 'An identity column cannot also have a default');
  if (!p.pg && column.autoIncrement)
    issues.add(path, 'auto-increment-default', 'An AUTO_INCREMENT column cannot have a default');
  const problem = expressionProblem(text, p);
  if (problem !== undefined) {
    issues.add(path, 'default-syntax', `The default has an ${problem}`);
    return;
  }
  const entry = typed.entry;
  if (!p.pg && entry !== undefined) {
    const expression = isFullyParenthesized(text, p.dialect);
    const blobLike = BLOB_LIKE.has(entry.name);
    if (p.dialect === 'mysql' && blobLike && !expression && !/^null$/i.test(text)) {
      issues.add(
        path,
        'literal-default-not-allowed',
        `MySQL does not allow a literal default on ${entry.name.toUpperCase()} columns; write it as an expression, e.g. (${text})`,
      );
    }
    if (
      expression &&
      p.dialect === 'mysql' &&
      p.version !== undefined &&
      !atLeast(p.version, '8.0.13')
    ) {
      issues.add(
        path,
        'expression-default-version',
        'Expression defaults need MySQL 8.0.13 or later',
      );
    }
    if (
      expression &&
      p.dialect === 'mariadb' &&
      p.version !== undefined &&
      !atLeast(p.version, '10.2.1')
    ) {
      issues.add(
        path,
        'expression-default-version',
        'Expression defaults need MariaDB 10.2.1 or later',
      );
    }
    if (NOW_DEFAULT.test(text) && !isTemporal(entry)) {
      issues.add(
        path,
        'default-type',
        `${text} is only a valid default for DATETIME and TIMESTAMP`,
      );
    }
  }
  if (entry !== undefined && entry.category === 'numeric' && /^'.*'$/s.test(text)) {
    const inner = text.slice(1, -1).trim();
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i.test(inner)) {
      issues.add(path, 'default-type', `'${inner}' is not a number`);
    }
  }
}

/** Every column rule; returns the parsed type of each column for the key rules. */
export function validateColumns(p: Prepared, issues: Issues): Map<number, Typed> {
  const t = p.edited;
  const types = new Map<number, Typed>();
  const pkColumns = new Set(t.primaryKey?.columns.map((c) => (p.pg ? c : c.toLowerCase())) ?? []);
  const autoIncrements: number[] = [];
  t.columns.forEach((column, i) => {
    const typed = validateType(p, issues, column, i);
    types.set(i, typed);
    const entry = typed.entry;
    validateDefault(p, issues, column, i, typed);
    const base = `columns[${i}]`;
    if (column.onUpdate !== undefined) {
      if (p.pg)
        issues.add(
          `${base}.onUpdate`,
          'on-update-unsupported',
          'PostgreSQL has no ON UPDATE clause; use a trigger',
        );
      else if (entry !== undefined && !isTemporal(entry))
        issues.add(
          `${base}.onUpdate`,
          'on-update-type',
          'ON UPDATE only applies to DATETIME and TIMESTAMP columns',
        );
    }
    if (column.autoIncrement) {
      autoIncrements.push(i);
      if (p.pg) {
        issues.add(
          `${base}.autoIncrement`,
          'auto-increment-unsupported',
          'PostgreSQL has no AUTO_INCREMENT: use an identity column',
        );
      } else if (entry !== undefined && INT_RANGE_BYTES[entry.name] === undefined) {
        issues.add(
          `${base}.autoIncrement`,
          'auto-increment-type',
          'AUTO_INCREMENT needs an integer column',
        );
      }
      if (column.generated !== undefined)
        issues.add(
          `${base}.autoIncrement`,
          'auto-increment-generated',
          'A generated column cannot be AUTO_INCREMENT',
        );
    }
    if (column.identity !== undefined) {
      if (!p.pg) {
        issues.add(
          `${base}.identity`,
          'identity-unsupported',
          'Identity columns are PostgreSQL-only: use AUTO_INCREMENT',
        );
      } else {
        if (entry !== undefined && !['smallint', 'integer', 'bigint'].includes(entry.name))
          issues.add(
            `${base}.identity`,
            'identity-type',
            'Identity columns must be smallint, integer or bigint',
          );
        if (column.nullable)
          issues.add(
            `${base}.nullable`,
            'identity-nullable',
            'Identity columns are always NOT NULL; the column is saved as NOT NULL',
            'warning',
          );
        if (column.generated !== undefined)
          issues.add(
            `${base}.identity`,
            'identity-generated',
            'A generated column cannot be an identity',
          );
      }
    }
    if (column.generated !== undefined) {
      if (column.generated.expression.trim() === '')
        issues.add(
          `${base}.generated.expression`,
          'generated-expression',
          'The generation expression is empty',
        );
      else {
        const problem = expressionProblem(column.generated.expression, p);
        if (problem !== undefined)
          issues.add(
            `${base}.generated.expression`,
            'expression-syntax',
            `The generation expression has an ${problem}`,
          );
      }
      if (
        p.pg &&
        !column.generated.stored &&
        (p.version === undefined || !atLeast(p.version, '18'))
      )
        issues.add(
          `${base}.generated.stored`,
          'virtual-generated-version',
          'PostgreSQL before 18 only has STORED generated columns',
        );
      if (p.dialect === 'mariadb' && !column.nullable)
        issues.add(
          `${base}.nullable`,
          'generated-not-null',
          'MariaDB generated columns cannot be declared NOT NULL',
        );
    }
    if (
      column.nullable &&
      p.table.columns[i]?.nullable === false &&
      pkColumns.has(p.pg ? column.name : column.name.toLowerCase())
    ) {
      issues.add(
        `${base}.nullable`,
        'nullable-primary-key',
        `Primary key columns are NOT NULL; ${column.name} is saved as NOT NULL`,
        'warning',
      );
    }
    validateCharset(p, issues, column, i, entry);
    if (!p.pg && column.comment !== undefined && [...column.comment].length > 1024)
      issues.add(
        `${base}.comment`,
        'comment-too-long',
        'Column comments are limited to 1,024 characters',
      );
  });
  if (autoIncrements.length > 1 && !p.pg) {
    for (const i of autoIncrements.slice(1))
      issues.add(
        `columns[${i}].autoIncrement`,
        'auto-increment-count',
        'A table can have only one AUTO_INCREMENT column',
      );
  }
  if (!p.pg && autoIncrements.length > 0) {
    const i = autoIncrements[0]!;
    const name = t.columns[i]!.name.toLowerCase();
    const engine = (t.options.engine ?? 'innodb').toLowerCase();
    const anyPosition = engine === 'myisam' || engine === 'aria';
    const keys = [
      ...(t.primaryKey !== undefined ? [t.primaryKey.columns] : []),
      ...t.uniques.map((u) => u.columns),
      ...t.indexes
        .filter((x) => !['fulltext', 'spatial'].includes(x.method?.toLowerCase() ?? ''))
        .map((x) => x.columns.map((c) => c.name ?? '')),
    ];
    const keyed = keys.some((cols) =>
      anyPosition ? cols.some((c) => c.toLowerCase() === name) : cols[0]?.toLowerCase() === name,
    );
    if (!keyed)
      issues.add(
        `columns[${i}].autoIncrement`,
        'auto-increment-key',
        anyPosition
          ? 'The AUTO_INCREMENT column must be part of a key'
          : 'The AUTO_INCREMENT column must be the first column of the primary key or an index',
      );
  }
  return types;
}

function validateCharset(
  p: Prepared,
  issues: Issues,
  column: ColumnDef,
  i: number,
  entry: TypeCatalogEntry | undefined,
): void {
  const base = `columns[${i}]`;
  if (p.pg) {
    if (column.charset !== undefined)
      issues.add(
        `${base}.charset`,
        'charset-unsupported',
        'PostgreSQL columns have no character set',
      );
    if (column.collation !== undefined && entry !== undefined && !entry.collation)
      issues.add(`${base}.collation`, 'collation-type', `${entry.name} is not collatable`);
    return;
  }
  const textType = entry !== undefined && isMysqlTextType(entry.name);
  if (
    (column.charset !== undefined || column.collation !== undefined) &&
    entry !== undefined &&
    !textType
  ) {
    issues.add(
      `${base}.charset`,
      'charset-type',
      `${entry.name} has no character set or collation`,
    );
    return;
  }
  const charset = canonicalCharset(column.charset);
  if (charset !== undefined && MYSQL_CHARSETS[charset] === undefined)
    issues.add(
      `${base}.charset`,
      'unknown-charset',
      `Unknown character set ${column.charset!}`,
      'warning',
    );
  if (column.collation !== undefined) {
    const collationCharset = canonicalCharset(canonicalCollation(column.collation)!.split('_')[0]);
    const effective = charset ?? canonicalCharset(p.table.options.charset);
    if (
      collationCharset !== undefined &&
      MYSQL_CHARSETS[collationCharset] !== undefined &&
      effective !== undefined &&
      collationCharset !== effective &&
      column.charset !== undefined
    ) {
      issues.add(
        `${base}.collation`,
        'collation-mismatch',
        `Collation ${column.collation} does not belong to character set ${column.charset}`,
      );
    }
  } else if (charset !== undefined && charset !== canonicalCharset(p.table.options.charset)) {
    issues.add(
      `${base}.collation`,
      'collation-missing',
      `Pick a collation for ${column.charset!}: the server would use its default, which reads back as a difference`,
      'warning',
    );
  }
}
