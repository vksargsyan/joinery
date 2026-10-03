import type { ColumnDef, ForeignKeyDef, IndexDef, TableDef } from '@querybara/core';
import { quoteIdent, quoteQualified, quoteString } from '@querybara/sql-tools';

import type { SyncOperation } from '../model';
import { canonicalCharset } from '../normalize';
import { referencedNames } from '../sql-text';
import { canonicalType, isMysqlTextType, typeChangeRisk } from '../types';
import { findType, parseType } from './catalog';
import type { ParsedType } from './catalog';
import { referencedTable, referencingTables, renameIdentifiers } from './prepare';
import type { Prepared } from './prepare';
import type { DataLossSeverity, DataLossWarning } from './types';

/**
 * Data-loss analysis for the save dialog (spec §8): what the save does to existing rows, with
 * queries that count the affected rows before anything runs. Column changes are compared
 * directly (live column → edited column); keys, checks, foreign keys, triggers and partitions
 * follow the diff's operations, so they agree with the script.
 */

interface Shape {
  readonly family:
    | 'int'
    | 'decimal'
    | 'float'
    | 'string'
    | 'binary'
    | 'time'
    | 'timestamp'
    | 'date'
    | 'enum'
    | 'set'
    | 'other';
  readonly bytes?: number;
  readonly unsigned?: boolean;
  /** Longest value: characters for char types, bytes for MySQL TEXT/BLOB and binaries. */
  readonly length?: number;
  readonly lengthInBytes?: boolean;
  readonly precision?: number;
  readonly scale?: number;
  readonly fsp?: number;
  readonly withZone?: boolean;
  readonly values?: readonly string[];
  readonly array: boolean;
}

const INT_BYTES: Readonly<Record<string, number>> = {
  tinyint: 1,
  smallint: 2,
  mediumint: 3,
  int: 4,
  integer: 4,
  bigint: 8,
};
const MYSQL_TEXT_BYTES: Readonly<Record<string, number>> = {
  tinytext: 255,
  text: 65535,
  mediumtext: 16777215,
  longtext: 4294967295,
  tinyblob: 255,
  blob: 65535,
  mediumblob: 16777215,
  longblob: 4294967295,
};

function shapeOf(p: Prepared, dataType: string): Shape {
  const canonical = canonicalType(dataType, p.dialect);
  const parsed: ParsedType | undefined = parseType(canonical, p.engine);
  const array = (parsed?.arrayDimensions ?? 0) > 0;
  if (parsed === undefined || array) return { family: 'other', array };
  const name = parsed.name;
  if (INT_BYTES[name] !== undefined) {
    return { family: 'int', bytes: INT_BYTES[name]!, unsigned: parsed.unsigned === true, array };
  }
  if (name === 'numeric' || name === 'decimal') {
    return {
      family: 'decimal',
      ...(parsed.precision !== undefined
        ? { precision: parsed.precision, scale: parsed.scale ?? 0 }
        : {}),
      unsigned: parsed.unsigned === true,
      array,
    };
  }
  if (['real', 'double precision', 'float', 'double'].includes(name))
    return { family: 'float', array };
  if (['character varying', 'character', 'varchar', 'char'].includes(name)) {
    return {
      family: 'string',
      ...(parsed.length !== undefined ? { length: parsed.length } : {}),
      array,
    };
  }
  if (name === 'text' && p.pg) return { family: 'string', array };
  if (name === 'citext' || name.endsWith('.citext')) return { family: 'string', array };
  if (MYSQL_TEXT_BYTES[name] !== undefined && !p.pg) {
    return {
      family: name.endsWith('blob') ? 'binary' : 'string',
      length: MYSQL_TEXT_BYTES[name]!,
      lengthInBytes: true,
      array,
    };
  }
  if (name === 'binary' || name === 'varbinary') {
    return {
      family: 'binary',
      ...(parsed.length !== undefined ? { length: parsed.length } : {}),
      lengthInBytes: true,
      array,
    };
  }
  if (name === 'bytea') return { family: 'binary', array };
  if (name === 'date') return { family: 'date', array };
  const zoned = /^(time|timestamp) (with|without) time zone$/.exec(name);
  if (zoned) {
    return {
      family: zoned[1] === 'time' ? 'time' : 'timestamp',
      fsp: parsed.fsp ?? 6,
      withZone: zoned[2] === 'with',
      array,
    };
  }
  if (name === 'time') return { family: 'time', fsp: parsed.fsp ?? 0, array };
  if (name === 'datetime' || name === 'timestamp')
    return { family: 'timestamp', fsp: parsed.fsp ?? 0, array };
  if (name === 'enum' || name === 'set')
    return { family: name, values: parsed.values ?? [], array };
  if (p.pg) {
    const entry = findType(p.catalog, parsed);
    if (entry?.userType?.kind === 'enum')
      return { family: 'enum', values: entry.userType.values, array };
  }
  return { family: 'other', array };
}

function intBounds(bytes: number, unsigned: boolean): [string, string] {
  if (unsigned) return ['0', (2n ** BigInt(bytes * 8) - 1n).toString()];
  const half = 2n ** BigInt(bytes * 8 - 1);
  return [(-half).toString(), (half - 1n).toString()];
}

const tenTo = (digits: number): string => `1${'0'.repeat(Math.max(0, digits))}`;

// ---------------------------------------------------------------------------------------------

class Builder {
  readonly list: DataLossWarning[] = [];
  constructor(
    readonly p: Prepared,
    readonly disableForeignKeyChecks = false,
  ) {}

  get table(): string {
    const live = this.p.live!;
    return quoteQualified([this.p.schemaDef?.name ?? this.p.schema, live.name], this.p.dialect);
  }

  col(name: string): string {
    return quoteIdent(name, this.p.dialect);
  }

  count(where: string): string {
    return `SELECT COUNT(*) FROM ${this.table} WHERE ${where}`;
  }

  rows(where: string): string {
    return `SELECT * FROM ${this.table} WHERE ${where} LIMIT 100`;
  }

  add(draft: DataLossWarning): void {
    this.list.push(draft);
  }
}

/** The live name of an edited column (renames reversed); undefined for a new column. */
function liveNameOf(p: Prepared, edited: string): string | undefined {
  for (const [from, to] of p.columnRenames) if (to === edited) return from;
  return p.live?.columns.some((c) => c.name === edited) ? edited : undefined;
}

/** SQL text with edited names turned back into the live ones, so it runs before the save. */
function toLive(p: Prepared, text: string): string {
  const inverse = new Map<string, string>();
  for (const [from, to] of p.identifierRenames) inverse.set(to, from);
  return renameIdentifiers(text, p.dialect, inverse);
}

/** Edited columns an expression mentions that the live table does not have yet. */
function usesNewColumns(p: Prepared, text: string): boolean {
  const words = new Set(referencedNames(text, p.dialect).map((r) => r.name.toLowerCase()));
  return p.table.columns.some(
    (c) => words.has(c.name.toLowerCase()) && liveNameOf(p, c.name) === undefined,
  );
}

function opFor(
  operations: readonly SyncOperation[],
  objectKind: SyncOperation['objectKind'],
  name: string,
): SyncOperation | undefined {
  return operations.find((op) => op.objectKind === objectKind && op.name === name);
}

// ---------------------------------------------------------------------------------------------
// Columns

function typeChange(
  b: Builder,
  live: ColumnDef,
  edited: ColumnDef,
  path: string,
  operationId: string | undefined,
): void {
  const p = b.p;
  const from = canonicalType(live.dataType, p.dialect);
  const to = canonicalType(edited.dataType, p.dialect);
  if (from === to) return;
  const x = shapeOf(p, live.dataType);
  const y = shapeOf(p, edited.dataType);
  const c = b.col(live.name);
  const base = {
    objectKind: 'column' as const,
    objectName: edited.name,
    path,
    ...(operationId !== undefined ? { operationId } : {}),
  };
  const warn = (severity: DataLossSeverity, message: string, where?: string): void => {
    b.add({
      ...base,
      severity,
      message,
      ...(where !== undefined ? { checkQuery: b.count(where), findQuery: b.rows(where) } : {}),
    });
  };
  if (x.family === y.family && !x.array && !y.array) {
    switch (x.family) {
      case 'int': {
        const [min, max] = intBounds(y.bytes ?? 8, y.unsigned === true);
        const narrower =
          (y.bytes ?? 8) < (x.bytes ?? 8) ||
          (x.unsigned !== y.unsigned && (y.unsigned === true || (y.bytes ?? 8) <= (x.bytes ?? 8)));
        if (narrower)
          warn(
            'data-loss',
            `${to} holds ${min} to ${max}: values outside that range do not fit`,
            `${c} < ${min} OR ${c} > ${max}`,
          );
        return;
      }
      case 'decimal': {
        if (y.precision === undefined) return;
        const conditions: string[] = [];
        const reasons: string[] = [];
        const intDigits = y.precision - (y.scale ?? 0);
        if (x.precision === undefined || intDigits < x.precision - (x.scale ?? 0)) {
          conditions.push(`ABS(${c}) >= ${tenTo(intDigits)}`);
          reasons.push(`values of ${tenTo(intDigits)} or more do not fit`);
        }
        if (x.scale === undefined || (y.scale ?? 0) < x.scale) {
          conditions.push(`${c} <> ROUND(${c}, ${y.scale ?? 0})`);
          reasons.push(`values are rounded to ${y.scale ?? 0} decimal place(s)`);
        }
        if (y.unsigned === true && x.unsigned !== true) {
          conditions.push(`${c} < 0`);
          reasons.push('negative values do not fit');
        }
        if (conditions.length > 0)
          warn('data-loss', `${from} → ${to}: ${reasons.join('; ')}`, conditions.join(' OR '));
        return;
      }
      case 'float':
        if (/^(real|float)$/.test(to) && !/^(real|float)$/.test(from))
          warn('data-loss', `${to} keeps about 7 significant digits: values are rounded`);
        return;
      case 'string':
      case 'binary': {
        if (y.length === undefined || (x.length !== undefined && y.length >= x.length)) return;
        const bytes = y.lengthInBytes === true || x.family === 'binary';
        const fn = p.pg
          ? bytes
            ? 'octet_length'
            : 'char_length'
          : bytes
            ? 'LENGTH'
            : 'CHAR_LENGTH';
        warn(
          'data-loss',
          `${to} holds ${y.length} ${bytes ? 'bytes' : 'characters'}: longer values are ${p.pg ? 'truncated' : 'rejected in strict mode, truncated otherwise'}`,
          `${fn}(${c}) > ${y.length}`,
        );
        return;
      }
      case 'time':
      case 'timestamp': {
        if (x.withZone === true && y.withZone !== true) {
          warn(
            'data-loss',
            `${to} drops the time zone: values are converted to the session time zone`,
            `${c} IS NOT NULL`,
          );
          return;
        }
        if (x.withZone !== true && y.withZone === true) {
          warn(
            'info',
            `Existing values are read as times in the session time zone`,
            `${c} IS NOT NULL`,
          );
          return;
        }
        if ((y.fsp ?? 0) < (x.fsp ?? 0)) {
          const cast = p.pg
            ? edited.dataType
            : `${x.family === 'time' ? 'TIME' : 'DATETIME'}(${y.fsp ?? 0})`;
          warn(
            'data-loss',
            `${to} keeps ${y.fsp ?? 0} fractional digit(s): values are rounded`,
            `${c} <> CAST(${c} AS ${cast})`,
          );
        }
        return;
      }
      case 'enum':
      case 'set': {
        const removed = (x.values ?? []).filter((v) => !(y.values ?? []).includes(v));
        if (removed.length === 0) return;
        const literals = removed.map((v) => quoteString(v, p.dialect));
        const where =
          x.family === 'set'
            ? literals.map((l) => `FIND_IN_SET(${l}, ${c}) > 0`).join(' OR ')
            : p.pg
              ? `${c}::text IN (${literals.join(', ')})`
              : `${c} IN (${literals.join(', ')})`;
        warn(
          'data-loss',
          `Rows holding ${removed.map((v) => `'${v}'`).join(', ')} lose their value`,
          where,
        );
        return;
      }
      default:
        break;
    }
  }
  const risk = typeChangeRisk(from, to, p.dialect);
  if (risk === null) return;
  warn(
    risk.lossy ? 'data-loss' : 'may-fail',
    `Changing ${from} to ${to}: ${risk.message}`,
    `${c} IS NOT NULL`,
  );
}

function mysqlCharsetChange(
  b: Builder,
  live: ColumnDef,
  edited: ColumnDef,
  path: string,
  operationId: string | undefined,
): void {
  const p = b.p;
  if (p.pg || !isMysqlTextType(canonicalType(edited.dataType, p.dialect))) return;
  if (!isMysqlTextType(canonicalType(live.dataType, p.dialect))) return;
  const effective = (c: ColumnDef, t: TableDef): string | undefined =>
    canonicalCharset(c.charset ?? c.collation?.split('_')[0] ?? t.options.charset);
  const from = effective(live, p.live!);
  const to = effective(edited, p.table);
  if (from === undefined || to === undefined || from === to || to === 'utf8mb4') return;
  const c = b.col(live.name);
  const where = `CAST(CONVERT(CONVERT(${c} USING ${to}) USING ${from}) AS BINARY) <> CAST(${c} AS BINARY)`;
  b.add({
    severity: 'data-loss',
    objectKind: 'column',
    objectName: edited.name,
    path,
    message: `Converting ${from} to ${to} replaces characters ${to} cannot represent with '?'`,
    checkQuery: b.count(where),
    findQuery: b.rows(where),
    ...(operationId !== undefined ? { operationId } : {}),
  });
}

function columns(b: Builder, operations: readonly SyncOperation[]): void {
  const p = b.p;
  const live = p.live!;
  const edited = p.table;
  for (const column of live.columns) {
    const name = p.columnRenames.get(column.name) ?? column.name;
    const index = edited.columns.findIndex((c) => c.name === name);
    const op = opFor(operations, 'column', index === -1 ? column.name : name);
    const operationId = op?.id;
    const c = b.col(column.name);
    if (index === -1) {
      b.add({
        severity: 'data-loss',
        objectKind: 'column',
        objectName: column.name,
        message: `Drops column ${column.name} and its data`,
        checkQuery: b.count(`${c} IS NOT NULL`),
        ...(operationId !== undefined ? { operationId } : {}),
      });
      continue;
    }
    const target = edited.columns[index]!;
    const path = `columns[${index}]`;
    const ids = operationId !== undefined ? { operationId } : {};
    if (column.generated === undefined && target.generated !== undefined) {
      b.add({
        severity: 'data-loss',
        objectKind: 'column',
        objectName: name,
        path,
        message: 'Stored values are replaced by the generation expression',
        checkQuery: b.count(`${c} IS NOT NULL`),
        ...ids,
      });
    } else if (column.generated !== undefined && target.generated === undefined) {
      const lost = !p.pg && !column.generated.stored;
      b.add({
        severity: lost ? 'data-loss' : 'info',
        objectKind: 'column',
        objectName: name,
        path,
        message: lost
          ? 'The computed values are not kept: the column is re-added and starts out with its default'
          : 'The column keeps its computed values as plain data',
        ...ids,
      });
    }
    if (target.generated === undefined) typeChange(b, column, target, path, operationId);
    mysqlCharsetChange(b, column, target, path, operationId);
    if (column.nullable && !target.nullable && target.generated === undefined) {
      b.add({
        severity: 'may-fail',
        objectKind: 'column',
        objectName: name,
        path,
        message: `Making ${name} NOT NULL fails while rows hold NULL in it`,
        checkQuery: b.count(`${c} IS NULL`),
        findQuery: b.rows(`${c} IS NULL`),
        ...ids,
      });
    }
    if (
      p.pg &&
      column.identity === undefined &&
      target.identity !== undefined &&
      !/nextval/i.test(column.default ?? '')
    ) {
      b.add({
        severity: 'info',
        objectKind: 'column',
        objectName: name,
        path,
        message: `The identity numbers new rows from ${target.identity.start ?? '1'}; existing values are kept and may collide with them`,
        ...ids,
      });
    }
    if (!p.pg && !column.autoIncrement && target.autoIncrement) {
      b.add({
        severity: 'info',
        objectKind: 'column',
        objectName: name,
        path,
        message: 'Existing values are kept; rows holding 0 or NULL are renumbered',
        checkQuery: b.count(`${c} = 0 OR ${c} IS NULL`),
        ...ids,
      });
    }
  }
  edited.columns.forEach((column, index) => {
    if (liveNameOf(p, column.name) !== undefined) return;
    if (column.nullable || column.default !== null || column.generated !== undefined) return;
    if (column.identity !== undefined || column.autoIncrement) return;
    const operationId = opFor(operations, 'column', column.name)?.id;
    b.add({
      severity: p.pg ? 'may-fail' : 'info',
      objectKind: 'column',
      objectName: column.name,
      path: `columns[${index}]`,
      message: p.pg
        ? `Adding NOT NULL column ${column.name} without a default fails when the table has rows`
        : `Existing rows get the implicit default of ${column.dataType} in ${column.name}`,
      checkQuery: `SELECT COUNT(*) FROM ${b.table}`,
      ...(operationId !== undefined ? { operationId } : {}),
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Keys, checks, foreign keys

interface KeyPart {
  readonly sql: string;
}

/** The expressions a unique key groups by, in live names; undefined when one is new. */
function keyParts(
  p: Prepared,
  b: Builder,
  parts: readonly IndexDef['columns'][number][],
): KeyPart[] | undefined {
  const out: KeyPart[] = [];
  for (const part of parts) {
    if (part.name !== null) {
      const live = liveNameOf(p, part.name);
      if (live === undefined) return undefined;
      const c = b.col(live);
      out.push({ sql: part.length !== undefined && !p.pg ? `LEFT(${c}, ${part.length})` : c });
    } else {
      const expression = part.expression ?? '';
      if (usesNewColumns(p, expression)) return undefined;
      out.push({ sql: `(${toLive(p, expression)})` });
    }
  }
  return out;
}

function duplicates(
  b: Builder,
  parts: readonly KeyPart[],
  where: string | undefined,
  base: Omit<DataLossWarning, 'checkQuery' | 'findQuery'>,
): void {
  const list = parts.map((x) => x.sql).join(', ');
  const filters = [
    ...parts.map((x) => `${x.sql} IS NOT NULL`),
    ...(where !== undefined ? [`(${where})`] : []),
  ];
  const whereSql = filters.join(' AND ');
  b.add({
    ...base,
    checkQuery: `SELECT COALESCE(SUM(n), 0) FROM (SELECT COUNT(*) AS n FROM ${b.table} WHERE ${whereSql} GROUP BY ${list} HAVING COUNT(*) > 1) d`,
    findQuery: `SELECT ${list}, COUNT(*) AS duplicates FROM ${b.table} WHERE ${whereSql} GROUP BY ${list} HAVING COUNT(*) > 1 ORDER BY COUNT(*) DESC LIMIT 100`,
  });
}

function keys(b: Builder, operations: readonly SyncOperation[]): void {
  const p = b.p;
  const t = p.table;
  const referenced = referencingTables(p).length > 0;
  for (const op of operations) {
    if (op.reason !== undefined) continue;
    const creates = op.kind === 'create' || op.kind === 'alter';
    const operationId = op.id;
    if (op.objectKind === 'primary-key') {
      if (op.kind === 'drop') {
        b.add({
          severity: 'info',
          objectKind: 'primary-key',
          objectName: op.name,
          operationId,
          message: 'Drops the primary key: rows are no longer identified by it',
        });
        continue;
      }
      if (!creates || t.primaryKey === undefined) continue;
      const parts = keyParts(
        p,
        b,
        t.primaryKey.columns.map((name) => ({ name, order: 'asc' as const })),
      );
      const base = {
        severity: 'may-fail' as const,
        objectKind: 'primary-key' as const,
        objectName: t.primaryKey.name,
        path: 'primaryKey',
        operationId,
        message: `The primary key (${t.primaryKey.columns.join(', ')}) fails while rows share a value`,
      };
      if (parts !== undefined) duplicates(b, parts, undefined, base);
      if (op.kind === 'alter' && referenced) {
        b.add({
          severity: 'info',
          objectKind: 'primary-key',
          objectName: t.primaryKey.name,
          path: 'primaryKey',
          operationId,
          message:
            'Foreign keys that reference the primary key are dropped and re-added around the change',
        });
      }
      continue;
    }
    if (op.objectKind === 'unique' || op.objectKind === 'index') {
      const inUniques = t.uniques.findIndex((u) => u.name === op.name);
      const inIndexes = t.indexes.findIndex((x) => x.name === op.name);
      if (op.kind === 'drop') {
        const wasUnique =
          p.live?.uniques.some((u) => u.name === op.name) === true ||
          p.live?.indexes.some((x) => x.name === op.name && x.unique) === true;
        if (wasUnique)
          b.add({
            severity: 'info',
            objectKind: op.objectKind,
            objectName: op.name,
            operationId,
            message: `Drops ${op.name}: its columns are no longer kept unique`,
          });
        continue;
      }
      if (
        !creates ||
        (op.kind === 'alter' &&
          op.changes.every(
            (c) => c.startsWith('name:') || c.startsWith('comment:') || c.startsWith('invisible:'),
          ))
      )
        continue;
      if (inUniques !== -1) {
        const key = t.uniques[inUniques]!;
        const parts = keyParts(
          p,
          b,
          key.columns.map((name) => ({ name, order: 'asc' as const })),
        );
        if (parts !== undefined)
          duplicates(b, parts, undefined, {
            severity: 'may-fail',
            objectKind: 'unique',
            objectName: key.name,
            path: `uniques[${inUniques}]`,
            operationId,
            message: `Unique constraint ${key.name} fails while rows share a value`,
          });
        continue;
      }
      if (inIndexes === -1) continue;
      const index = t.indexes[inIndexes]!;
      if (!index.unique) continue;
      const parts = keyParts(p, b, index.columns);
      const where =
        index.where !== undefined && !usesNewColumns(p, index.where)
          ? toLive(p, index.where)
          : undefined;
      if (parts !== undefined && (index.where === undefined || where !== undefined))
        duplicates(b, parts, where, {
          severity: 'may-fail',
          objectKind: 'index',
          objectName: index.name,
          path: `indexes[${inIndexes}]`,
          operationId,
          message: `Unique index ${index.name} fails while rows share a value`,
        });
      continue;
    }
    if (op.objectKind === 'check' && creates) {
      const i = t.checks.findIndex((c) => c.name === op.name);
      const check = t.checks[i];
      if (check === undefined) continue;
      const base = {
        severity: 'may-fail' as const,
        objectKind: 'check' as const,
        objectName: check.name,
        path: `checks[${i}]`,
        operationId,
        message: `Check ${check.name} fails while rows violate it`,
      };
      if (usesNewColumns(p, check.expression)) {
        b.add(base);
        continue;
      }
      const where = `NOT (${toLive(p, check.expression)})`;
      b.add({ ...base, checkQuery: b.count(where), findQuery: b.rows(where) });
      continue;
    }
    if (op.objectKind === 'foreign-key' && creates) {
      const i = t.foreignKeys.findIndex((f) => f.name === op.name);
      const fk = t.foreignKeys[i];
      if (fk === undefined) continue;
      foreignKey(b, fk, i, operationId);
      continue;
    }
    if (op.objectKind === 'trigger' && op.kind === 'drop') {
      b.add({
        severity: 'info',
        objectKind: 'trigger',
        objectName: op.name,
        operationId,
        message: `Drops trigger ${op.name} and its code`,
      });
      continue;
    }
    if (op.objectKind === 'partition' && p.pg && (op.kind === 'drop' || op.kind === 'alter')) {
      const partition = quoteQualified([p.schemaDef?.name ?? p.schema, op.name], p.dialect);
      b.add({
        severity: 'data-loss',
        objectKind: 'partition',
        objectName: op.name,
        operationId,
        message: `${op.kind === 'drop' ? 'Drops' : 'Re-creates'} partition ${op.name}, deleting its rows`,
        checkQuery: `SELECT COUNT(*) FROM ${partition}`,
      });
      continue;
    }
    if (op.objectKind === 'partition' && !p.pg) {
      b.add({
        severity: 'may-fail',
        objectKind: 'partition',
        objectName: op.name,
        operationId,
        message: 'Repartitioning rebuilds the table and fails if rows fall outside every partition',
      });
    }
  }
}

function foreignKey(b: Builder, fk: ForeignKeyDef, i: number, operationId: string): void {
  const p = b.p;
  const base = {
    severity: (b.disableForeignKeyChecks ? 'info' : 'may-fail') as DataLossSeverity,
    objectKind: 'foreign-key' as const,
    objectName: fk.name,
    path: `foreignKeys[${i}]`,
    operationId,
    message: b.disableForeignKeyChecks
      ? `Foreign key ${fk.name} is added without checking existing rows`
      : `Foreign key ${fk.name} fails while rows have no matching ${fk.refTable} row`,
  };
  const liveColumns = fk.columns.map((c) => liveNameOf(p, c));
  const refTable = referencedTable(p, fk);
  const self = refTable === p.table;
  const refLiveName = self ? p.live!.name : fk.refTable;
  const refColumns = fk.refColumns.map((c) => (self ? liveNameOf(p, c) : c));
  if (
    refTable === undefined ||
    liveColumns.some((c) => c === undefined) ||
    refColumns.some((c) => c === undefined)
  ) {
    b.add(base);
    return;
  }
  const refName = quoteQualified(
    [
      p.pg
        ? (fk.refSchema ?? p.schemaDef?.name ?? p.schema)
        : (fk.refSchema ?? p.schemaDef?.name ?? p.schema),
      refLiveName,
    ],
    p.dialect,
  );
  const child = (c: string): string => `c.${b.col(c)}`;
  const notNull = liveColumns.map((c) => `${child(c!)} IS NOT NULL`).join(' AND ');
  const match = refColumns
    .map((r, k) => `r.${b.col(r!)} = ${child(liveColumns[k]!)}`)
    .join(' AND ');
  const where = `${notNull} AND NOT EXISTS (SELECT 1 FROM ${refName} r WHERE ${match})`;
  b.add({
    ...base,
    checkQuery: `SELECT COUNT(*) FROM ${b.table} c WHERE ${where}`,
    findQuery: `SELECT c.* FROM ${b.table} c WHERE ${where} LIMIT 100`,
  });
}

/**
 * The data-loss warnings of a save: dropped and retyped columns, NOT NULL, new keys, checks
 * and foreign keys, dropped triggers and partitions — plus any destructive operation of the
 * script the rules above do not describe. Empty for a new table (it has no rows).
 */
export function analyzeDataLoss(
  p: Prepared,
  operations: readonly SyncOperation[],
  disableForeignKeyChecks: boolean,
): DataLossWarning[] {
  if (p.live === null) return [];
  const b = new Builder(p, disableForeignKeyChecks);
  columns(b, operations);
  keys(b, operations);
  const covered = new Set(b.list.map((d) => d.operationId).filter((id) => id !== undefined));
  for (const op of operations) {
    if (covered.has(op.id)) continue;
    for (const warning of op.warnings) {
      if (warning.code !== 'data-loss') continue;
      b.add({
        severity: 'data-loss',
        objectKind: op.objectKind,
        objectName: op.name,
        operationId: op.id,
        message: warning.message,
      });
    }
  }
  return b.list;
}

/** Data-loss warnings for dropping the whole table. */
export function dropTableDataLoss(p: Prepared): DataLossWarning[] {
  const b = new Builder(p);
  return [
    {
      severity: 'data-loss',
      objectKind: 'table',
      objectName: p.live!.name,
      message: `Drops table ${p.live!.name} and all of its rows`,
      checkQuery: `SELECT COUNT(*) FROM ${b.table}`,
    },
  ];
}
