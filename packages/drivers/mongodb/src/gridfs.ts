import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { QuerybaraError, cancelledError } from '@querybara/core';
import { toEjson, type GridFsBucketRef, type GridFsFileInfo } from '@querybara/mongo-tools';
import { GridFSBucket, type Document, type ObjectId, type Sort } from 'mongodb';

import { numberOf } from './admin';
import {
  checkCollectionName,
  documentArg,
  driverDoc,
  ejson,
  valueArg,
  type MongoContext,
} from './context';
import type {
  GridFsDownloadOptions,
  GridFsListOptions,
  GridFsUploadOptions,
  UploadSource,
} from './types';

/**
 * GridFS (spec §9 GridFS browser): buckets are found as `<bucket>.files` / `<bucket>.chunks`
 * pairs; files are listed a page at a time, streamed in and out, deleted and renamed.
 */

/** Bucket names in a database: prefixes that have both a `.files` and a `.chunks` collection. */
export function gridFsBuckets(collectionNames: readonly string[]): string[] {
  const names = new Set(collectionNames);
  const buckets: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.files')) continue;
    const bucket = name.slice(0, -'.files'.length);
    if (bucket !== '' && names.has(`${bucket}.chunks`)) buckets.push(bucket);
  }
  return buckets.sort();
}

/**
 * A bucket handle. Listing uses raw deserialisation so metadata keeps its BSON types; transfers,
 * deletes and renames need the default one (the driver compares chunk numbers and counts).
 */
function bucketOf(ctx: MongoContext, ref: GridFsBucketRef, raw = false): GridFSBucket {
  checkCollectionName(ref.bucket);
  return new GridFSBucket(raw ? ctx.rawDb(ref.db) : ctx.db(ref.db), { bucketName: ref.bucket });
}

/** A file document as the browser lists it. */
export function fileInfo(doc: Document): GridFsFileInfo {
  const metadata = doc['metadata'];
  const contentType =
    typeof doc['contentType'] === 'string'
      ? doc['contentType']
      : typeof metadata === 'object' &&
          metadata !== null &&
          typeof metadata['contentType'] === 'string'
        ? (metadata['contentType'] as string)
        : undefined;
  const uploaded = doc['uploadDate'];
  return {
    id: ejson(doc['_id']),
    filename: String(doc['filename'] ?? ''),
    length: numberOf(doc['length']) ?? 0,
    chunkSize: numberOf(doc['chunkSize']) ?? 0,
    uploadDate: uploaded instanceof Date ? uploaded.toISOString() : '',
    ...(contentType !== undefined ? { contentType } : {}),
    ...(metadata !== undefined && metadata !== null ? { metadata: ejson(metadata) } : {}),
  };
}

export async function listBuckets(ctx: MongoContext, db: string): Promise<string[]> {
  const names = await ctx.exclusive(() =>
    ctx
      .db(db)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray()
      .then((rows) => rows.map((row) => String(row.name))),
  );
  return gridFsBuckets(names);
}

export function listFiles(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  opts: GridFsListOptions = {},
): AsyncIterable<{ readonly files: readonly GridFsFileInfo[] }> {
  const size = Math.max(1, Math.floor(opts.pageSize ?? 1000));
  return ctx.stream(opts, async function* (exec) {
    const cursor = exec.track(
      bucketOf(ctx, ref, true).find(documentArg(opts.filter, 'filter'), {
        session: exec.session,
        batchSize: size,
        sort:
          opts.sort !== undefined
            ? driverDoc<Sort>(documentArg(opts.sort, 'sort'))
            : { uploadDate: -1 },
        ...(opts.skip !== undefined ? { skip: opts.skip } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...ctx.maxTime(opts),
      }),
    );
    let files: GridFsFileInfo[] = [];
    for await (const doc of cursor) {
      files.push(fileInfo(doc));
      if (files.length >= size) {
        yield { files };
        files = [];
      }
    }
    if (files.length > 0) yield { files };
  });
}

function fileId(text: string): ObjectId {
  // GridFS ids may be any BSON value; the driver's typing says ObjectId.
  return valueArg(text, 'file id') as unknown as ObjectId;
}

/** Streams bytes into a new GridFS file and resolves with its id (canonical Extended JSON). */
export async function uploadFile(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  source: UploadSource,
  opts: GridFsUploadOptions,
): Promise<string> {
  ctx.assertOpen();
  if (opts.signal?.aborted) throw cancelledError();
  const metadata = opts.metadata !== undefined ? documentArg(opts.metadata, 'metadata') : undefined;
  const upload = bucketOf(ctx, ref).openUploadStream(opts.filename, {
    ...(opts.chunkSizeBytes !== undefined ? { chunkSizeBytes: opts.chunkSizeBytes } : {}),
    ...(opts.id !== undefined ? { id: fileId(opts.id) } : {}),
    ...(metadata !== undefined || opts.contentType !== undefined
      ? {
          metadata: {
            ...(metadata ?? {}),
            ...(opts.contentType !== undefined ? { contentType: opts.contentType } : {}),
          },
        }
      : {}),
  });
  const input =
    source instanceof Uint8Array
      ? Readable.from([source])
      : source instanceof Readable
        ? source
        : Readable.from(source);
  try {
    await pipeline(input, upload, opts.signal ? { signal: opts.signal } : {});
  } catch (error) {
    await upload.abort().catch(() => undefined);
    if (opts.signal?.aborted) throw cancelledError('Upload cancelled');
    throw ctx.map(error);
  }
  return toEjson(upload.id);
}

function downloadStream(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  id: string,
  opts: GridFsDownloadOptions,
) {
  ctx.assertOpen();
  return bucketOf(ctx, ref).openDownloadStream(fileId(id), {
    ...(opts.start !== undefined ? { start: opts.start } : {}),
    ...(opts.end !== undefined ? { end: opts.end } : {}),
  });
}

/** The file's bytes as they arrive; stopping early (or aborting) closes the stream. */
export async function* downloadFile(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  id: string,
  opts: GridFsDownloadOptions = {},
): AsyncGenerator<Uint8Array> {
  if (opts.signal?.aborted) throw cancelledError();
  const stream = downloadStream(ctx, ref, id, opts);
  const onAbort = (): void => void stream.abort().catch(() => undefined);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of stream) {
      if (opts.signal?.aborted) throw cancelledError('Download cancelled');
      yield new Uint8Array(chunk as Buffer);
    }
    if (opts.signal?.aborted) throw cancelledError('Download cancelled');
  } catch (error) {
    if (opts.signal?.aborted) throw cancelledError('Download cancelled');
    throw notFoundOr(ctx, error);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    stream.destroy();
  }
}

export async function downloadFileTo(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  id: string,
  destination: Writable,
  opts: GridFsDownloadOptions = {},
): Promise<number> {
  if (opts.signal?.aborted) throw cancelledError();
  const stream = downloadStream(ctx, ref, id, opts);
  let bytes = 0;
  stream.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
  });
  try {
    await pipeline(stream, destination, opts.signal ? { signal: opts.signal } : {});
  } catch (error) {
    if (opts.signal?.aborted) throw cancelledError('Download cancelled');
    throw notFoundOr(ctx, error);
  }
  return bytes;
}

function notFoundOr(ctx: MongoContext, error: unknown): QuerybaraError {
  const message = error instanceof Error ? error.message : String(error);
  if (/FileNotFound|file not found/i.test(message)) {
    return new QuerybaraError(
      { code: 'NOT_FOUND', message: 'The GridFS file does not exist' },
      { cause: error },
    );
  }
  return ctx.map(error);
}

export async function deleteFile(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  id: string,
): Promise<void> {
  await ctx.exclusive(async () => {
    try {
      await bucketOf(ctx, ref).delete(fileId(id));
    } catch (error) {
      throw notFoundOr(ctx, error);
    }
  });
}

export async function renameFile(
  ctx: MongoContext,
  ref: GridFsBucketRef,
  id: string,
  filename: string,
): Promise<void> {
  await ctx.exclusive(async () => {
    try {
      await bucketOf(ctx, ref).rename(fileId(id), filename);
    } catch (error) {
      throw notFoundOr(ctx, error);
    }
  });
}
