import { JoineryError, newId, toErrorData, type Session } from '@joinery/core';
import type { DocumentPage, FindQuery, InsertManyResult, Namespace } from '@joinery/mongo-tools';
import { BSON, EJSON, type Document } from 'bson';

import type { BackupObject, Manifest } from '../archive/manifest';
import type { ArchiveReader } from '../archive/reader';
import { ArchiveWriter } from '../archive/writer';
import { resolveSelection } from '../selection';
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
import { checkConfirmed, safeName } from '../common';
import { Pacer, errorMessage, isCancel, plural, throwIfAborted } from '../util';

/**
 * MongoDB backup and restore (spec §14): each collection's documents into a BSON file (the
 * mongodump layout: documents back to back) or a canonical Extended JSON file (one document per
 * line), and its options and indexes into a metadata file: validators, collation, capped size,
 * time series, clustered index, views and their pipelines. A restore recreates collections with
 * the same options, loads the documents, builds the indexes, then creates the views, in any
 * database.
 *
 * Documents keep every BSON type (Int32 vs Double, Long, Decimal128, binary subtypes, dates):
 * they travel as canonical Extended JSON through the session, as everywhere else in the app.
 */

/** What the backup needs of a MongoDB session (the driver's MongoSession has all of it). */
export interface MongoBackupSession extends Session {
  readonly engine: 'mongodb';
  readonly currentDatabase: string;
  find(
    ns: Namespace,
    query: FindQuery,
    opts?: { readonly pageSize?: number; readonly signal?: AbortSignal },
  ): AsyncIterable<DocumentPage>;
  insertMany(
    ns: Namespace,
    documents: string,
    opts?: { readonly signal?: AbortSignal; readonly ordered?: boolean },
  ): Promise<InsertManyResult>;
}

export function isMongoBackupSession(session: Session): session is MongoBackupSession {
  return session.engine === 'mongodb' && 'find' in session && 'insertMany' in session;
}

export type DocumentFormat = 'bson' | 'ejson';

export interface MongoBackupOptions extends BackupCommonOptions {
  readonly session: MongoBackupSession;
  /** Collections and views to back up (default all but system collections). */
  readonly collections?: readonly string[];
  readonly exclude?: readonly string[];
  /** BSON (default, compact, what mongodump writes) or canonical Extended JSON lines. */
  readonly documentFormat?: DocumentFormat;
}

/** The metadata file of a collection. */
export interface CollectionMetadata {
  readonly name: string;
  readonly type: 'collection' | 'view' | 'timeseries';
  /** listCollections options, canonical Extended JSON. */
  readonly options: string;
  /** listIndexes specifications, canonical Extended JSON each. */
  readonly indexes: readonly string[];
}

const relaxedFalse = { relaxed: false } as const;

async function command(session: Session, doc: Document, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  for await (const chunk of session.execute(EJSON.stringify(doc, relaxedFalse), {
    executionId: newId(),
    ...(signal !== undefined ? { signal } : {}),
  })) {
    if (chunk.type === 'rows') {
      for (const cell of chunk.data[0] ?? []) if (typeof cell === 'string') out.push(cell);
    }
  }
  return out;
}

interface CollectionInfo {
  readonly name: string;
  readonly type: 'collection' | 'view' | 'timeseries';
  readonly options: Document;
}

async function listCollections(session: Session, signal?: AbortSignal): Promise<CollectionInfo[]> {
  const rows = await command(session, { listCollections: 1 }, signal);
  return rows
    .map((row) => EJSON.parse(row, relaxedFalse) as Document)
    .filter((doc) => typeof doc['name'] === 'string' && !String(doc['name']).startsWith('system.'))
    .map((doc): CollectionInfo => ({
      name: String(doc['name']),
      type:
        doc['type'] === 'view'
          ? 'view'
          : doc['type'] === 'timeseries'
            ? 'timeseries'
            : 'collection',
      options: (doc['options'] ?? {}) as Document,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

export async function backupMongo(options: MongoBackupOptions): Promise<BackupSummary> {
  const { session, signal } = options;
  if (options.format !== 'jbak') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'MongoDB backups use the Joinery archive format (.jbak)',
    });
  }
  const format = options.documentFormat ?? 'bson';
  const pacer = new Pacer(options.progressIntervalMs ?? 250);
  const log = options.onLog ?? (() => undefined);
  const warnings: string[] = [];
  let bytes = 0;
  let rows = 0;
  let done = 0;
  let total = 0;
  let current: string | undefined;
  let phase = 'Listing collections';
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
  let archive: ArchiveWriter | undefined;
  let manifest: Manifest | undefined;
  let status: TransferStatus = 'completed';
  let error: JoineryError | undefined;
  let dataCount = 0;
  const database = session.currentDatabase;
  try {
    progress(true);
    const all = await listCollections(session, signal);
    const wanted = new Set(options.collections ?? []);
    const excluded = new Set(options.exclude ?? []);
    const byName = new Map(all.map((c) => [c.name, c]));
    for (const name of wanted) {
      if (!byName.has(name)) warnings.push(`${name} does not exist in ${database}`);
    }
    const objects: BackupObject[] = all.map((c) => ({
      id: `collection:${c.name}`,
      kind: 'collection',
      name: c.name,
      qualifiedName: c.name,
      dependsOn:
        c.type === 'view' &&
        typeof c.options['viewOn'] === 'string' &&
        byName.has(c.options['viewOn'])
          ? [`collection:${c.options['viewOn']}`]
          : [],
      detail: { type: c.type },
    }));
    const chosen = resolveSelection(objects, {
      ...(wanted.size > 0 ? { include: (o) => wanted.has(o.name) } : {}),
      ...(excluded.size > 0 ? { exclude: (o) => excluded.has(o.name) } : {}),
    });
    for (const id of chosen.added)
      log('info', `Also backing up ${id.slice(11)}, which a view reads`);
    for (const skip of chosen.skipped)
      warnings.push(`${skip.id.slice(11)} is left out: ${skip.reason}`);
    const selected = objects.filter((o) => chosen.ids.includes(o.id));
    total = selected.length;
    log('info', `Backing up ${plural(selected.length, 'collection')} of ${database}`);

    const counted = {
      write: async (chunk: Uint8Array) => {
        await options.output.write(chunk);
        bytes += chunk.length;
      },
      close: () => options.output.close(),
      abort: (reason?: unknown) => options.output.abort(reason),
    };
    archive = await ArchiveWriter.create({
      sink: counted,
      ...(options.compress !== undefined ? { compress: options.compress } : {}),
      ...(options.encryption ? { encryption: options.encryption } : {}),
    });
    const written: BackupObject[] = [];
    for (const [index, object] of selected.entries()) {
      throwIfAborted(signal);
      const info = byName.get(object.name)!;
      current = object.name;
      phase = 'Backing up collections';
      progress(true);
      const prefix = String(index + 1).padStart(4, '0');
      const indexes =
        info.type === 'view' ? [] : await command(session, { listIndexes: info.name }, signal);
      const metadata: CollectionMetadata = {
        name: info.name,
        type: info.type,
        options: EJSON.stringify(info.options, relaxedFalse),
        indexes,
      };
      const metaName = `meta/${prefix}-${safeName(info.name)}.json`;
      await archive.add(metaName, 'application/json', JSON.stringify(metadata));
      let data: BackupObject['data'];
      if (info.type !== 'view') {
        const name = `data/${prefix}-${safeName(info.name)}.${format === 'bson' ? 'bson' : 'jsonl'}`;
        const entry = archive.entry(
          name,
          format === 'bson' ? 'application/bson' : 'application/x-ndjson',
        );
        let count = 0;
        for await (const page of session.find(
          { db: database, collection: info.name },
          {},
          { pageSize: 1000, ...(signal !== undefined ? { signal } : {}) },
        )) {
          throwIfAborted(signal);
          if (format === 'bson') {
            const parts = page.documents.map((doc) =>
              BSON.serialize(EJSON.parse(doc, relaxedFalse) as Document),
            );
            await entry.write(Buffer.concat(parts));
          } else {
            await entry.write(page.documents.map((doc) => `${doc}\n`).join(''));
          }
          count += page.documents.length;
          rows += page.documents.length;
          progress();
        }
        await entry.close();
        data = { entry: name, count };
        dataCount++;
      }
      written.push({
        ...object,
        dependsOn: object.dependsOn.filter((d) => chosen.ids.includes(d)),
        metadata: metaName,
        ...(data !== undefined ? { data } : {}),
        detail: { type: info.type, indexes: indexes.length },
      });
      done++;
    }
    phase = 'Finishing';
    current = undefined;
    manifest = await archive.finish({
      createdAt: new Date().toISOString(),
      producer: options.producer ?? 'Joinery',
      engine: 'mongodb',
      serverVersion: session.serverVersion,
      database,
      options: {
        documentFormat: format,
        snapshot: 'none',
        compression: archive.compressed ? 'gzip' : 'none',
        encrypted: archive.encrypted,
      },
      objects: written,
      warnings,
    });
  } catch (caught) {
    status = isCancel(caught, signal) ? 'cancelled' : 'failed';
    error = caught instanceof JoineryError ? caught : new JoineryError(toErrorData(caught));
    if (archive) await archive.abort(caught);
    else await options.output.abort(caught).catch(() => undefined);
  }
  progress(true);
  return {
    status,
    format: 'jbak',
    objects: done,
    dataObjects: dataCount,
    rows,
    bytesWritten: bytes,
    durationMs: pacer.elapsedMs,
    warnings,
    ...(error !== undefined && status === 'failed' ? { error: error.toJSON() } : {}),
    ...(manifest !== undefined ? { manifest } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Restore

export interface MongoRestorePlan {
  readonly objects: readonly BackupObject[];
  readonly added: readonly string[];
  readonly skipped: readonly { readonly id: string; readonly reason: string }[];
  /** Collections and views that exist in the target and are dropped first. */
  readonly conflicts: readonly RestoreConflict[];
  readonly warnings: readonly string[];
}

export interface MongoRestorePlanOptions {
  readonly session: MongoBackupSession;
  readonly archive: ArchiveReader;
  /** Object ids to restore (default all); views bring what they read. */
  readonly select?: readonly string[];
}

export async function planMongoRestore(
  options: MongoRestorePlanOptions,
): Promise<MongoRestorePlan> {
  const { session, archive } = options;
  if (archive.manifest.engine !== 'mongodb') {
    throw new JoineryError({
      code: 'NOT_SUPPORTED',
      message: `This is a ${archive.manifest.engine} backup; it cannot be restored into MongoDB`,
    });
  }
  const selected = options.select !== undefined ? new Set(options.select) : undefined;
  const chosen = resolveSelection(archive.manifest.objects, {
    ...(selected ? { include: (o) => selected.has(o.id) } : {}),
  });
  const objects = archive.manifest.objects.filter((o) => chosen.ids.includes(o.id));
  const existing = new Set((await listCollections(session)).map((c) => c.name));
  const conflicts: RestoreConflict[] = objects
    .filter((o) => existing.has(o.name))
    .map((o) => ({ id: o.id, kind: o.kind, qualifiedName: o.name, action: 'drop' as const }));
  return { objects, added: chosen.added, skipped: chosen.skipped, conflicts, warnings: [] };
}

export interface MongoRestoreOptions extends RestoreCommonOptions, MongoRestorePlanOptions {
  /** The conflicts (existing collections to drop) the user confirmed. */
  readonly confirmedConflicts?: readonly string[];
  /** Documents per insert (default 1000). */
  readonly batchSize?: number;
}

/** Index specifications to recreate: not _id_ or the clustered index, without `v` and `ns`. */
export function indexesToCreate(specs: readonly string[]): Document[] {
  return specs
    .map((text) => EJSON.parse(text, relaxedFalse) as Document)
    .filter((spec) => spec['name'] !== '_id_' && spec['clustered'] !== true)
    .map((spec) => {
      const { v: _v, ns: _ns, ...rest } = spec;
      return rest;
    });
}

/** The `create` command for a collection or view from its listCollections options. */
export function createCommand(name: string, optionsText: string): Document {
  const options = EJSON.parse(optionsText, relaxedFalse) as Document;
  const clustered = options['clusteredIndex'];
  if (clustered !== null && typeof clustered === 'object' && !Array.isArray(clustered)) {
    const { v: _v, ...rest } = clustered as Document;
    options['clusteredIndex'] = rest;
  }
  return { create: name, ...options };
}

async function* bsonDocuments(source: AsyncIterable<Uint8Array>): AsyncGenerator<Document> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    let at = 0;
    while (buffer.length - at >= 4) {
      const size = buffer.readInt32LE(at);
      if (size < 5)
        throw new JoineryError({
          code: 'VALIDATION_FAILED',
          message: 'The backup holds a damaged BSON document',
        });
      if (buffer.length - at < size) break;
      yield BSON.deserialize(buffer.subarray(at, at + size), {
        promoteValues: false,
        promoteLongs: false,
        promoteBuffers: false,
        bsonRegExp: true,
      });
      at += size;
    }
    buffer = buffer.subarray(at);
  }
  if (buffer.length > 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The backup ends inside a BSON document',
    });
  }
}

async function* lines(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let rest = '';
  for await (const chunk of source) {
    rest += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, at);
      rest = rest.slice(at + 1);
      if (line.trim() !== '') yield line;
    }
  }
  rest += decoder.decode();
  if (rest.trim() !== '') yield rest;
}

export async function restoreMongoArchive(options: MongoRestoreOptions): Promise<RestoreSummary> {
  const { session, archive, signal } = options;
  const onError = options.onError ?? 'stop';
  const errorLogLimit = options.errorLogLimit ?? 1000;
  const batchSize = Math.max(1, options.batchSize ?? 1000);
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
  class Stop extends Error {}
  const attempt = async (what: string, work: () => Promise<void>): Promise<void> => {
    throwIfAborted(signal);
    statements++;
    try {
      await work();
    } catch (error) {
      if (isCancel(error, signal)) throw error;
      failed++;
      if (errors.length < errorLogLimit)
        errors.push({ object: what, message: errorMessage(error) });
      log('error', `${what}: ${errorMessage(error)}`);
      if (onError === 'stop') throw new Stop();
    }
    progress();
  };

  let status: TransferStatus = 'completed';
  let fatal: JoineryError | undefined;
  const database = session.currentDatabase;
  try {
    const plan = await planMongoRestore(options);
    for (const skip of plan.skipped) warnings.push(`${skip.id} is not restored: ${skip.reason}`);
    checkConfirmed(plan.conflicts, options.confirmedConflicts);
    total = plan.objects.length;
    totalBytes = plan.objects.reduce(
      (sum, o) => sum + (o.data ? (archive.entry(o.data.entry)?.size ?? 0) : 0),
      0,
    );
    const metadata = new Map<string, CollectionMetadata>();
    for (const object of plan.objects) {
      if (object.metadata === undefined) continue;
      metadata.set(object.id, (await archive.json(object.metadata)) as CollectionMetadata);
    }
    log('info', `Restoring ${plural(plan.objects.length, 'collection')} into ${database}`);
    phase = 'Dropping replaced collections';
    for (const conflict of [...plan.conflicts].reverse()) {
      await attempt(conflict.qualifiedName, async () => {
        await command(session, { drop: conflict.qualifiedName }, signal);
      });
    }
    // Collections first (sources before views), then their documents and indexes.
    const views = plan.objects.filter((o) => metadata.get(o.id)?.type === 'view');
    const collections = plan.objects.filter((o) => metadata.get(o.id)?.type !== 'view');
    for (const object of collections) {
      const meta = metadata.get(object.id);
      if (!meta) continue;
      current = object.name;
      phase = 'Restoring collections';
      progress(true);
      let created = true;
      await attempt(object.name, async () => {
        created = false;
        await command(session, createCommand(meta.name, meta.options), signal);
        created = true;
      });
      if (!created) {
        done++;
        continue;
      }
      if (object.data) {
        const ns = { db: database, collection: meta.name };
        const source: AsyncIterable<Uint8Array> = {
          async *[Symbol.asyncIterator]() {
            for await (const chunk of archive.read(object.data!.entry)) {
              bytes += chunk.length;
              yield chunk;
            }
          },
        };
        let batch: string[] = [];
        let batchBytes = 0;
        const flush = async (): Promise<void> => {
          if (batch.length === 0) return;
          const documents = batch;
          batch = [];
          batchBytes = 0;
          await attempt(meta.name, async () => {
            const result = await session.insertMany(ns, `[${documents.join(',')}]`, {
              ordered: false,
              ...(signal !== undefined ? { signal } : {}),
            });
            rows += result.insertedCount;
          });
        };
        const docs: AsyncIterable<string> =
          archive.entry(object.data.entry)?.contentType === 'application/bson'
            ? (async function* () {
                for await (const doc of bsonDocuments(source))
                  yield EJSON.stringify(doc, relaxedFalse);
              })()
            : lines(source);
        for await (const doc of docs) {
          batch.push(doc);
          batchBytes += doc.length;
          if (batch.length >= batchSize || batchBytes >= 8 * 1024 * 1024) await flush();
        }
        await flush();
      }
      const indexes = indexesToCreate(meta.indexes);
      if (indexes.length > 0) {
        await attempt(`${meta.name} indexes`, async () => {
          await command(session, { createIndexes: meta.name, indexes }, signal);
        });
      }
      done++;
    }
    phase = 'Creating views';
    for (const object of views) {
      const meta = metadata.get(object.id)!;
      current = object.name;
      await attempt(object.name, async () => {
        await command(session, createCommand(meta.name, meta.options), signal);
      });
      done++;
    }
    current = undefined;
  } catch (error) {
    if (error instanceof Stop) status = 'failed';
    else if (isCancel(error, signal)) status = 'cancelled';
    else {
      status = 'failed';
      fatal = error instanceof JoineryError ? error : new JoineryError(toErrorData(error));
      log('error', fatal.message);
    }
  }
  phase = status === 'completed' ? 'Done' : 'Stopped';
  progress(true);
  return {
    status,
    objects: done,
    rows,
    statements,
    failed,
    errors,
    warnings,
    durationMs: pacer.elapsedMs,
    ...(fatal !== undefined ? { error: fatal.toJSON() } : {}),
  };
}
