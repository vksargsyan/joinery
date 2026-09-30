import { open } from 'node:fs/promises';

import { JoineryError, isSqlEngine, type EngineId, type Session } from '@joinery/core';
import { decodeSource, gunzip, isGzip, type Sink } from '@joinery/transfer';

import type { Manifest } from './archive/manifest';
import { ArchiveReader, fileArchiveSource } from './archive/reader';
import type { ArchiveEncryption } from './archive/writer';
import { isArchive } from './archive/format';
import {
  backupMongo,
  isMongoBackupSession,
  planMongoRestore,
  restoreMongoArchive,
  type DocumentFormat,
} from './mongo/archive';
import {
  backupRedis,
  isRedisBackupSession,
  planRedisRestore,
  restoreRedisArchive,
} from './redis/archive';
import { backupSql } from './sql/backup';
import {
  planSqlRestore,
  restoreSqlArchive,
  restoreSqlScript,
  scriptConflicts,
} from './sql/restore';
import type {
  BackupFormat,
  BackupProgress,
  BackupSelection,
  BackupSummary,
  Logger,
  RestoreConflict,
  RestoreProgress,
  RestoreSummary,
} from './types';

/**
 * One entry point per task for the job runner and joinery-cli: back up any engine's session,
 * look inside a backup file, plan a restore (what it adds, needs and would drop), and run it.
 * The engine comes from the session (backups) or from the file (restores).
 */

export interface BackupRequest {
  readonly session: Session;
  readonly output: Sink;
  readonly format: BackupFormat;
  readonly compress?: boolean;
  readonly encryption?: ArchiveEncryption;
  readonly producer?: string;
  /** SQL: objects, schemas, structure-only tables. */
  readonly selection?: BackupSelection;
  readonly structure?: boolean;
  readonly data?: boolean;
  readonly grants?: boolean;
  readonly ownership?: boolean;
  readonly consistent?: boolean;
  readonly deferrable?: boolean;
  readonly rowsPerStatement?: number;
  /** MongoDB: collections (default all) and the document format. */
  readonly collections?: readonly string[];
  readonly excludeCollections?: readonly string[];
  readonly documentFormat?: DocumentFormat;
  /** Redis: key pattern. */
  readonly pattern?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: BackupProgress) => void;
  readonly onLog?: Logger;
  readonly progressIntervalMs?: number;
}

export async function runBackup(request: BackupRequest): Promise<BackupSummary> {
  const { session } = request;
  const common = {
    output: request.output,
    format: request.format,
    ...(request.compress !== undefined ? { compress: request.compress } : {}),
    ...(request.encryption !== undefined ? { encryption: request.encryption } : {}),
    ...(request.producer !== undefined ? { producer: request.producer } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.onProgress !== undefined ? { onProgress: request.onProgress } : {}),
    ...(request.onLog !== undefined ? { onLog: request.onLog } : {}),
    ...(request.progressIntervalMs !== undefined
      ? { progressIntervalMs: request.progressIntervalMs }
      : {}),
  };
  if (isSqlEngine(session.engine)) {
    return backupSql({
      ...common,
      session,
      ...(request.selection !== undefined ? { selection: request.selection } : {}),
      ...(request.structure !== undefined ? { structure: request.structure } : {}),
      ...(request.data !== undefined ? { data: request.data } : {}),
      ...(request.grants !== undefined ? { grants: request.grants } : {}),
      ...(request.ownership !== undefined ? { ownership: request.ownership } : {}),
      ...(request.consistent !== undefined ? { consistent: request.consistent } : {}),
      ...(request.deferrable !== undefined ? { deferrable: request.deferrable } : {}),
      ...(request.rowsPerStatement !== undefined
        ? { rowsPerStatement: request.rowsPerStatement }
        : {}),
    });
  }
  if (isMongoBackupSession(session)) {
    return backupMongo({
      ...common,
      session,
      ...(request.collections !== undefined ? { collections: request.collections } : {}),
      ...(request.excludeCollections !== undefined ? { exclude: request.excludeCollections } : {}),
      ...(request.documentFormat !== undefined ? { documentFormat: request.documentFormat } : {}),
    });
  }
  if (isRedisBackupSession(session)) {
    return backupRedis({
      ...common,
      session,
      ...(request.pattern !== undefined ? { pattern: request.pattern } : {}),
    });
  }
  throw new JoineryError({
    code: 'NOT_SUPPORTED',
    message: `Backups of ${session.engine} are not supported`,
  });
}

// ---------------------------------------------------------------------------------------------
// Inspecting a backup file

/** What a backup file holds, for the restore wizard. */
export interface BackupInspection {
  readonly format: BackupFormat | 'custom';
  readonly size: number;
  readonly encrypted: boolean;
  /** Absent when the archive is encrypted and no passphrase was given. */
  readonly manifest?: Manifest;
  /** Plain SQL backups written by Joinery name their engine in the first line. */
  readonly engine?: EngineId;
  readonly serverVersion?: string;
  readonly database?: string;
}

const SCRIPT_HEADER = /^-- Joinery backup of (.+) \((\w+) ([^)]*)\)/;

/** The first few kilobytes of a script, as text (gunzipped when needed). */
async function scriptHeader(path: string, gzip: boolean): Promise<string> {
  const src = await fileArchiveSource(path);
  const reader = {
    async *[Symbol.asyncIterator]() {
      yield await src.read(0, Math.min(src.size, 64 * 1024));
    },
  };
  let text = '';
  try {
    const bytes = gzip ? gunzip(reader) : reader;
    for await (const chunk of decodeSource(bytes, 'utf-8')) {
      text += chunk;
      if (text.length > 4096) break;
    }
  } catch {
    // The sample cuts a gzip stream short; what was decoded so far is enough.
  } finally {
    await src.close();
  }
  return text;
}

/** Reads a backup's header (and the manifest of an archive, given its passphrase). */
export async function inspectBackup(path: string, passphrase?: string): Promise<BackupInspection> {
  const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    throw new JoineryError({
      code: error.code === 'ENOENT' ? 'NOT_FOUND' : 'VALIDATION_FAILED',
      message: error.code === 'ENOENT' ? `${path} does not exist` : `${path} cannot be read`,
    });
  });
  let head: Buffer;
  let size: number;
  try {
    size = (await handle.stat()).size;
    head = Buffer.alloc(Math.min(size, 16));
    await handle.read(head, 0, head.length, 0);
  } finally {
    await handle.close();
  }
  if (head.subarray(0, 5).toString('latin1') === 'PGDMP') {
    return { format: 'custom', size, encrypted: false, engine: 'postgres' };
  }
  if (isArchive(head)) {
    const source = await fileArchiveSource(path);
    const probe = await ArchiveReader.probe(source).finally(() => source.close());
    if (probe.encrypted && (passphrase === undefined || passphrase === '')) {
      return { format: 'jbak', size, encrypted: true };
    }
    const archive = await ArchiveReader.open(path, {
      ...(passphrase !== undefined ? { passphrase } : {}),
    });
    try {
      const { manifest } = archive;
      return {
        format: 'jbak',
        size,
        encrypted: archive.encrypted,
        manifest,
        engine: manifest.engine,
        serverVersion: manifest.serverVersion,
        database: manifest.database,
      };
    } finally {
      await archive.close();
    }
  }
  const gzip = isGzip(head);
  const header = SCRIPT_HEADER.exec(await scriptHeader(path, gzip));
  const engine = header?.[2];
  return {
    format: gzip ? 'sql-gz' : 'sql',
    size,
    encrypted: false,
    ...(header && engine !== undefined && isEngine(engine)
      ? { engine, serverVersion: header[3]!, database: header[1]! }
      : {}),
  };
}

function isEngine(value: string): value is EngineId {
  return ['mysql', 'mariadb', 'postgres', 'mongodb', 'redis'].includes(value);
}

// ---------------------------------------------------------------------------------------------
// Restores

export interface RestoreRequest {
  readonly session: Session;
  readonly path: string;
  readonly passphrase?: string;
  /** Archive objects to restore (default all). */
  readonly select?: readonly string[];
  readonly structure?: boolean;
  readonly data?: boolean;
  readonly onError?: 'stop' | 'continue';
  /** Conflicts the user confirmed, by id, from `planRestore`. */
  readonly confirmedConflicts?: readonly string[];
  /** Redis: overwrite existing keys. */
  readonly replace?: boolean;
  /** Redis: expire keys at their original time. */
  readonly absoluteTtl?: boolean;
  /** PostgreSQL: one transaction (default true). */
  readonly singleTransaction?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RestoreProgress) => void;
  readonly onLog?: Logger;
  readonly progressIntervalMs?: number;
}

/** What a restore will do, for the wizard's review step and its confirmation. */
export interface RestorePlanSummary {
  readonly format: BackupFormat | 'custom';
  /** Objects restored (archives). */
  readonly objects: readonly string[];
  /** Objects added because selected ones need them. */
  readonly added: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Existing objects dropped, appended to or overwritten: the confirmation lists these. */
  readonly conflicts: readonly RestoreConflict[];
  readonly warnings: readonly string[];
}

async function openArchive(request: RestoreRequest): Promise<ArchiveReader | undefined> {
  const handle = await open(request.path, 'r');
  const head = Buffer.alloc(8);
  try {
    await handle.read(head, 0, 8, 0);
  } finally {
    await handle.close();
  }
  if (!isArchive(head)) return undefined;
  return ArchiveReader.open(request.path, {
    ...(request.passphrase !== undefined ? { passphrase: request.passphrase } : {}),
  });
}

export async function planRestore(request: RestoreRequest): Promise<RestorePlanSummary> {
  const { session } = request;
  const archive = await openArchive(request);
  if (!archive) {
    if (!isSqlEngine(session.engine)) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `A SQL script cannot be restored into ${session.engine}`,
      });
    }
    return {
      format: 'sql',
      objects: [],
      added: [],
      skipped: [],
      conflicts: await scriptConflicts(session),
      warnings: [],
    };
  }
  try {
    const select = request.select !== undefined ? { select: request.select } : {};
    if (isSqlEngine(session.engine)) {
      const plan = await planSqlRestore({
        session,
        archive,
        ...select,
        ...(request.structure !== undefined ? { structure: request.structure } : {}),
        ...(request.data !== undefined ? { data: request.data } : {}),
      });
      return {
        format: 'jbak',
        objects: plan.objects.map((o) => o.id),
        added: plan.added,
        skipped: plan.skipped,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
      };
    }
    if (isMongoBackupSession(session)) {
      const plan = await planMongoRestore({ session, archive, ...select });
      return {
        format: 'jbak',
        objects: plan.objects.map((o) => o.id),
        added: plan.added,
        skipped: plan.skipped,
        conflicts: plan.conflicts,
        warnings: plan.warnings,
      };
    }
    if (isRedisBackupSession(session)) {
      const plan = await planRedisRestore({
        session,
        archive,
        ...(request.replace !== undefined ? { replace: request.replace } : {}),
      });
      return {
        format: 'jbak',
        objects: archive.manifest.objects.map((o) => o.id),
        added: [],
        skipped: [],
        conflicts: plan.conflicts,
        warnings:
          plan.existing > 0 && request.replace !== true
            ? [`${plan.existing} of the keys exist already and are kept as they are`]
            : [],
      };
    }
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `Restores into ${session.engine} are not supported`,
    });
  } finally {
    await archive.close();
  }
}

export async function runRestore(request: RestoreRequest): Promise<RestoreSummary> {
  const { session } = request;
  const common = {
    ...(request.onError !== undefined ? { onError: request.onError } : {}),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
    ...(request.onProgress !== undefined ? { onProgress: request.onProgress } : {}),
    ...(request.onLog !== undefined ? { onLog: request.onLog } : {}),
    ...(request.progressIntervalMs !== undefined
      ? { progressIntervalMs: request.progressIntervalMs }
      : {}),
    ...(request.confirmedConflicts !== undefined
      ? { confirmedConflicts: request.confirmedConflicts }
      : {}),
  };
  const archive = await openArchive(request);
  if (!archive) {
    if (!isSqlEngine(session.engine)) {
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `A SQL script cannot be restored into ${session.engine}`,
      });
    }
    return restoreSqlScript({
      ...common,
      session,
      path: request.path,
      ...(request.singleTransaction !== undefined
        ? { singleTransaction: request.singleTransaction }
        : {}),
    });
  }
  try {
    const select = request.select !== undefined ? { select: request.select } : {};
    if (isSqlEngine(session.engine)) {
      return await restoreSqlArchive({
        ...common,
        session,
        archive,
        ...select,
        ...(request.structure !== undefined ? { structure: request.structure } : {}),
        ...(request.data !== undefined ? { data: request.data } : {}),
        ...(request.singleTransaction !== undefined
          ? { singleTransaction: request.singleTransaction }
          : {}),
      });
    }
    if (isMongoBackupSession(session)) {
      return await restoreMongoArchive({ ...common, session, archive, ...select });
    }
    if (isRedisBackupSession(session)) {
      return await restoreRedisArchive({
        ...common,
        session,
        archive,
        ...(request.replace !== undefined ? { replace: request.replace } : {}),
        ...(request.absoluteTtl !== undefined ? { absoluteTtl: request.absoluteTtl } : {}),
      });
    }
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `Restores into ${session.engine} are not supported`,
    });
  } finally {
    await archive.close();
  }
}
