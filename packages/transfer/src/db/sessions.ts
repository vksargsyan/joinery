import { QuerybaraError, type Session } from '@querybara/core';
import type {
  CollectionInfo,
  DocumentPage,
  FindQuery,
  IndexSpec,
  InsertManyResult,
  Namespace,
  SchemaAnalysis,
  WriteSummary,
} from '@querybara/mongo-tools';

/**
 * What a transfer uses of the MongoDB and Redis sessions' engine services (ADR 0007). The
 * drivers' `MongoSession` and `RedisSession` satisfy these structurally, so this package needs
 * neither driver: the job runner and the CLI hand their sessions in as they are.
 */

interface Signalled {
  readonly signal?: AbortSignal;
}

export interface MongoTransferSession extends Session {
  readonly engine: 'mongodb';
  readonly currentDatabase: string;
  find(
    ns: Namespace,
    query: FindQuery,
    opts?: Signalled & { readonly pageSize?: number },
  ): AsyncIterable<DocumentPage>;
  estimatedCount(ns: Namespace, opts?: Signalled): Promise<number>;
  insertMany(
    ns: Namespace,
    documents: string,
    opts?: Signalled & { readonly ordered?: boolean },
  ): Promise<InsertManyResult>;
  deleteMany(ns: Namespace, filter: string, opts?: Signalled): Promise<WriteSummary>;
  collectionInfo(ns: Namespace): Promise<CollectionInfo>;
  createCollection(ns: Namespace): Promise<void>;
  dropCollection(ns: Namespace): Promise<void>;
  createIndex(ns: Namespace, spec: IndexSpec): Promise<string>;
  analyzeSchema(
    ns: Namespace,
    opts?: Signalled & { readonly sampleSize?: number; readonly maxArrayItems?: number },
  ): Promise<SchemaAnalysis>;
}

/** A key's DUMP payload and time to live, as the Redis session's `dumpKeys` returns it. */
export interface DumpedKeyEntry {
  readonly key: Uint8Array;
  readonly payload: Uint8Array | null;
  readonly ttlMs: number;
  readonly expireAtMs: number | null;
}

export interface RedisTransferSession extends Session {
  readonly engine: 'redis';
  /** The logical database (0 in Cluster mode). */
  readonly database: number;
  readonly server: { readonly clusterMode: boolean; readonly version: string };
  scan(options?: {
    readonly cursor?: string;
    readonly match?: Uint8Array | string;
    readonly count?: number;
  }): Promise<{ readonly keys: Uint8Array[]; readonly cursor: string; readonly done: boolean }>;
  dumpKeys(keys: readonly Uint8Array[]): Promise<DumpedKeyEntry[]>;
  restoreKeys(
    keys: readonly DumpedKeyEntry[],
    options?: { readonly replace?: boolean },
  ): Promise<number>;
  dbSize(): Promise<number>;
}

function engineError(session: Session, wanted: string): QuerybaraError {
  return new QuerybaraError({
    code: 'NOT_SUPPORTED',
    message: `Expected a ${wanted} session, got ${session.engine}`,
  });
}

export function asMongo(session: Session): MongoTransferSession {
  if (session.engine !== 'mongodb' || !('find' in session) || !('insertMany' in session)) {
    throw engineError(session, 'MongoDB');
  }
  return session as MongoTransferSession;
}

export function asRedis(session: Session): RedisTransferSession {
  if (session.engine !== 'redis' || !('dumpKeys' in session) || !('restoreKeys' in session)) {
    throw engineError(session, 'Redis');
  }
  return session as RedisTransferSession;
}
