import {
  QuerybaraError,
  toErrorData,
  type SchemaSnapshot,
  type Session,
  type SqlDialect,
} from '@querybara/core';
import { formatStatements } from '@querybara/sync';
import { gzipSink, type Sink } from '@querybara/transfer';

import type { BackupObject, Manifest } from '../archive/manifest';
import { ArchiveWriter } from '../archive/writer';
import { safeName } from '../common';
import { refMatches, resolveSelection } from '../selection';
import type {
  BackupCommonOptions,
  BackupProgress,
  BackupSelection,
  BackupSummary,
  TransferStatus,
} from '../types';
import { Pacer, isCancel, plural, throwIfAborted } from '../util';
import { streamTableData, tableData, type TableData } from './data';
import { collectExtras, type ObjectExtras } from './extras';
import { planSqlObjects, type SqlObject } from './objects';
import {
  beginSnapshot,
  currentDatabase,
  dialectOf,
  lockTables,
  nonTransactionalTables,
  prepareSession,
  type SnapshotHandle,
  type SnapshotMode,
} from './session';

/**
 * The app-native logical backup of MySQL, MariaDB and PostgreSQL (spec §14): no external tools,
 * one consistent snapshot, DDL from the structure sync renderers in dependency order, data as
 * batched INSERTs streamed straight from the cursor into the output.
 *
 * `sql` and `sql-gz` write one script that any client can run (DDL, then rows, then foreign
 * keys, triggers and events, then privileges). `qbak` writes the Querybara archive: a DDL file per
 * object and a data file per table, which allows selective restore, optionally encrypted.
 */

export interface SqlBackupOptions extends BackupCommonOptions {
  readonly session: Session;
  readonly selection?: BackupSelection;
  /** Object definitions (default true). */
  readonly structure?: boolean;
  /** Table rows, sequence positions and materialised view contents (default true). */
  readonly data?: boolean;
  /** Privileges on the backed-up objects (default false). */
  readonly grants?: boolean;
  /** Keep owners and MySQL DEFINERs (default false: the restoring user owns everything). */
  readonly ownership?: boolean;
  /** Read everything in one snapshot (default true). */
  readonly consistent?: boolean;
  /** PostgreSQL: SERIALIZABLE, READ ONLY, DEFERRABLE instead of REPEATABLE READ. */
  readonly deferrable?: boolean;
  /** Rows per INSERT (default 500). */
  readonly rowsPerStatement?: number;
}

/** The statements of one object in an archive's DDL file. */
export interface ObjectStatements {
  readonly pre?: readonly string[];
  /** After the rows: sequence positions, materialised view refreshes. */
  readonly data?: readonly string[];
  readonly post?: readonly string[];
  /** Privileges; failures are warnings. */
  readonly grants?: readonly string[];
}

/** An object with everything the backup adds to it. */
interface FinalObject {
  readonly object: SqlObject;
  readonly statements: ObjectStatements;
  /** Tables whose rows are backed up. */
  readonly data?: TableData;
}

/** Session settings at the top of a plain SQL backup, so it restores the same anywhere. */
export function scriptPreamble(dialect: SqlDialect): string[] {
  if (dialect === 'postgres') {
    return [
      'SET statement_timeout = 0',
      'SET lock_timeout = 0',
      "SET client_encoding = 'UTF8'",
      'SET standard_conforming_strings = on',
      'SET check_function_bodies = false',
      'SET client_min_messages = warning',
      "SET DateStyle = 'ISO, YMD'",
      "SET IntervalStyle = 'postgres'",
      "SELECT pg_catalog.set_config('search_path', '', false)",
    ];
  }
  return [
    '/*!40101 SET NAMES utf8mb4 */',
    "SET time_zone = '+00:00'",
    'SET foreign_key_checks = 0',
    'SET unique_checks = 0',
    "SET sql_mode = 'NO_AUTO_VALUE_ON_ZERO'",
    'SET sql_notes = 0',
  ];
}

function scriptEpilogue(dialect: SqlDialect): string[] {
  return dialect === 'postgres' ? [] : ['SET foreign_key_checks = 1', 'SET unique_checks = 1'];
}

function invalid(message: string): QuerybaraError {
  return new QuerybaraError({ code: 'VALIDATION_FAILED', message });
}

function comment(text: string): string {
  return `-- ${text.replace(/[\r\n]+/g, ' ')}\n`;
}

export async function backupSql(options: SqlBackupOptions): Promise<BackupSummary> {
  const { session, signal } = options;
  const dialect = dialectOf(session);
  const structure = options.structure !== false;
  const withData = options.data !== false;
  if (!structure && !withData) throw invalid('Choose the structure, the data, or both');
  if (options.encryption && options.format !== 'qbak') {
    throw invalid('Encryption needs the Querybara archive format (.qbak)');
  }
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const warnings: string[] = [];
  const log = options.onLog ?? (() => undefined);
  const warn = (message: string): void => {
    warnings.push(message);
    log('warning', message);
  };
  let bytes = 0;
  let rows = 0;
  let done = 0;
  let total = 0;
  let current: string | undefined;
  let phase = 'Reading the structure';
  const progress = (force = false): void => {
    if (!options.onProgress || !pacer.due(force)) return;
    const event: BackupProgress = {
      phase,
      ...(current !== undefined ? { object: current } : {}),
      objectsDone: done,
      objectsTotal: total,
      rows,
      bytes,
      elapsedMs: pacer.elapsedMs,
    };
    options.onProgress(event);
  };
  const counted: Sink = {
    write: async (chunk) => {
      await options.output.write(chunk);
      bytes += chunk.length;
    },
    close: () => options.output.close(),
    abort: (reason) => options.output.abort(reason),
  };

  let snapshotHandle: SnapshotHandle | undefined;
  let archive: ArchiveWriter | undefined;
  let script: Sink | undefined;
  let manifest: Manifest | undefined;
  let status: TransferStatus = 'completed';
  let error: QuerybaraError | undefined;
  let objectCount = 0;
  let dataCount = 0;
  try {
    progress(true);
    await prepareSession(session, 'backup', signal);
    const database = await currentDatabase(session);
    snapshotHandle = await beginSnapshot(session, options, signal);
    const snapshotMode: SnapshotMode = snapshotHandle.mode;
    const schemas = options.selection?.schemas;
    const snapshot: SchemaSnapshot = await session.introspect(
      dialect === 'postgres' && schemas !== undefined && schemas.length > 0 ? { schemas } : {},
    );
    throwIfAborted(signal);

    const plan = planSqlObjects(snapshot, { ownership: options.ownership === true });
    for (const message of plan.warnings) warn(message);
    const selection = options.selection;
    const chosen = resolveSelection(plan.objects, {
      ...(selection?.include !== undefined && selection.include.length > 0
        ? { include: (o) => selection.include!.some((ref) => refMatches(o, ref)) }
        : {}),
      ...(selection?.exclude !== undefined && selection.exclude.length > 0
        ? { exclude: (o) => selection.exclude!.some((ref) => refMatches(o, ref)) }
        : {}),
    });
    const byId = new Map(plan.objects.map((o) => [o.id, o]));
    for (const id of chosen.added) {
      log('info', `Also backing up ${byId.get(id)!.qualifiedName}, which the selection needs`);
    }
    for (const skip of chosen.skipped) {
      warn(`${byId.get(skip.id)?.qualifiedName ?? skip.id} is left out: ${skip.reason}`);
    }
    const objects = chosen.ids.map((id) => byId.get(id)!);
    const noData = (o: SqlObject): boolean =>
      selection?.excludeData?.some((ref) => refMatches(o, ref)) === true;
    const tables = objects.filter((o) => o.kind === 'table' && o.table !== undefined);
    const dataTables = withData ? tables.filter((o) => !noData(o)) : [];

    if (snapshotMode === 'consistent-snapshot') {
      const loose = nonTransactionalTables(dataTables.map((o) => o.table!));
      if (loose.length > 0) {
        warn(
          `The consistent snapshot does not cover tables without transactions; their rows may not match the rest: ${loose.join(', ')}`,
        );
      }
    }
    await lockTables(
      session,
      dataTables.map((o) => ({
        ...(o.schema !== undefined ? { schema: o.schema } : {}),
        table: o.table!,
      })),
      signal,
    );

    const schemaNames =
      dialect === 'postgres' ? [...new Set(snapshot.schemas.map((s) => s.name))] : [];
    const extras: ObjectExtras = await collectExtras(session, dialect, objects, {
      data: withData,
      grants: options.grants === true,
      schemas: schemaNames,
    });
    const finals: FinalObject[] = [...objects, ...extras.extraObjects].map((object) => {
      const statements: ObjectStatements = {
        ...(structure && object.pre.length > 0 ? { pre: object.pre } : {}),
        ...(extras.data.has(object.id) ? { data: extras.data.get(object.id)! } : {}),
        ...(structure && object.post.length > 0 ? { post: object.post } : {}),
        ...(extras.grants.has(object.id) ? { grants: extras.grants.get(object.id)! } : {}),
      };
      const data =
        dataTables.includes(object) && object.table
          ? tableData(dialect, object.table, object.schema)
          : undefined;
      return { object, statements, ...(data !== undefined ? { data } : {}) };
    });
    total = finals.length + dataTables.length;
    objectCount = finals.length;
    dataCount = dataTables.length;
    log(
      'info',
      `Backing up ${plural(finals.length, 'object')} of ${database}${dataTables.length > 0 ? `, with the rows of ${plural(dataTables.length, 'table')}` : ''}`,
    );

    const streamData = async (final: FinalObject, write: (text: string) => Promise<void>) => {
      current = final.object.qualifiedName;
      phase = 'Backing up data';
      progress(true);
      const before = rows;
      const count = await streamTableData(session, dialect, final.data!, write, {
        rowsPerStatement: options.rowsPerStatement ?? 500,
        ...(signal !== undefined ? { signal } : {}),
        onRows: (n) => {
          rows = before + n;
          progress();
        },
      });
      rows = before + count;
      done++;
      return count;
    };

    if (options.format === 'qbak') {
      archive = await ArchiveWriter.create({
        sink: counted,
        ...(options.compress !== undefined ? { compress: options.compress } : {}),
        ...(options.encryption ? { encryption: options.encryption } : {}),
      });
      const included = new Set(finals.map((f) => f.object.id));
      const manifestObjects: BackupObject[] = [];
      phase = 'Writing the structure';
      for (const [index, final] of finals.entries()) {
        throwIfAborted(signal);
        const { object } = final;
        current = object.qualifiedName;
        const prefix = String(index + 1).padStart(4, '0');
        const ddl = `ddl/${prefix}-${object.kind}-${safeName(object.qualifiedName)}.json`;
        await archive.add(ddl, 'application/json', JSON.stringify(final.statements));
        manifestObjects.push({
          id: object.id,
          kind: object.kind,
          ...(object.schema !== undefined ? { schema: object.schema } : {}),
          name: object.name,
          qualifiedName: object.qualifiedName,
          ...(object.parent !== undefined && included.has(object.parent)
            ? { parent: object.parent }
            : {}),
          dependsOn: object.dependsOn.filter((d) => included.has(d)),
          ddl,
        });
        done++;
        progress();
      }
      for (const [index, final] of finals.entries()) {
        if (!final.data) continue;
        throwIfAborted(signal);
        const prefix = String(index + 1).padStart(4, '0');
        const name = `data/${prefix}-${safeName(final.object.qualifiedName)}.sql`;
        const entry = archive.entry(name, 'application/sql');
        const count = await streamData(final, (text) => entry.write(text));
        await entry.close();
        const at = manifestObjects.findIndex((o) => o.id === final.object.id);
        manifestObjects[at] = {
          ...manifestObjects[at]!,
          data: { entry: name, count, columns: [...final.data.columns] },
        };
      }
      phase = 'Finishing';
      current = undefined;
      manifest = await archive.finish({
        createdAt: new Date().toISOString(),
        producer: options.producer ?? 'Querybara',
        engine: session.engine,
        serverVersion: session.serverVersion,
        database,
        databaseOptions: { ...snapshot.options },
        options: {
          structure,
          data: withData,
          grants: options.grants === true,
          ownership: options.ownership === true,
          snapshot: snapshotMode,
          compression: archive.compressed ? 'gzip' : 'none',
          encrypted: archive.encrypted,
          rowsPerStatement: options.rowsPerStatement ?? 500,
        },
        objects: manifestObjects,
        warnings,
      });
    } else {
      script = options.format === 'sql-gz' ? gzipSink(counted) : counted;
      const out = script;
      const write = (text: string): Promise<void> =>
        text.length === 0 ? Promise.resolve() : out.write(Buffer.from(text, 'utf8'));
      const block = (statements: readonly string[]): string =>
        statements.length === 0 ? '' : `${formatStatements(statements, dialect)}\n`;
      await write(
        [
          comment(`Querybara backup of ${database} (${session.engine} ${session.serverVersion})`),
          comment(`Created ${new Date().toISOString()}; snapshot: ${snapshotMode}`),
          comment(
            `${plural(finals.length, 'object')}${dataTables.length > 0 ? `; rows of ${plural(dataTables.length, 'table')}` : ''}`,
          ),
          '\n',
          block(scriptPreamble(dialect)),
          '\n',
        ].join(''),
      );
      phase = 'Writing the structure';
      for (const final of finals) {
        const pre = final.statements.pre ?? [];
        done++;
        if (pre.length === 0) continue;
        await write(
          `${comment(`${final.object.kind} ${final.object.qualifiedName}`)}${block(pre)}\n`,
        );
      }
      for (const final of finals) {
        if (!final.data) continue;
        throwIfAborted(signal);
        await write(comment(`Data for ${final.object.qualifiedName}`));
        await streamData(final, write);
        await write('\n');
      }
      for (const key of ['data', 'post', 'grants'] as const) {
        for (const final of finals) {
          const list = final.statements[key] ?? [];
          if (list.length === 0) continue;
          const what =
            key === 'data' ? 'State of' : key === 'grants' ? 'Privileges on' : final.object.kind;
          await write(`${comment(`${what} ${final.object.qualifiedName}`)}${block(list)}\n`);
        }
      }
      done = total;
      await write(block(scriptEpilogue(dialect)));
      phase = 'Finishing';
      current = undefined;
    }
    await snapshotHandle.end();
    snapshotHandle = undefined;
    if (script) await script.close();
  } catch (caught) {
    status = isCancel(caught, signal) ? 'cancelled' : 'failed';
    error =
      caught instanceof QuerybaraError
        ? caught
        : new QuerybaraError(toErrorData(caught), { cause: caught });
    await snapshotHandle?.end().catch(() => undefined);
    if (archive) await archive.abort(caught);
    else if (script) await script.abort(caught).catch(() => undefined);
    else await options.output.abort(caught).catch(() => undefined);
  }
  progress(true);
  return {
    status,
    format: options.format,
    objects: objectCount,
    dataObjects: dataCount,
    rows,
    bytesWritten: bytes,
    durationMs: pacer.elapsedMs,
    warnings,
    ...(error !== undefined && status === 'failed' ? { error: error.toJSON() } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  };
}
