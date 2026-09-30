import { JoineryError, newId, toErrorData, type Session, type SqlDialect } from '@joinery/core';
import { StatementSplitter } from '@joinery/sql-tools';
import { decodeSource, fileSource, runSqlFile, type ByteSource } from '@joinery/transfer';

import type { BackupObject } from '../archive/manifest';
import type { ArchiveReader } from '../archive/reader';
import { checkConfirmed } from '../common';
import { resolveSelection } from '../selection';
import type {
  RestoreCommonOptions,
  RestoreConflict,
  RestoreError,
  RestoreProgress,
  RestoreSummary,
  TransferStatus,
} from '../types';
import { Pacer, errorMessage, excerpt, isCancel, plural, queryRows, throwIfAborted } from '../util';
import type { ObjectStatements } from './backup';
import { planSqlObjects, type SqlObject } from './objects';
import { dialectOf, isMariaDb, prepareSession } from './session';

/**
 * Restores of SQL backups (spec §14): everything or selected objects of a Joinery archive, or a
 * plain SQL script, into the session's database (which may have another name than the source).
 *
 * The write rules are enforced here, in the process that runs the statements: objects that
 * already exist in the target make the restore destructive (they are dropped first, never with
 * CASCADE), and a restore that would drop anything refuses to start unless the caller confirmed
 * exactly those objects. PostgreSQL restores run in one transaction, so a failed restore that
 * stops leaves the target as it was; MySQL DDL cannot be rolled back.
 */

export interface SqlRestorePlanOptions {
  readonly session: Session;
  readonly archive: ArchiveReader;
  /** Object ids to restore (default all); what they need comes along. */
  readonly select?: readonly string[];
  /** Restore definitions (default: when the backup has them). */
  readonly structure?: boolean;
  /** Restore rows (default: when the backup has them). */
  readonly data?: boolean;
}

export interface SqlRestorePlan {
  /** Objects to restore, in creation order. */
  readonly objects: readonly BackupObject[];
  /** Ids restored because a selected object needs them. */
  readonly added: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Objects that exist in the target: dropped first (structure) or appended to (data only). */
  readonly conflicts: readonly RestoreConflict[];
  /** Ids whose CREATE is left out because the target already has them (schemas, extensions). */
  readonly existing: readonly string[];
  /** DROP statements for the conflicts, in the order they run. */
  readonly drops: readonly string[];
  readonly structure: boolean;
  readonly data: boolean;
  readonly warnings: readonly string[];
}

function family(engine: string): string {
  return engine === 'mariadb' ? 'mysql' : engine;
}

/** Checks that an archive can go into this session's engine. */
export function checkCompatible(archiveEngine: string, session: Session): string[] {
  const target = session.engine === 'mysql' && isMariaDb(session) ? 'mariadb' : session.engine;
  if (family(archiveEngine) !== family(target)) {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `This is a ${archiveEngine} backup; it cannot be restored into ${target}`,
      hint: 'Use the data transfer wizard to move data between engines',
    });
  }
  return archiveEngine !== target
    ? [
        `The backup comes from ${archiveEngine} and is restored into ${target}; some types or options may differ`,
      ]
    : [];
}

const SKIP_IF_EXISTS = new Set(['schema', 'extension']);
const DROPPABLE = new Set([
  'table',
  'view',
  'materialized-view',
  'sequence',
  'type',
  'routine',
  'trigger',
  'event',
]);

/** Works out what a restore will create, skip, drop and append to. */
export async function planSqlRestore(options: SqlRestorePlanOptions): Promise<SqlRestorePlan> {
  const { session, archive } = options;
  const manifest = archive.manifest;
  const warnings = checkCompatible(manifest.engine, session);
  const hasStructure = manifest.options['structure'] !== false;
  const hasData = manifest.options['data'] !== false;
  const structure = options.structure ?? hasStructure;
  const data = options.data ?? hasData;
  if (structure && !hasStructure)
    warnings.push('The backup holds no definitions; only rows are restored');
  if (!structure && !data) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Nothing to restore' });
  }
  const selected = options.select !== undefined ? new Set(options.select) : undefined;
  if (selected) {
    const unknown = [...selected].filter((id) => !manifest.objects.some((o) => o.id === id));
    if (unknown.length > 0) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: `The backup has no object ${unknown[0]}`,
      });
    }
  }
  const chosen = resolveSelection(manifest.objects, {
    ...(selected ? { include: (o) => selected.has(o.id) } : {}),
  });
  const byId = new Map(manifest.objects.map((o) => [o.id, o]));
  const objects = chosen.ids.map((id) => byId.get(id)!);

  // What the target already has, planned the same way so the ids line up.
  const dialect = dialectOf(session);
  const schemas = [
    ...new Set(objects.map((o) => o.schema ?? (o.kind === 'schema' ? o.name : undefined))),
  ].filter((s): s is string => s !== undefined);
  const snapshot = await session.introspect(
    dialect === 'postgres' ? { schemas: schemas.length > 0 ? schemas : ['public'] } : {},
  );
  const target = planSqlObjects(snapshot);
  const targetById = new Map(target.objects.map((o) => [o.id, o]));
  const extensions = new Set(snapshot.extensions.map((e) => e.name));
  const schemaNames = new Set(snapshot.schemas.map((s) => s.name));

  const existing: string[] = [];
  const conflicts: RestoreConflict[] = [];
  const skipped = [...chosen.skipped];
  const conflicting = new Set<string>();
  const kept: BackupObject[] = [];
  for (const object of objects) {
    const present =
      object.kind === 'schema'
        ? schemaNames.has(object.name)
        : object.kind === 'extension'
          ? extensions.has(object.name)
          : targetById.has(object.id);
    if (structure) {
      if (!present) {
        kept.push(object);
        continue;
      }
      if (SKIP_IF_EXISTS.has(object.kind)) {
        existing.push(object.id);
        kept.push(object);
        continue;
      }
      if (object.parent !== undefined && conflicting.has(object.parent)) {
        kept.push(object);
        continue;
      }
      if (DROPPABLE.has(object.kind) && targetById.get(object.id)?.drop !== undefined) {
        conflicting.add(object.id);
        conflicts.push({
          id: object.id,
          kind: object.kind,
          qualifiedName: object.qualifiedName,
          action: 'drop',
        });
        kept.push(object);
      } else {
        existing.push(object.id);
        kept.push(object);
        warnings.push(`${object.qualifiedName} already exists in the target and is kept as it is`);
      }
    } else {
      if (object.data === undefined) {
        kept.push(object);
        continue;
      }
      if (!present) {
        skipped.push({ id: object.id, reason: 'the table does not exist in the target' });
        continue;
      }
      conflicts.push({
        id: object.id,
        kind: object.kind,
        qualifiedName: object.qualifiedName,
        action: 'append',
      });
      kept.push(object);
    }
  }
  // Dependents first: the target's creation order, reversed. A replaced table's triggers and
  // foreign keys go explicitly, before the functions and tables they reference.
  const drops = target.objects
    .filter(
      (o: SqlObject) =>
        o.drop !== undefined &&
        (conflicting.has(o.id) || (o.parent !== undefined && conflicting.has(o.parent))),
    )
    .reverse()
    .map((o) => o.drop!);
  return {
    objects: kept,
    added: chosen.added,
    skipped,
    conflicts,
    existing,
    drops,
    structure,
    data: data && hasData,
    warnings,
  };
}

export interface SqlRestoreOptions extends RestoreCommonOptions, SqlRestorePlanOptions {
  /**
   * The conflicts the user confirmed (ids from the plan). The restore refuses to start when the
   * target has conflicts that are not all confirmed.
   */
  readonly confirmedConflicts?: readonly string[];
  /** PostgreSQL: one transaction for the whole restore (default true). */
  readonly singleTransaction?: boolean;
}

class Stop extends Error {}

/** Restores a Joinery archive of a SQL database. */
export async function restoreSqlArchive(options: SqlRestoreOptions): Promise<RestoreSummary> {
  const { session, archive, signal } = options;
  const dialect: SqlDialect = dialectOf(session);
  const pg = dialect === 'postgres';
  const onError = options.onError ?? 'stop';
  const errorLogLimit = options.errorLogLimit ?? 1000;
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const log = options.onLog ?? (() => undefined);
  const errors: RestoreError[] = [];
  const warnings: string[] = [];
  let statements = 0;
  let failed = 0;
  let rows = 0;
  let bytes = 0;
  let totalBytes = 0;
  let done = 0;
  let total = 0;
  let phase = 'Planning';
  let current: string | undefined;
  const progress = (force = false): void => {
    if (!options.onProgress || !pacer.due(force)) return;
    const event: RestoreProgress = {
      phase,
      ...(current !== undefined ? { object: current } : {}),
      objectsDone: done,
      objectsTotal: total,
      rows,
      statements,
      failed,
      bytes,
      ...(totalBytes > 0 ? { totalBytes } : {}),
      elapsedMs: pacer.elapsedMs,
    };
    options.onProgress(event);
  };

  const transaction = pg && options.singleTransaction !== false;
  const guard = async (sql: string): Promise<void> => {
    for await (const _chunk of session.execute(sql, { executionId: newId() })) {
      // drained
    }
  };
  /** Runs one statement under the error policy; `soft` failures are only warnings. */
  const run = async (sql: string, object: string | undefined, soft = false): Promise<void> => {
    throwIfAborted(signal);
    statements++;
    const savepoint = transaction && (soft || onError === 'continue');
    if (savepoint) await guard('SAVEPOINT joinery_restore');
    try {
      for await (const chunk of session.execute(sql, {
        executionId: newId(),
        ...(signal !== undefined ? { signal } : {}),
      })) {
        if (chunk.type === 'status' && chunk.rowsAffected !== null && /^\s*insert/i.test(sql)) {
          rows += chunk.rowsAffected;
        }
      }
      if (savepoint) await guard('RELEASE SAVEPOINT joinery_restore');
    } catch (error) {
      if (isCancel(error, signal)) throw error;
      if (savepoint) await guard('ROLLBACK TO SAVEPOINT joinery_restore');
      if (soft) {
        const message = `${object ?? 'A statement'}: ${errorMessage(error)}`;
        warnings.push(message);
        log('warning', message);
        return;
      }
      failed++;
      if (errors.length < errorLogLimit) {
        errors.push({
          ...(object !== undefined ? { object } : {}),
          statement: statements,
          message: errorMessage(error),
          text: excerpt(sql),
        });
      }
      log('error', `${object ?? 'Statement'}: ${errorMessage(error)}`);
      if (onError === 'stop') throw new Stop();
    }
    progress();
  };

  let status: TransferStatus = 'completed';
  let fatal: JoineryError | undefined;
  let objectsRestored = 0;
  try {
    await prepareSession(session, 'restore', signal);
    const plan = await planSqlRestore(options);
    for (const message of plan.warnings) {
      warnings.push(message);
      log('warning', message);
    }
    for (const skip of plan.skipped) {
      const message = `${skip.id} is not restored: ${skip.reason}`;
      warnings.push(message);
      log('warning', message);
    }
    checkConfirmed(plan.conflicts, options.confirmedConflicts);
    const existing = new Set(plan.existing);
    const statementsOf = new Map<string, ObjectStatements>();
    for (const object of plan.objects) {
      if (object.ddl === undefined) continue;
      statementsOf.set(object.id, (await archive.json(object.ddl)) as ObjectStatements);
    }
    const dataObjects = plan.data ? plan.objects.filter((o) => o.data !== undefined) : [];
    totalBytes = dataObjects.reduce((sum, o) => sum + (archive.entry(o.data!.entry)?.size ?? 0), 0);
    total = plan.objects.length;
    objectsRestored = plan.objects.length;
    log(
      'info',
      `Restoring ${plural(plan.objects.length, 'object')}${dataObjects.length > 0 ? ` with the rows of ${plural(dataObjects.length, 'table')}` : ''} into ${plan.drops.length > 0 ? `a database where ${plural(plan.drops.length, 'object')} is replaced` : 'the database'}`,
    );

    if (transaction) await guard('BEGIN');
    phase = 'Dropping replaced objects';
    progress(true);
    for (const sql of plan.drops) await run(sql, undefined);

    if (plan.structure) {
      phase = 'Creating objects';
      for (const object of plan.objects) {
        current = object.qualifiedName;
        if (!existing.has(object.id)) {
          for (const sql of statementsOf.get(object.id)?.pre ?? [])
            await run(sql, object.qualifiedName);
        }
        if (object.data === undefined) done++;
        progress();
      }
    }

    phase = 'Restoring data';
    for (const object of dataObjects) {
      current = object.qualifiedName;
      progress(true);
      const perTable = !pg;
      if (perTable) await guard('START TRANSACTION');
      const splitter = new StatementSplitter(dialect);
      const counted: ByteSource = {
        async *[Symbol.asyncIterator]() {
          for await (const chunk of archive.read(object.data!.entry)) {
            bytes += chunk.length;
            yield chunk;
          }
        },
      };
      try {
        for await (const text of decodeSource(counted, 'utf-8')) {
          for (const statement of splitter.push(text))
            await run(statement.text, object.qualifiedName);
        }
        for (const statement of splitter.end()) await run(statement.text, object.qualifiedName);
        if (perTable) await guard('COMMIT');
      } catch (error) {
        if (perTable) await guard('ROLLBACK').catch(() => undefined);
        throw error;
      }
      done++;
    }

    if (plan.data) {
      phase = 'Restoring sequence positions';
      for (const object of plan.objects) {
        for (const sql of statementsOf.get(object.id)?.data ?? [])
          await run(sql, object.qualifiedName);
      }
    }
    if (plan.structure) {
      phase = 'Adding keys, triggers and events';
      for (const object of plan.objects) {
        current = object.qualifiedName;
        if (existing.has(object.id)) continue;
        for (const sql of statementsOf.get(object.id)?.post ?? [])
          await run(sql, object.qualifiedName);
      }
      phase = 'Granting privileges';
      for (const object of plan.objects) {
        for (const sql of statementsOf.get(object.id)?.grants ?? []) {
          await run(sql, object.qualifiedName, true);
        }
      }
    }
    current = undefined;
    if (transaction) await guard('COMMIT');
    if (!pg) {
      await guard('SET foreign_key_checks = 1');
      await guard('SET unique_checks = 1');
    }
    if (failed > 0) log('warning', `${plural(failed, 'statement')} failed and were skipped`);
  } catch (error) {
    if (error instanceof Stop) status = 'failed';
    else if (isCancel(error, signal)) status = 'cancelled';
    else {
      status = 'failed';
      fatal = error instanceof JoineryError ? error : new JoineryError(toErrorData(error));
      log('error', fatal.message);
    }
    if (session.inTransaction) await guard('ROLLBACK').catch(() => undefined);
    if (!pg) await guard('SET foreign_key_checks = 1').catch(() => undefined);
    if (status === 'failed' && transaction) {
      log('info', 'The restore was rolled back; the database is as it was');
    }
  }
  phase = status === 'completed' ? 'Done' : 'Stopped';
  progress(true);
  return {
    status,
    objects: status === 'completed' ? objectsRestored : done,
    rows,
    statements,
    failed,
    errors,
    warnings,
    durationMs: pacer.elapsedMs,
    ...(fatal !== undefined ? { error: fatal.toJSON() } : {}),
  };
}

export interface SqlScriptRestoreOptions extends RestoreCommonOptions {
  readonly session: Session;
  /** The .sql or .sql.gz file. */
  readonly path: string;
  /** `['database']` when the target has objects and the user agreed to run the script anyway. */
  readonly confirmedConflicts?: readonly string[];
  readonly singleTransaction?: boolean;
}

/**
 * A script (ours, or one from mysqldump with its DROP TABLE statements) may replace what the
 * database holds, so a database that is not empty is one conflict to confirm.
 */
export async function scriptConflicts(session: Session): Promise<RestoreConflict[]> {
  const count = await countObjects(session);
  return count > 0
    ? [
        {
          id: 'database',
          kind: 'database',
          qualifiedName: `the ${plural(count, 'object')} already in the database`,
          action: 'overwrite',
        },
      ]
    : [];
}

/** Objects in the session's database (non-system schemas on PostgreSQL). */
export async function countObjects(session: Session): Promise<number> {
  const pg = dialectOf(session) === 'postgres';
  const rows = await queryRows(
    session,
    pg
      ? `SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`
      : `SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`,
  );
  return Number(rows[0]?.[0] ?? 0);
}

/**
 * Restores a plain SQL backup (.sql or .sql.gz) statement by statement, streaming through the
 * editor's splitter. The script may create objects that exist already, so a target that is not
 * empty needs the caller's confirmation.
 */
export async function restoreSqlScript(options: SqlScriptRestoreOptions): Promise<RestoreSummary> {
  const { session } = options;
  const pg = dialectOf(session) === 'postgres';
  const started = performance.now();
  await prepareSession(session, 'restore', options.signal);
  checkConfirmed(await scriptConflicts(session), options.confirmedConflicts);
  const summary = await runSqlFile({
    session,
    source: fileSource(options.path),
    decompress: 'auto',
    onError: options.onError ?? 'stop',
    transaction: pg && options.singleTransaction !== false ? 'single' : 'none',
    ...(options.errorLogLimit !== undefined ? { errorLogLimit: options.errorLogLimit } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    onProgress: (p) =>
      options.onProgress?.({
        phase: 'Running the script',
        objectsDone: 0,
        objectsTotal: 0,
        rows: p.rowsAffected,
        statements: p.statements,
        failed: p.failed,
        bytes: p.bytes,
        elapsedMs: p.elapsedMs,
      }),
    ...(options.progressIntervalMs !== undefined
      ? { progressIntervalMs: options.progressIntervalMs }
      : {}),
  });
  if (!pg) {
    for await (const _chunk of session.execute('SET foreign_key_checks = 1', {
      executionId: newId(),
    })) {
      // drained
    }
  }
  return {
    status: summary.status,
    objects: 0,
    rows: summary.rowsAffected,
    statements: summary.statements,
    failed: summary.failed,
    errors: summary.errors.map((e) => ({
      statement: e.statement,
      line: e.line,
      message: e.message,
      text: e.text,
    })),
    warnings: [],
    durationMs: Math.round(performance.now() - started),
  };
}

/** Reads the object DDL file of an archive (for previews). */
export async function objectStatements(
  archive: ArchiveReader,
  object: BackupObject,
): Promise<ObjectStatements> {
  if (object.ddl === undefined) return {};
  return (await archive.json(object.ddl)) as ObjectStatements;
}
