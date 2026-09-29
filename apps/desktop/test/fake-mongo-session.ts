import {
  JoineryError,
  capabilitiesFor,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { MongoDbSession, type MongoSession } from '@joinery/driver-mongodb';
import { toEjson, type WriteSummary } from '@joinery/mongo-tools';

/**
 * A MongoSession double for the connection host's `mongo.*` handlers: it records every call
 * (method and arguments) and answers from a small in-memory collection. It passes
 * `isMongoSession`, which checks for the driver's session class, because its prototype is that
 * class's; every method it answers is an own property, so none of the real ones runs.
 */

export interface FakeMongoSession extends MongoSession {
  readonly calls: { readonly method: string; readonly args: readonly unknown[] }[];
  documents: string[];
  closed: boolean;
}

function summary(partial: Partial<WriteSummary> & { dryRun: boolean }): WriteSummary {
  return { matchedCount: 0, modifiedCount: 0, deletedCount: 0, ...partial };
}

export function fakeMongoSession(documents: readonly object[] = []): FakeMongoSession {
  const calls: FakeMongoSession['calls'] = [];
  const record = (method: string, args: readonly unknown[]): void => {
    calls.push({ method, args });
  };
  const unused = (method: string) => () => {
    throw new JoineryError({ code: 'NOT_SUPPORTED', message: `${method} is not faked` });
  };
  const fake = {
    engine: 'mongodb' as const,
    serverVersion: '8.0.4',
    currentDatabase: 'test',
    inTransaction: false,
    calls,
    documents: documents.map((doc) => toEjson(doc)),
    closed: false,
    capabilities: () => capabilitiesFor('mongodb', '8.0.4'),
    async *execute() {},
    cancel: async () => undefined,
    introspect: unused('introspect'),
    browse: async () => [],
    ping: async () => undefined,
    close: async () => {
      fake.closed = true;
    },
    useDatabase: async (name: string) => {
      record('useDatabase', [name]);
      fake.currentDatabase = name;
    },
    serverInfo: async () => ({
      version: '8.0.4',
      topology: 'replicaSet' as const,
      setName: 'rs0',
      members: [{ host: '127.0.0.1:27018', state: 'PRIMARY', healthy: true, self: true }],
      modules: [],
    }),
    async *find(...args: unknown[]) {
      record('find', args);
      const options = args[2] as { pageSize?: number } | undefined;
      const size = options?.pageSize ?? 1000;
      for (let i = 0; i < fake.documents.length; i += size) {
        yield { documents: fake.documents.slice(i, i + size) };
      }
    },
    count: async (...args: unknown[]) => {
      record('count', args);
      return fake.documents.length;
    },
    estimatedCount: async (...args: unknown[]) => {
      record('estimatedCount', args);
      return fake.documents.length;
    },
    async *aggregate(...args: unknown[]) {
      record('aggregate', args);
      yield { documents: fake.documents.slice(0, 1) };
    },
    insertOne: async (...args: unknown[]) => {
      record('insertOne', args);
      fake.documents.push(String(args[1]));
      return { insertedId: toEjson('new') };
    },
    replaceOne: async (...args: unknown[]) => {
      record('replaceOne', args);
      const original = String(args[1]);
      const at = fake.documents.indexOf(original);
      if (at < 0) {
        throw new JoineryError({
          code: 'CONFLICT',
          message: 'The document changed since it was read; it was not replaced',
          detail: fake.documents[0] ?? '{}',
        });
      }
      fake.documents[at] = String(args[2]);
      return summary({ dryRun: false, matchedCount: 1, modifiedCount: 1 });
    },
    updateMany: async (...args: unknown[]) => {
      record('updateMany', args);
      const dryRun = (args[3] as { dryRun?: boolean } | undefined)?.dryRun === true;
      const n = fake.documents.length;
      return summary({ dryRun, matchedCount: n, modifiedCount: dryRun ? 0 : n });
    },
    deleteOne: async (...args: unknown[]) => {
      record('deleteOne', args);
      return summary({ dryRun: false, matchedCount: 1, deletedCount: 1 });
    },
    deleteMany: async (...args: unknown[]) => {
      record('deleteMany', args);
      const dryRun = (args[2] as { dryRun?: boolean } | undefined)?.dryRun === true;
      const n = fake.documents.length;
      if (!dryRun) fake.documents = [];
      return summary({ dryRun, matchedCount: n, deletedCount: dryRun ? 0 : n });
    },
    explainQuery: async (...args: unknown[]) => {
      record('explainQuery', args);
      return {
        plan: { id: '1', operation: 'COLLSCAN', detail: {}, children: [] },
        summary: { collectionScan: true, indexes: [], nReturned: fake.documents.length },
        raw: '{}',
      };
    },
    listIndexes: async (...args: unknown[]) => {
      record('listIndexes', args);
      return [];
    },
    createIndex: async (...args: unknown[]) => {
      record('createIndex', args);
      return 'total_1';
    },
    dropIndex: async (...args: unknown[]) => {
      record('dropIndex', args);
    },
    dropCollection: async (...args: unknown[]) => {
      record('dropCollection', args);
    },
    dropDatabase: async (...args: unknown[]) => {
      record('dropDatabase', args);
    },
    async *downloadFile(...args: unknown[]) {
      record('downloadFile', args);
      yield new Uint8Array(300_000).fill(1);
      yield new Uint8Array(300_000).fill(2);
    },
    async *listFiles(...args: unknown[]) {
      record('listFiles', args);
      yield {
        files: [
          {
            id: toEjson('f1'),
            filename: 'a.bin',
            length: 600_000,
            chunkSize: 261_120,
            uploadDate: '2026-09-29T10:00:00.000Z',
          },
        ],
      };
    },
    uploadFile: async (...args: unknown[]) => {
      record('uploadFile', args);
      let bytes = 0;
      for await (const chunk of args[1] as AsyncIterable<Uint8Array>) bytes += chunk.length;
      record('uploaded', [bytes]);
      return toEjson('f2');
    },
    killOp: async (...args: unknown[]) => {
      record('killOp', args);
    },
  };
  Object.setPrototypeOf(fake, MongoDbSession.prototype);
  return fake as unknown as FakeMongoSession;
}

/** An adapter whose sessions are fake MongoDB sessions over the same documents. */
export function fakeMongoAdapter(
  documents: readonly object[] = [],
): DriverAdapter & { sessions: FakeMongoSession[]; profiles: ResolvedProfile[] } {
  const sessions: FakeMongoSession[] = [];
  const profiles: ResolvedProfile[] = [];
  return {
    engine: 'mongodb',
    sessions,
    profiles,
    capabilities: (version) => capabilitiesFor('mongodb', version),
    async connect(resolved): Promise<Session> {
      profiles.push(resolved);
      const session = fakeMongoSession(documents);
      sessions.push(session);
      return session;
    },
  };
}
