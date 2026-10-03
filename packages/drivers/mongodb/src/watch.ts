import { QuerybaraError, cancelledError } from '@querybara/core';
import {
  bsonTag,
  type ChangeEvent,
  type TopologyKind,
  type WatchScope,
} from '@querybara/mongo-tools';
import type { ChangeStream, ChangeStreamOptions, Document, Timestamp } from 'mongodb';

import { RAW_BSON, documentsArg, ejson, valueArg, type MongoContext } from './context';
import type { WatchOptions } from './types';

/** One driver change event → the cross-process shape. */
export function changeEvent(change: Document): ChangeEvent {
  const ns = change['ns'] as { db?: unknown; coll?: unknown } | undefined;
  const wallTime = change['wallTime'];
  const clusterTime = change['clusterTime'];
  const when =
    wallTime instanceof Date
      ? wallTime.toISOString()
      : bsonTag(clusterTime) === 'Timestamp'
        ? new Date((clusterTime as Timestamp).t * 1000).toISOString()
        : undefined;
  return {
    operationType: String(change['operationType'] ?? 'unknown'),
    event: ejson(change),
    resumeToken: ejson(change['_id']),
    ...(ns && typeof ns.db === 'string'
      ? { ns: { db: ns.db, ...(typeof ns.coll === 'string' ? { collection: ns.coll } : {}) } }
      : {}),
    ...(change['documentKey'] !== undefined ? { documentKey: ejson(change['documentKey']) } : {}),
    ...(when !== undefined ? { clusterTime: when } : {}),
  };
}

/**
 * Tails changes (spec §9 change stream viewer) on the cluster, a database or a collection. The
 * driver resumes by itself after transient errors; a caller that stops can continue later from
 * an event's `resumeToken`. Returning from the iteration or aborting closes the stream (abort
 * ends it with CANCELLED). Standalone servers have no change streams: NOT_SUPPORTED.
 */
export async function* watch(
  ctx: MongoContext,
  topology: TopologyKind,
  scope: WatchScope,
  pipeline: string | undefined,
  opts: WatchOptions = {},
): AsyncGenerator<ChangeEvent> {
  ctx.assertOpen();
  if (topology === 'standalone') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'Change streams are not available on a standalone server',
      hint: 'Change streams need a replica set or a sharded cluster (a one-member replica set works)',
    });
  }
  if (opts.signal?.aborted) throw cancelledError();
  const stages =
    pipeline !== undefined && pipeline.trim() !== '' ? documentsArg(pipeline, 'pipeline') : [];
  const options: ChangeStreamOptions = {
    ...RAW_BSON,
    maxAwaitTimeMS: opts.maxAwaitTimeMS ?? 1000,
    ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
    ...(opts.fullDocument !== undefined ? { fullDocument: opts.fullDocument } : {}),
    ...(opts.fullDocumentBeforeChange !== undefined
      ? { fullDocumentBeforeChange: opts.fullDocumentBeforeChange }
      : {}),
    ...(opts.resumeAfter !== undefined
      ? { resumeAfter: valueArg(opts.resumeAfter, 'resume token') }
      : {}),
    ...(opts.startAfter !== undefined
      ? { startAfter: valueArg(opts.startAfter, 'resume token') }
      : {}),
    ...(opts.startAtOperationTime !== undefined
      ? {
          startAtOperationTime: valueArg(
            opts.startAtOperationTime,
            'operation time',
          ) as unknown as Timestamp,
        }
      : {}),
  };
  let stream: ChangeStream<Document>;
  try {
    stream =
      scope.kind === 'cluster'
        ? ctx.client.watch(stages, options)
        : scope.kind === 'database'
          ? ctx.rawDb(scope.db).watch(stages, options)
          : ctx.collection(scope.ns).watch(stages, options);
  } catch (error) {
    throw ctx.map(error);
  }
  const onAbort = (): void => void stream.close().catch(() => undefined);
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const change of stream) {
      if (opts.signal?.aborted) break;
      yield changeEvent(change);
    }
    if (opts.signal?.aborted) throw cancelledError('Change stream closed');
  } catch (error) {
    if (opts.signal?.aborted) throw cancelledError('Change stream closed');
    throw ctx.map(error);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await stream.close().catch(() => undefined);
  }
}
