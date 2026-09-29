import {
  JoineryError,
  newId,
  tableDefSchema,
  type CellValue,
  type ColumnDef,
  type SchemaDef,
  type Session,
  type SqlDialect,
  type TableDef,
} from '@joinery/core';
import {
  ObjectId,
  fromEjson,
  isBsonDocument,
  toEjson,
  type BsonDocument,
  type BsonValue,
  type Namespace,
} from '@joinery/mongo-tools';
import { quoteIdent } from '@joinery/sql-tools';
import {
  parseType,
  renderForeignKey,
  renderPrimaryKey,
  renderTableStatements,
} from '@joinery/sync';

import { importRows } from '../import';
import { runStatement } from '../session';
import { qualifiedTable } from '../statements';
import type { RowBatch, RowError, SourceCell } from '../types';
import { fitIdentifier, isSafeDataType } from './names';
import type {
  Execution,
  ExecutionContext,
  TransferUnit,
  UnitContext,
  UnitResult,
} from './pipeline';
import {
  bsonCell,
  flattenCollection,
  isMongoFieldType,
  mongoFieldType,
  toBsonValue,
  valueAtPath,
  type FlatTable,
  type MongoFieldType,
} from './mongo-map';
import { asMongo, type MongoTransferSession } from './sessions';
import type {
  DbTableMode,
  DbTransferError,
  DbTransferOptions,
  DbTransferSpec,
  PlannedColumn,
  PlannedTable,
  TransferPlan,
} from './spec';
import { relaxConstraints, rowEstimates, utcSession } from './sql-transfer';
import { readExpression, type ReadForm } from './type-map';

/**
 * Transfers between SQL engines and MongoDB (spec §12). SQL → MongoDB streams each table into
 * a collection, one document per row, with child rows embedded through a chosen foreign key
 * (looked up a batch of parents at a time on a second session, so memory stays flat).
 * MongoDB → SQL samples each collection's schema, flattens it into a table plus child tables
 * for arrays, and loads each table through the import pipeline in its own pass over the
 * collection.
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function collectionExists(session: MongoTransferSession, ns: Namespace): Promise<boolean> {
  try {
    await session.collectionInfo(ns);
    return true;
  } catch (error) {
    if (error instanceof JoineryError && error.code === 'NOT_FOUND') return false;
    throw error;
  }
}

/** `db.orders` as the review shows it. */
function shellName(ns: Namespace): string {
  return /^[A-Za-z_$][\w$]*$/.test(ns.collection)
    ? `db.${ns.collection}`
    : `db.getCollection(${JSON.stringify(ns.collection)})`;
}

// ---------------------------------------------------------------------------------------------
// SQL → MongoDB

interface Field {
  readonly column: string;
  readonly name: string;
  readonly type: MongoFieldType;
}

interface Embed {
  readonly table: string;
  readonly field: string;
  readonly foreignKey: string;
  /** Parent columns the foreign key references, and the child columns holding them. */
  readonly parentColumns: readonly string[];
  readonly childColumns: readonly string[];
  readonly fields: readonly Field[];
  readonly select: string;
  readonly order: readonly string[];
}

interface CollectionLoad {
  readonly planned: PlannedTable;
  readonly ns: Namespace;
  readonly select: string;
  readonly columns: readonly string[];
  readonly fields: readonly Field[];
  /** The column that becomes `_id`, if any. */
  readonly idColumn: string | undefined;
  readonly embeds: readonly Embed[];
  readonly indexes: readonly {
    readonly keys: Record<string, number>;
    readonly unique: boolean;
    readonly name: string;
  }[];
}

/** How a SQL column is read for a document (arrays as JSON, money as numeric, spatial as WKT). */
function readFormFor(dataType: string, dialect: SqlDialect): ReadForm | undefined {
  const type = parseType(dataType, dialect);
  if (type === undefined) return undefined;
  if ((type.arrayDimensions ?? 0) > 0) return dialect === 'postgres' ? 'json' : undefined;
  if (type.name === 'money') return 'numeric';
  if (
    /(^|\.)(geometry|geography|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection)$/.test(
      type.name,
    )
  ) {
    return dialect === 'postgres' && !/(geometry|geography)$/.test(type.name) ? 'text' : 'wkt';
  }
  return undefined;
}

function selectList(
  columns: readonly { name: string; dataType: string }[],
  dialect: SqlDialect,
): string {
  return columns
    .map((c) => {
      const q = quoteIdent(c.name, dialect);
      const form = readFormFor(c.dataType, dialect);
      return form === undefined ? q : `${readExpression(form, q, dialect)} AS ${q}`;
    })
    .join(', ');
}

/** A key for grouping children under parents: the values as text. */
function groupKey(values: readonly CellValue[]): string {
  return JSON.stringify(
    values.map((v) =>
      typeof v === 'bigint'
        ? `${v}n`
        : v instanceof Uint8Array
          ? Buffer.from(v).toString('hex')
          : v,
    ),
  );
}

async function* sqlPages(
  session: Session,
  text: string,
  params: readonly CellValue[],
  pageSize: number,
  signal: AbortSignal,
): AsyncGenerator<CellValue[][]> {
  for await (const chunk of session.execute(text, {
    executionId: newId(),
    pageSize,
    signal,
    ...(params.length > 0 ? { params } : {}),
  })) {
    if (chunk.type !== 'rows' || chunk.resultIndex !== 0) continue;
    const rows: CellValue[][] = new Array<CellValue[]>(chunk.rowCount);
    for (let r = 0; r < chunk.rowCount; r++)
      rows[r] = chunk.data.map((column) => column[r] ?? null);
    yield rows;
  }
}

/** Child rows of a batch of parents, grouped by the parent key. */
async function lookupChildren(
  session: Session,
  embed: Embed,
  parents: readonly CellValue[][],
  dialect: SqlDialect,
  signal: AbortSignal,
): Promise<Map<string, BsonDocument[]>> {
  const keys = new Map<string, CellValue[]>();
  for (const values of parents)
    if (values.every((v) => v !== null)) keys.set(groupKey(values), values);
  const grouped = new Map<string, BsonDocument[]>();
  if (keys.size === 0) return grouped;
  const width = embed.childColumns.length;
  let n = 0;
  const placeholder = (): string => (dialect === 'postgres' ? `$${++n}` : '?');
  const tuples = [...keys.values()].map((values) =>
    width === 1 ? placeholder() : `(${values.map(() => placeholder()).join(', ')})`,
  );
  const left =
    width === 1
      ? quoteIdent(embed.childColumns[0]!, dialect)
      : `(${embed.childColumns.map((c) => quoteIdent(c, dialect)).join(', ')})`;
  const order = embed.order.map((c) => quoteIdent(c, dialect)).join(', ');
  const text = `${embed.select} WHERE ${left} IN (${tuples.join(', ')})${order ? ` ORDER BY ${order}` : ''}`;
  const params = [...keys.values()].flat();
  for await (const rows of sqlPages(session, text, params, 1000, signal)) {
    for (const row of rows) {
      const key = groupKey(row.slice(0, width));
      const document: BsonDocument = {};
      embed.fields.forEach((field, i) => {
        document[field.name] = toBsonValue(row[width + i] ?? null, field.type);
      });
      const list = grouped.get(key);
      if (list) list.push(document);
      else grouped.set(key, [document]);
    }
  }
  return grouped;
}

/** The position of the first document a bulk insert refused, from the driver's error. */
function failedIndex(error: unknown): number | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause as
    { writeErrors?: unknown } | undefined;
  const writeErrors = cause?.writeErrors;
  const first = (Array.isArray(writeErrors) ? writeErrors[0] : writeErrors) as
    { index?: unknown } | undefined;
  return typeof first?.index === 'number' ? first.index : undefined;
}

/**
 * Inserts a batch of documents in order. When one is refused (a duplicate `_id`, a validator),
 * the documents before it are in, it is logged with its source row, and the insert goes on
 * after it (`skip`) or stops (`stop`). Failures that are not about a document throw.
 */
export async function insertDocuments(
  session: MongoTransferSession,
  ns: Namespace,
  documents: readonly BsonDocument[],
  rows: readonly number[],
  onError: 'stop' | 'skip',
  signal: AbortSignal,
): Promise<{ written: number; errors: RowError[]; stopped: boolean }> {
  let written = 0;
  const errors: RowError[] = [];
  let start = 0;
  while (start < documents.length) {
    const batch = start === 0 ? documents : documents.slice(start);
    try {
      await session.insertMany(ns, toEjson(batch), { ordered: true, signal });
      written += batch.length;
      break;
    } catch (error) {
      const at = signal.aborted ? undefined : failedIndex(error);
      if (at === undefined) throw error;
      written += at;
      errors.push({ row: rows[start + at]!, message: messageOf(error) });
      if (onError === 'stop') return { written, errors, stopped: true };
      start += at + 1;
    }
  }
  return { written, errors, stopped: false };
}

function collectionUnit(load: CollectionLoad, dialect: SqlDialect): TransferUnit {
  return {
    source: load.planned.source,
    target: load.planned.target,
    async load(context: UnitContext): Promise<UnitResult> {
      const target = asMongo(context.target);
      const { options, signal } = context;
      const idAt = load.idColumn === undefined ? -1 : load.columns.indexOf(load.idColumn);
      const fieldAt = load.fields.map((f) => load.columns.indexOf(f.column));
      const embedKeys = load.embeds.map((e) => e.parentColumns.map((c) => load.columns.indexOf(c)));
      let read = 0;
      let written = 0;
      let skipped = 0;
      const errors: RowError[] = [];
      const lookup = load.embeds.length > 0 ? await context.lookup() : undefined;
      try {
        for await (const rows of sqlPages(
          context.source,
          load.select,
          [],
          options.batchSize,
          signal,
        )) {
          const children = lookup
            ? await Promise.all(
                load.embeds.map((embed, e) =>
                  lookupChildren(
                    lookup,
                    embed,
                    rows.map((row) => embedKeys[e]!.map((i) => row[i] ?? null)),
                    dialect,
                    signal,
                  ),
                ),
              )
            : [];
          const documents: BsonDocument[] = [];
          const numbers: number[] = [];
          for (const row of rows) {
            read++;
            try {
              const document: BsonDocument = {
                _id:
                  idAt >= 0
                    ? toBsonValue(
                        row[idAt] ?? null,
                        load.fields.find((f) => f.column === load.idColumn)?.type ?? 'string',
                      )
                    : new ObjectId(),
              };
              load.fields.forEach((field, i) => {
                if (field.column === load.idColumn) return;
                document[field.name] = toBsonValue(row[fieldAt[i]!] ?? null, field.type);
              });
              load.embeds.forEach((embed, e) => {
                const key = groupKey(embedKeys[e]!.map((i) => row[i] ?? null));
                document[embed.field] = children[e]!.get(key) ?? [];
              });
              if (document['_id'] === null) throw new Error('The _id column is NULL');
              documents.push(document);
              numbers.push(read);
            } catch (error) {
              skipped++;
              errors.push({ row: read, message: messageOf(error) });
              if (options.onError === 'stop') {
                return { status: 'failed', read, written, skipped, errors };
              }
            }
          }
          const result = await insertDocuments(
            target,
            load.ns,
            documents,
            numbers,
            options.onError,
            signal,
          );
          written += result.written;
          skipped += result.errors.length;
          errors.push(...result.errors);
          context.progress({ read, written, skipped });
          if (result.stopped) return { status: 'failed', read, written, skipped, errors };
        }
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled', read, written, skipped, errors };
        errors.push({ message: messageOf(error) });
        return { status: 'failed', read, written, skipped, errors };
      }
      return { status: signal.aborted ? 'cancelled' : 'completed', read, written, skipped, errors };
    },
    async finish(context: UnitContext): Promise<void> {
      const target = asMongo(context.target);
      for (const index of load.indexes) {
        await target.createIndex(load.ns, {
          keys: JSON.stringify(index.keys),
          name: index.name,
          ...(index.unique ? { unique: true } : {}),
        });
      }
    },
  };
}

/** Plans a SQL → MongoDB transfer. */
export async function sqlToMongoExecution(
  spec: DbTransferSpec,
  options: DbTransferOptions,
  source: Session,
  targetSession: Session,
): Promise<Execution> {
  const target = asMongo(targetSession);
  const dialect = source.engine as SqlDialect;
  const schemaName = dialect === 'postgres' ? spec.source.schema || 'public' : undefined;
  const db = spec.target.database || target.currentDatabase;
  const [snapshot, rows] = await Promise.all([
    source.introspect({ ...(schemaName ? { schemas: [schemaName] } : {}), include: ['table'] }),
    rowEstimates(source, schemaName),
  ]);
  const schema: SchemaDef | undefined =
    schemaName === undefined
      ? snapshot.schemas[0]
      : snapshot.schemas.find((s) => s.name === schemaName);
  const findTable = (name: string): TableDef | undefined =>
    schema?.tables.find((t) => t.name === name) ??
    (dialect === 'postgres'
      ? undefined
      : schema?.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()));
  const loads: CollectionLoad[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const before: { ns: Namespace; mode: DbTableMode; exists: boolean }[] = [];
  const seen = new Set<string>();
  for (const object of spec.objects) {
    const table = findTable(object.name);
    const name = object.target?.trim() || object.name;
    const ns = { db, collection: name };
    const mode = object.mode ?? options.mode;
    const tableProblems: string[] = [];
    const tableWarnings: string[] = [];
    if (table === undefined) {
      tableProblems.push(`Table ${object.name} was not found on the source`);
    }
    if (seen.has(name)) tableProblems.push(`Two tables are transferred into ${name}`);
    seen.add(name);
    const exists = await collectionExists(target, ns);
    if (exists && mode === 'create') {
      tableProblems.push(
        `${name} already exists on the target; choose drop and create, truncate or append`,
      );
    }
    const overrides = new Map((object.columns ?? []).map((o) => [o.source, o]));
    const planned: PlannedColumn[] = [];
    const fields: Field[] = [];
    const pk = table?.primaryKey?.columns ?? [];
    const idColumn =
      options.idFromPrimaryKey && pk.length === 1 && overrides.get(pk[0]!)?.skip !== true
        ? pk[0]
        : undefined;
    const names = new Set<string>(['_id']);
    for (const column of [...(table?.columns ?? [])].sort((a, b) => a.ordinal - b.ordinal)) {
      const override = overrides.get(column.name);
      const defaultType = mongoFieldType(column.dataType, dialect);
      const requested = override?.dataType?.trim();
      const type = requested !== undefined && requested !== '' ? requested : defaultType;
      if (!isMongoFieldType(type))
        tableProblems.push(`${column.name}: "${type}" is not a BSON type Joinery writes`);
      const isId = column.name === idColumn;
      const fieldName = isId
        ? '_id'
        : validFieldName(override?.target?.trim() || column.name, names);
      const skipped = override?.skip === true && !isId;
      planned.push({
        source: column.name,
        target: fieldName,
        sourceType: column.dataType,
        targetType: type,
        defaultType,
        nullable: column.nullable,
        key: isId,
        editable: true,
        skipped,
        ...(isId ? { note: 'The primary key becomes _id' } : {}),
      });
      if (!skipped && isMongoFieldType(type))
        fields.push({ column: column.name, name: fieldName, type });
    }
    if (table !== undefined && idColumn === undefined) {
      tableWarnings.push(
        pk.length > 1
          ? 'The primary key has several columns: each document gets a new ObjectId, the columns stay fields'
          : 'Each document gets a new ObjectId as _id',
      );
    }
    const embeds: Embed[] = [];
    for (const embed of object.embed ?? []) {
      const child = findTable(embed.table);
      const fk = child?.foreignKeys.find((f) => f.name === embed.foreignKey);
      if (
        child === undefined ||
        fk === undefined ||
        table === undefined ||
        fk.refTable !== table.name
      ) {
        tableProblems.push(
          `${embed.table} has no foreign key ${embed.foreignKey} to ${object.name}, so it cannot be embedded`,
        );
        continue;
      }
      const childFields = child.columns
        .filter((c) => !fk.columns.includes(c.name))
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((c) => ({ column: c.name, name: c.name, type: mongoFieldType(c.dataType, dialect) }));
      const columns = [
        ...fk.columns.map((name) => ({
          name,
          dataType: child.columns.find((c) => c.name === name)?.dataType ?? '',
        })),
        ...childFields.map((f) => ({
          name: f.column,
          dataType: child.columns.find((c) => c.name === f.column)?.dataType ?? '',
        })),
      ];
      const field = embed.field?.trim() || embed.table;
      embeds.push({
        table: embed.table,
        field,
        foreignKey: fk.name,
        parentColumns: fk.refColumns,
        childColumns: fk.columns,
        fields: childFields,
        select: `SELECT ${selectList(columns, dialect)} FROM ${qualifiedTable(child.name, dialect, schemaName)}`,
        order: child.primaryKey?.columns ?? fk.columns,
      });
      const missing = fk.refColumns.filter((c) => !table.columns.some((col) => col.name === c));
      if (missing.length > 0) tableProblems.push(`${embed.foreignKey} references missing columns`);
    }
    // The parent columns the embeds join on must be read too.
    const readColumns = [...(table?.columns ?? [])]
      .sort((a, b) => a.ordinal - b.ordinal)
      .filter(
        (c) =>
          fields.some((f) => f.column === c.name) ||
          embeds.some((e) => e.parentColumns.includes(c.name)) ||
          c.name === idColumn,
      );
    const indexes: CollectionLoad['indexes'][number][] = [];
    if (table !== undefined) {
      const fieldOf = new Map(fields.map((f) => [f.column, f.name]));
      const keySets: { columns: string[]; unique: boolean; name: string }[] = [
        ...(idColumn === undefined && table.primaryKey
          ? [{ columns: table.primaryKey.columns, unique: true, name: table.primaryKey.name }]
          : []),
        ...table.uniques.map((u) => ({ columns: u.columns, unique: true, name: u.name })),
        ...table.indexes
          .filter((i) => i.columns.every((c) => c.name !== null) && i.where === undefined)
          .map((i) => ({ columns: i.columns.map((c) => c.name!), unique: i.unique, name: i.name })),
      ];
      for (const set of keySets) {
        const mapped = set.columns.map((c) => fieldOf.get(c));
        if (mapped.some((m) => m === undefined || m === '_id')) continue;
        indexes.push({
          keys: Object.fromEntries(mapped.map((m) => [m!, 1])),
          unique: set.unique,
          name: set.name === 'PRIMARY' ? `${name}_pk` : set.name,
        });
      }
    }
    const count = table !== undefined ? rows.get(table.name) : undefined;
    const plannedTable: PlannedTable = {
      source: object.name,
      target: name,
      kind: 'collection',
      action: exists ? mode : 'create',
      exists,
      ...(count !== undefined ? { rows: count } : {}),
      columns: planned,
      ...(embeds.length > 0
        ? {
            embeds: embeds.map((e) => ({
              table: e.table,
              field: e.field,
              foreignKey: e.foreignKey,
            })),
          }
        : {}),
      problems: tableProblems,
      warnings: tableWarnings,
    };
    problems.push(...tableProblems.map((p) => `${object.name}: ${p}`));
    warnings.push(...tableWarnings.map((w) => `${object.name}: ${w}`));
    if (table === undefined) {
      loads.push({
        planned: plannedTable,
        ns,
        select: '',
        columns: [],
        fields: [],
        idColumn,
        embeds,
        indexes,
      });
      continue;
    }
    before.push({ ns, mode, exists });
    loads.push({
      planned: plannedTable,
      ns,
      select: `SELECT ${selectList(readColumns, dialect)} FROM ${qualifiedTable(table.name, dialect, schemaName)}`,
      columns: readColumns.map((c) => c.name),
      fields,
      idColumn,
      embeds,
      indexes,
    });
  }
  const commands: string[] = [];
  const destructive: string[] = [];
  const creates: string[] = [];
  for (const { ns, mode, exists } of before) {
    if (exists && mode === 'drop-create') {
      commands.push(
        `${shellName(ns)}.drop()`,
        `db.createCollection(${JSON.stringify(ns.collection)})`,
      );
      destructive.push(`Drop collection ${ns.collection} (it exists) and create it again`);
      creates.push(`Create collection ${ns.collection}`);
    } else if (exists && mode === 'truncate') {
      commands.push(`${shellName(ns)}.deleteMany({})`);
      destructive.push(`Empty collection ${ns.collection}: every document in it now is deleted`);
    } else if (!exists) {
      commands.push(`db.createCollection(${JSON.stringify(ns.collection)})`);
      creates.push(`Create collection ${ns.collection}`);
    }
  }
  const after = loads.flatMap((load) =>
    load.indexes.map(
      (index) =>
        `${shellName(load.ns)}.createIndex(${JSON.stringify(index.keys)}, ${JSON.stringify({ name: index.name, ...(index.unique ? { unique: true } : {}) })})`,
    ),
  );
  const plan: TransferPlan = {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    sourceVersion: source.serverVersion,
    targetVersion: target.serverVersion,
    tables: loads.map((l) => l.planned),
    before: commands,
    after,
    destructive,
    creates,
    problems,
    warnings,
  };
  return {
    plan,
    setupSource: utcSession,
    async prepare(session) {
      const mongo = asMongo(session);
      for (const { ns, mode, exists } of before) {
        if (exists && mode === 'drop-create') {
          await mongo.dropCollection(ns);
          await mongo.createCollection(ns);
        } else if (exists && mode === 'truncate') {
          await mongo.deleteMany(ns, '{}');
        } else if (!exists) {
          await mongo.createCollection(ns);
        }
      }
    },
    units: loads
      .filter((l) => l.planned.problems.length === 0)
      .map((l) => collectionUnit(l, dialect)),
  };
}

/** A field name MongoDB accepts at the top level: no leading `$`, no dots, unique, not `_id`. */
function validFieldName(name: string, names: Set<string>): string {
  const cleaned = name.replace(/^\$+/, '_').replace(/\./g, '_') || 'field';
  let candidate = cleaned;
  for (let n = 2; names.has(candidate); n++) candidate = `${cleaned}_${n}`;
  names.add(candidate);
  return candidate;
}

// ---------------------------------------------------------------------------------------------
// MongoDB → SQL

interface TableLoad {
  readonly planned: PlannedTable;
  readonly flat: FlatTable;
  readonly ns: Namespace;
  /** The table loaded into. */
  readonly table: TableDef;
  /** Flat columns loaded (by position in `flat.columns`) and the target column each feeds. */
  readonly loaded: readonly { readonly index: number; readonly target: string }[];
  readonly finish: readonly string[];
  /** The parent table's name and key column, for child tables. */
  readonly parent?: { readonly table: string; readonly key: string };
  /** The collection's `_id` column holds JSON (documents as ids). */
  readonly idJson: boolean;
}

/** Rows of one flat table from a pass over the collection. */
async function* flatRows(
  session: MongoTransferSession,
  load: TableLoad,
  pageSize: number,
  signal: AbortSignal,
): AsyncGenerator<RowBatch> {
  const { flat } = load;
  const columns = load.loaded.map((l) => flat.columns[l.index]!.name);
  const projection =
    flat.arrayPath === undefined
      ? undefined
      : JSON.stringify({ _id: 1, [flat.arrayPath.join('.')]: 1 });
  let row = 0;
  let documentNumber = 0;
  for await (const page of session.find(
    load.ns,
    { filter: '{}', ...(projection !== undefined ? { projection } : {}) },
    { pageSize, signal },
  )) {
    const rows: SourceCell[][] = [];
    const numbers: number[] = [];
    const lines: number[] = [];
    const rejected: RowError[] = [];
    for (const text of page.documents) {
      documentNumber++;
      const document = fromEjson(text, 'document');
      if (!isBsonDocument(document)) continue;
      const cellsFor = (
        element: BsonValue | undefined,
        position: number | undefined,
      ): SourceCell[] =>
        load.loaded.map(({ index }) => {
          const column = flat.columns[index]!;
          if (flat.arrayPath !== undefined && column.name === flat.parentKey) {
            return bsonCell(document['_id'], load.idJson);
          }
          if (flat.arrayPath !== undefined && column.name === flat.position)
            return position ?? null;
          const base = flat.arrayPath === undefined ? document : element;
          const value =
            flat.scalarElements === true
              ? element
              : base === undefined
                ? undefined
                : valueAtPath(base, column.path);
          return bsonCell(value, column.json);
        });
      const push = (element: BsonValue | undefined, position: number | undefined): void => {
        row++;
        try {
          rows.push(cellsFor(element, position));
          numbers.push(row);
          lines.push(documentNumber);
        } catch (error) {
          rejected.push({ row, line: documentNumber, message: messageOf(error) });
        }
      };
      if (flat.arrayPath === undefined) {
        push(undefined, undefined);
        continue;
      }
      const array = valueAtPath(document, flat.arrayPath);
      if (!Array.isArray(array)) continue;
      array.forEach((element, position) => push(element, position));
    }
    yield { columns, rows, rowNumbers: numbers, lines, rejected, bytesRead: 0 };
  }
}

function tableUnit(load: TableLoad, dialect: SqlDialect, schema: string | undefined): TransferUnit {
  return {
    source: load.planned.source,
    target: load.planned.target,
    async load(context: UnitContext): Promise<UnitResult> {
      const source = asMongo(context.source);
      const { options, signal } = context;
      const summary = await importRows({
        session: context.target,
        dialect,
        table: load.table,
        ...(schema !== undefined ? { schema } : {}),
        rows: flatRows(source, load, options.batchSize, signal),
        mapping: load.loaded.map((l) => ({
          source: load.flat.columns[l.index]!.name,
          target: l.target,
        })),
        mode: 'append',
        batchSize: options.batchSize,
        transaction: options.transactionPerBatch ? 'per-batch' : 'none',
        onError: options.onError,
        conversion: { emptyAsNull: false, dateOrder: 'ymd' },
        signal,
        onProgress: (p) =>
          context.progress({ read: p.rowsRead, written: p.rowsWritten, skipped: p.rowsSkipped }),
      });
      return {
        status: summary.status,
        read: summary.rowsRead,
        written: summary.rowsWritten,
        skipped: summary.rowsSkipped,
        errors: summary.errors,
      };
    },
    async finish(context: UnitContext): Promise<void> {
      for (const statement of load.finish) await runStatement(context.target, statement);
    },
  };
}

/** Plans a MongoDB → SQL transfer. */
export async function mongoToSqlExecution(
  spec: DbTransferSpec,
  options: DbTransferOptions,
  sourceSession: Session,
  target: Session,
): Promise<Execution> {
  const source = asMongo(sourceSession);
  const dialect = target.engine as SqlDialect;
  const db = spec.source.database || source.currentDatabase;
  const schemaName = dialect === 'postgres' ? spec.target.schema || 'public' : undefined;
  const snapshot = await target.introspect({
    ...(schemaName ? { schemas: [schemaName] } : {}),
    include: ['table'],
  });
  const targetSchema =
    schemaName === undefined
      ? snapshot.schemas[0]
      : snapshot.schemas.find((s) => s.name === schemaName);
  const findTarget = (name: string): TableDef | undefined =>
    targetSchema?.tables.find((t) => t.name === name) ??
    (dialect === 'postgres'
      ? undefined
      : targetSchema?.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()));
  const loads: TableLoad[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const drops: string[] = [];
  const creates: string[] = [];
  const truncates: string[] = [];
  const destructive: string[] = [];
  const createdWords: string[] = [];
  const foreignKeys: { table: string; refTable: string; sql: string }[] = [];
  const taken = new Set<string>();
  for (const object of spec.objects) {
    const ns = { db, collection: object.name };
    const mode = object.mode ?? options.mode;
    const tableName = fitIdentifier(object.target?.trim() || object.name, dialect);
    const [count, analysis] = await Promise.all([
      source.estimatedCount(ns).catch(() => undefined),
      source.analyzeSchema(ns, { sampleSize: options.sampleSize }),
    ]);
    if (analysis.documentCount === 0) {
      warnings.push(`${object.name}: the collection is empty or missing; only _id is known`);
    }
    const flats = flattenCollection(analysis, {
      collection: object.name,
      table: tableName,
      dialect,
      targetVersion: target.serverVersion,
      ...(object.columns !== undefined ? { overrides: object.columns } : {}),
    });
    const mainId = flats[0]!.columns[0]!;
    for (const flat of flats) {
      const tableProblems: string[] = [];
      const tableWarnings: string[] = [];
      if (taken.has(flat.name.toLowerCase()))
        tableProblems.push(`Two tables are transferred into ${flat.name}`);
      taken.add(flat.name.toLowerCase());
      const existing = findTarget(flat.name);
      if (existing !== undefined && mode === 'create') {
        tableProblems.push(
          `${flat.name} already exists on the target; choose drop and create, truncate or append`,
        );
      }
      for (const column of flat.columns) {
        if (!isSafeDataType(column.dataType))
          tableProblems.push(
            `"${column.dataType}" is not a column type Joinery can use (${column.name})`,
          );
      }
      const intoExisting = existing !== undefined && (mode === 'truncate' || mode === 'append');
      const quoted = qualifiedTable(flat.name, dialect, schemaName);
      let table: TableDef;
      let loaded: { index: number; target: string }[];
      let planned = flat.planned;
      const finish: string[] = [];
      if (intoExisting) {
        table = existing;
        const byName = new Map(
          existing.columns
            .filter((c) => c.generated === undefined)
            .map((c) => [c.name.toLowerCase(), c]),
        );
        loaded = [];
        planned = flat.planned.map((p) => {
          if (p.target === '' || p.skipped) return p;
          const match = byName.get(p.target.toLowerCase());
          if (match === undefined)
            return {
              ...p,
              skipped: true,
              editable: false,
              note: `${flat.name} has no column ${p.target}`,
            };
          return { ...p, target: match.name, targetType: match.dataType, editable: false };
        });
        flat.columns.forEach((column, index) => {
          const match = byName.get(column.name.toLowerCase());
          if (match !== undefined) loaded.push({ index, target: match.name });
        });
      } else {
        const columns: ColumnDef[] = flat.columns.map((c, i) => ({
          name: c.name,
          ordinal: i + 1,
          dataType: c.dataType,
          nullable: c.nullable,
          default: null,
          autoIncrement: false,
        }));
        const primaryKey = {
          name: dialect === 'postgres' ? fitIdentifier(`${flat.name}_pkey`, dialect) : 'PRIMARY',
          columns: [...flat.primaryKey],
        };
        const full = tableDefSchema.parse({
          name: flat.name,
          columns,
          primaryKey,
          options: dialect === 'postgres' ? {} : { charset: 'utf8mb4' },
        });
        const deferPk = dialect === 'postgres' && options.deferConstraints;
        table = deferPk ? { ...full, primaryKey: undefined } : full;
        if (deferPk)
          finish.push(`ALTER TABLE ${quoted} ADD ${renderPrimaryKey(primaryKey, dialect)}`);
        loaded = flat.columns.map((c, index) => ({ index, target: c.name }));
        if (tableProblems.length === 0) {
          creates.push(
            ...renderTableStatements(table, dialect, {
              ...(schemaName !== undefined && dialect === 'postgres' ? { schema: schemaName } : {}),
              includeForeignKeys: false,
            }),
          );
        }
        if (flat.parentKey !== undefined) {
          foreignKeys.push({
            table: flat.name,
            refTable: tableName,
            sql: `ALTER TABLE ${quoted} ADD ${renderForeignKey(
              {
                name: fitIdentifier(`${flat.name}_${flat.parentKey}_fkey`, dialect),
                columns: [flat.parentKey],
                refTable: tableName,
                refColumns: [mainId.name],
                onUpdate: 'NO ACTION',
                onDelete: 'CASCADE',
              },
              dialect,
              schemaName,
            )}`,
          });
        }
      }
      if (existing !== undefined && mode === 'drop-create') {
        drops.push(quoted);
        destructive.push(`Drop table ${flat.name} (it exists) and create it again`);
      }
      if (existing !== undefined && mode === 'truncate') {
        truncates.push(quoted);
        destructive.push(`Empty table ${flat.name}: every row in it now is deleted`);
      }
      if (!intoExisting) createdWords.push(`Create table ${flat.name}`);
      const plannedTable: PlannedTable = {
        source: flat.source,
        target: flat.name,
        kind: flat.arrayPath === undefined ? 'table' : 'child-table',
        ...(flat.arrayPath !== undefined ? { parent: tableName } : {}),
        action: existing === undefined ? 'create' : mode,
        exists: existing !== undefined,
        ...(flat.arrayPath === undefined && count !== undefined ? { rows: count } : {}),
        columns: planned,
        problems: tableProblems,
        warnings: tableWarnings,
      };
      problems.push(...tableProblems.map((p) => `${flat.source}: ${p}`));
      loads.push({
        planned: plannedTable,
        flat,
        ns,
        table,
        loaded,
        finish,
        ...(flat.parentKey !== undefined
          ? { parent: { table: tableName, key: flat.parentKey } }
          : {}),
        idJson: mainId.json,
      });
    }
  }
  const before: string[] = [];
  if (dialect === 'postgres' && schemaName !== undefined && targetSchema === undefined) {
    before.push(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName, 'postgres')}`);
  }
  if (drops.length > 0) {
    if (dialect === 'postgres') before.push(`DROP TABLE ${drops.join(', ')}`);
    else for (const name of drops) before.push(`DROP TABLE ${name}`);
  }
  before.push(...creates);
  if (truncates.length > 0) {
    if (dialect === 'postgres') before.push(`TRUNCATE TABLE ${truncates.join(', ')}`);
    else for (const name of truncates) before.push(`TRUNCATE TABLE ${name}`);
  }
  const plan: TransferPlan = {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    sourceVersion: source.serverVersion,
    targetVersion: target.serverVersion,
    tables: loads.map((l) => l.planned),
    before,
    after: [...loads.flatMap((l) => l.finish), ...foreignKeys.map((f) => f.sql)],
    destructive,
    creates: createdWords,
    problems,
    warnings,
  };
  return {
    plan,
    async setupTarget(session, context: ExecutionContext) {
      await utcSession(session);
      return context.options.disableConstraints ? relaxConstraints(session, context) : undefined;
    },
    async prepare(session) {
      const restore =
        dialect === 'postgres'
          ? undefined
          : await relaxConstraints(session, { log: () => undefined });
      try {
        for (const statement of before) await runStatement(session, statement);
      } finally {
        await restore?.();
      }
    },
    units: loads
      .filter((l) => l.planned.problems.length === 0)
      .map((l) => tableUnit(l, dialect, schemaName)),
    async complete(session, completed): Promise<DbTransferError[]> {
      const errors: DbTransferError[] = [];
      for (const fk of foreignKeys) {
        if (!completed.has(fk.table) || !completed.has(fk.refTable)) continue;
        try {
          await runStatement(session, fk.sql);
        } catch (error) {
          errors.push({
            table: fk.table,
            message: `A foreign key could not be added: ${messageOf(error)}`,
          });
        }
      }
      return errors;
    },
  };
}
