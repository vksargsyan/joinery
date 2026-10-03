import { QuerybaraError, toErrorData, type Session } from '@querybara/core';
import { BSON, Binary, Long, type Document } from 'bson';

import type { BackupObject, Manifest } from '../archive/manifest';
import type { ArchiveReader } from '../archive/reader';
import { ArchiveWriter } from '../archive/writer';
import { checkConfirmed } from '../common';
import type {
  BackupCommonOptions,
  BackupProgress,
  BackupSummary,
  RestoreCommonOptions,
  RestoreConflict,
  RestoreError,
  RestoreProgress,
  RestoreSummary,
  TransferStatus,
} from '../types';
import { Pacer, errorMessage, isCancel, plural, throwIfAborted } from '../util';

/**
 * Redis backup and restore (spec §14): the keys matching a pattern, each as its DUMP payload
 * with its TTL, in one file of the archive (BSON records: key, payload, TTL and absolute expiry).
 * SCAN walks every primary of a Cluster, and RESTORE sends each key to the node that owns its
 * slot, so a backup of one topology restores into another. Server-side snapshots (BGSAVE) stay
 * a server task.
 *
 * DUMP payloads carry the RDB version of the server that wrote them: they restore into the same
 * or a newer Redis (or Valkey) version. SCAN sees every key that exists for the whole backup;
 * keys written meanwhile may or may not be in it, and a key can appear twice (a restore keeps
 * one).
 */

/** A key's DUMP payload and TTL (the driver's DumpedKey). */
export interface DumpedKeyRecord {
  readonly key: Uint8Array;
  readonly payload: Uint8Array | null;
  /** PTTL at dump time: -1 without expiry. */
  readonly ttlMs: number;
  readonly expireAtMs: number | null;
}

/** What the backup needs of a Redis session (the driver's RedisSession has all of it). */
export interface RedisBackupSession extends Session {
  readonly engine: 'redis';
  readonly database: number;
  readonly server: { readonly clusterMode: boolean };
  scan(options?: {
    readonly cursor?: string;
    readonly match?: Uint8Array | string;
    readonly count?: number;
  }): Promise<{ readonly keys: Uint8Array[]; readonly cursor: string; readonly done: boolean }>;
  dumpKeys(keys: readonly Uint8Array[]): Promise<DumpedKeyRecord[]>;
  restoreKeys(
    keys: readonly DumpedKeyRecord[],
    options?: { readonly replace?: boolean; readonly absoluteTtl?: boolean },
  ): Promise<number>;
  exists(keys: readonly Uint8Array[]): Promise<number>;
}

export function isRedisBackupSession(session: Session): session is RedisBackupSession {
  return session.engine === 'redis' && 'dumpKeys' in session && 'restoreKeys' in session;
}

export interface RedisBackupOptions extends BackupCommonOptions {
  readonly session: RedisBackupSession;
  /** Glob pattern of the keys (default `*`). */
  readonly pattern?: string;
  /** Keys per SCAN call (default 1000). */
  readonly scanCount?: number;
}

const KEYS_ENTRY_ID = 'keys';

function record(key: DumpedKeyRecord): Uint8Array {
  return BSON.serialize({
    k: new Binary(key.key),
    v: new Binary(key.payload!),
    t: Long.fromNumber(key.ttlMs),
    x: key.expireAtMs === null ? null : Long.fromNumber(key.expireAtMs),
  });
}

function fromRecord(doc: Document): DumpedKeyRecord {
  const bytes = (value: unknown): Uint8Array => {
    if (value instanceof Binary) return value.value();
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The backup holds a damaged key',
    });
  };
  const number = (value: unknown): number =>
    value instanceof Long ? value.toNumber() : typeof value === 'number' ? value : -1;
  const expire = doc['x'];
  return {
    key: bytes(doc['k']),
    payload: bytes(doc['v']),
    ttlMs: number(doc['t']),
    expireAtMs: expire === null || expire === undefined ? null : number(expire),
  };
}

export async function backupRedis(options: RedisBackupOptions): Promise<BackupSummary> {
  const { session, signal } = options;
  if (options.format !== 'qbak') {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'Redis backups use the Querybara archive format (.qbak)',
    });
  }
  const pattern = options.pattern === undefined || options.pattern === '' ? '*' : options.pattern;
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const log = options.onLog ?? (() => undefined);
  const warnings: string[] = [];
  let bytes = 0;
  let keys = 0;
  let phase = 'Scanning keys';
  const progress = (force = false): void => {
    if (!options.onProgress || !pacer.due(force)) return;
    const event: BackupProgress = {
      phase,
      objectsDone: 0,
      objectsTotal: 1,
      rows: keys,
      bytes,
      elapsedMs: pacer.elapsedMs,
    };
    options.onProgress(event);
  };
  const database = session.server.clusterMode ? 'cluster' : `db${session.database}`;
  let archive: ArchiveWriter | undefined;
  let manifest: Manifest | undefined;
  let status: TransferStatus = 'completed';
  let error: QuerybaraError | undefined;
  let vanished = 0;
  try {
    progress(true);
    archive = await ArchiveWriter.create({
      sink: {
        write: async (chunk) => {
          await options.output.write(chunk);
          bytes += chunk.length;
        },
        close: () => options.output.close(),
        abort: (reason) => options.output.abort(reason),
      },
      ...(options.compress !== undefined ? { compress: options.compress } : {}),
      ...(options.encryption ? { encryption: options.encryption } : {}),
    });
    log(
      'info',
      `Backing up the keys matching ${pattern} ${session.server.clusterMode ? 'on every primary of the cluster' : `in database ${session.database}`}`,
    );
    const entryName = `keys/${database}.bson`;
    const entry = archive.entry(entryName, 'application/bson');
    let cursor = '0';
    do {
      throwIfAborted(signal);
      const page = await session.scan({
        cursor,
        match: pattern,
        count: options.scanCount ?? 1000,
      });
      cursor = page.cursor;
      for (let at = 0; at < page.keys.length; at += 500) {
        const dumped = await session.dumpKeys(page.keys.slice(at, at + 500));
        const present = dumped.filter((k) => k.payload !== null);
        vanished += dumped.length - present.length;
        if (present.length > 0) await entry.write(Buffer.concat(present.map(record)));
        keys += present.length;
        progress();
      }
      if (page.done) break;
    } while (cursor !== '0');
    await entry.close();
    if (vanished > 0)
      log('info', `${plural(vanished, 'key')} expired or was deleted during the backup`);
    phase = 'Finishing';
    const object: BackupObject = {
      id: `${KEYS_ENTRY_ID}:${database}`,
      kind: 'keys',
      name: database,
      qualifiedName: `Keys matching ${pattern}`,
      dependsOn: [],
      data: { entry: entryName, count: keys },
      detail: { pattern, cluster: session.server.clusterMode },
    };
    manifest = await archive.finish({
      createdAt: new Date().toISOString(),
      producer: options.producer ?? 'Querybara',
      engine: 'redis',
      serverVersion: session.serverVersion,
      database,
      options: {
        pattern,
        cluster: session.server.clusterMode,
        snapshot: 'none',
        compression: archive.compressed ? 'gzip' : 'none',
        encrypted: archive.encrypted,
      },
      objects: [object],
      warnings,
    });
  } catch (caught) {
    status = isCancel(caught, signal) ? 'cancelled' : 'failed';
    error = caught instanceof QuerybaraError ? caught : new QuerybaraError(toErrorData(caught));
    if (archive) await archive.abort(caught);
    else await options.output.abort(caught).catch(() => undefined);
  }
  progress(true);
  return {
    status,
    format: 'qbak',
    objects: status === 'completed' ? 1 : 0,
    dataObjects: status === 'completed' ? 1 : 0,
    rows: keys,
    bytesWritten: bytes,
    durationMs: pacer.elapsedMs,
    warnings,
    ...(error !== undefined && status === 'failed' ? { error: error.toJSON() } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Restore

async function* keyRecords(source: AsyncIterable<Uint8Array>): AsyncGenerator<DumpedKeyRecord> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    let at = 0;
    while (buffer.length - at >= 4) {
      const size = buffer.readInt32LE(at);
      if (size < 5) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'The backup holds a damaged key',
        });
      }
      if (buffer.length - at < size) break;
      yield fromRecord(BSON.deserialize(buffer.subarray(at, at + size), { promoteLongs: false }));
      at += size;
    }
    buffer = buffer.subarray(at);
  }
  if (buffer.length > 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The backup ends inside a key',
    });
  }
}

export interface RedisRestorePlanOptions {
  readonly session: RedisBackupSession;
  readonly archive: ArchiveReader;
  /** Overwrite keys that exist (RESTORE ... REPLACE); otherwise they are kept and skipped. */
  readonly replace?: boolean;
}

export interface RedisRestorePlan {
  readonly keys: number;
  /** Keys of the backup that exist in the target. */
  readonly existing: number;
  /** A few of them, for the confirmation. */
  readonly sample: readonly string[];
  /** With `replace`, the existing keys are overwritten: one conflict to confirm. */
  readonly conflicts: readonly RestoreConflict[];
}

function keyText(key: Uint8Array): string {
  return Buffer.from(key).toString('utf8');
}

async function existingOf(
  session: RedisBackupSession,
  batch: readonly DumpedKeyRecord[],
): Promise<boolean[]> {
  return Promise.all(batch.map(async (k) => (await session.exists([k.key])) > 0));
}

function keysObject(archive: ArchiveReader): BackupObject {
  const manifest = archive.manifest;
  if (manifest.engine !== 'redis') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `This is a ${manifest.engine} backup; it cannot be restored into Redis`,
    });
  }
  const object = manifest.objects.find((o) => o.kind === 'keys' && o.data !== undefined);
  if (!object?.data) {
    throw new QuerybaraError({ code: 'VALIDATION_FAILED', message: 'The backup holds no keys' });
  }
  return object;
}

/** Counts the backup's keys that exist in the target (the confirmation for REPLACE). */
export async function planRedisRestore(
  options: RedisRestorePlanOptions,
): Promise<RedisRestorePlan> {
  const { session, archive } = options;
  const object = keysObject(archive);
  let keys = 0;
  let existing = 0;
  const sample: string[] = [];
  let batch: DumpedKeyRecord[] = [];
  const seen = new Set<string>();
  const check = async (): Promise<void> => {
    const flags = await existingOf(session, batch);
    flags.forEach((present, i) => {
      if (!present) return;
      existing++;
      if (sample.length < 10) sample.push(keyText(batch[i]!.key));
    });
    batch = [];
    seen.clear();
  };
  for await (const key of keyRecords(archive.read(object.data!.entry))) {
    const id = Buffer.from(key.key).toString('base64');
    if (seen.has(id)) continue;
    seen.add(id);
    keys++;
    batch.push(key);
    if (batch.length >= 500) await check();
  }
  await check();
  const conflicts: RestoreConflict[] =
    options.replace === true && existing > 0
      ? [
          {
            id: object.id,
            kind: 'keys',
            qualifiedName: `${plural(existing, 'existing key')} (${sample.join(', ')}${existing > sample.length ? ', …' : ''})`,
            action: 'overwrite',
          },
        ]
      : [];
  return { keys, existing, sample, conflicts };
}

export interface RedisRestoreOptions extends RestoreCommonOptions, RedisRestorePlanOptions {
  /** Set expiry at the original absolute time (ABSTTL); keys already expired are skipped. */
  readonly absoluteTtl?: boolean;
  /** The conflicts the user confirmed (with `replace`). */
  readonly confirmedConflicts?: readonly string[];
}

export async function restoreRedisArchive(options: RedisRestoreOptions): Promise<RestoreSummary> {
  const { session, archive, signal } = options;
  const onError = options.onError ?? 'stop';
  const errorLogLimit = options.errorLogLimit ?? 1000;
  const replace = options.replace === true;
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const log = options.onLog ?? (() => undefined);
  const errors: RestoreError[] = [];
  const warnings: string[] = [];
  let statements = 0;
  let failed = 0;
  let restored = 0;
  let skipped = 0;
  let bytes = 0;
  let phase = 'Checking existing keys';
  const progress = (force = false): void => {
    if (!options.onProgress || !pacer.due(force)) return;
    const event: RestoreProgress = {
      phase,
      objectsDone: 0,
      objectsTotal: 1,
      rows: restored,
      statements,
      failed,
      bytes,
      elapsedMs: pacer.elapsedMs,
    };
    options.onProgress(event);
  };
  class Stop extends Error {}
  const restoreOptions = { replace, ...(options.absoluteTtl ? { absoluteTtl: true } : {}) };
  const fail = (key: DumpedKeyRecord, error: unknown): void => {
    failed++;
    if (errors.length < errorLogLimit) {
      errors.push({ object: keyText(key.key), message: errorMessage(error) });
    }
    if (onError === 'stop') throw new Stop();
  };
  const flush = async (batch: DumpedKeyRecord[]): Promise<void> => {
    if (batch.length === 0) return;
    throwIfAborted(signal);
    let todo = batch;
    if (!replace) {
      const flags = await existingOf(session, batch);
      todo = batch.filter((_, i) => !flags[i]);
      skipped += batch.length - todo.length;
    }
    statements += todo.length;
    try {
      restored += await session.restoreKeys(todo, restoreOptions);
    } catch {
      // One key failed; find which, one at a time.
      for (const key of todo) {
        try {
          restored += await session.restoreKeys([key], restoreOptions);
        } catch (error) {
          if (isCancel(error, signal)) throw error;
          if (!replace && /BUSYKEY/i.test(errorMessage(error))) skipped++;
          else fail(key, error);
        }
      }
    }
    progress();
  };

  let status: TransferStatus = 'completed';
  let fatal: QuerybaraError | undefined;
  try {
    const object = keysObject(archive);
    if (replace) {
      const plan = await planRedisRestore(options);
      checkConfirmed(plan.conflicts, options.confirmedConflicts);
    }
    phase = 'Restoring keys';
    log(
      'info',
      `Restoring ${plural(object.data!.count, 'key')}${replace ? ', replacing existing keys' : ''}`,
    );
    let batch: DumpedKeyRecord[] = [];
    const source: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of archive.read(object.data!.entry)) {
          bytes += chunk.length;
          yield chunk;
        }
      },
    };
    const seen = new Set<string>();
    for await (const key of keyRecords(source)) {
      // SCAN may return a key twice; the first copy is the one restored.
      const id = Buffer.from(key.key).toString('base64');
      if (seen.has(id)) continue;
      seen.add(id);
      batch.push(key);
      if (batch.length >= 500) {
        await flush(batch);
        batch = [];
        seen.clear();
      }
    }
    await flush(batch);
    if (skipped > 0) {
      const message = `${plural(skipped, 'key')} already existed and ${skipped === 1 ? 'was' : 'were'} kept as ${skipped === 1 ? 'it was' : 'they were'}`;
      warnings.push(message);
      log('info', message);
    }
  } catch (error) {
    if (error instanceof Stop) status = 'failed';
    else if (isCancel(error, signal)) status = 'cancelled';
    else {
      status = 'failed';
      fatal = error instanceof QuerybaraError ? error : new QuerybaraError(toErrorData(error));
      log('error', fatal.message);
    }
  }
  phase = status === 'completed' ? 'Done' : 'Stopped';
  progress(true);
  return {
    status,
    objects: status === 'completed' ? 1 : 0,
    rows: restored,
    statements,
    failed,
    errors,
    warnings,
    durationMs: pacer.elapsedMs,
    ...(fatal !== undefined ? { error: fatal.toJSON() } : {}),
  };
}
