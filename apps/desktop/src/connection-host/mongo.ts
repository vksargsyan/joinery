import { JoineryError, type ConnectionProfile, type Session } from '@joinery/core';
import type { MongoSession, isMongoSession } from '@joinery/driver-mongodb';
import type { HandlersOf, mongoHostContractShape } from '@joinery/ipc';

import { checkMongoWrite, pipelineWrites, type WriteRequest } from '../shared/mongo-writes';

/**
 * The connection host's `mongo.*` handlers (spec §9): each one finds the call's session, checks
 * it is a MongoDB session and calls the matching MongoSession service. Documents stay canonical
 * Extended JSON end to end, so nothing is converted here.
 *
 * The write rules (spec §4) are enforced here whatever the page sends, as `applyChanges` does for
 * the SQL grid: a read-only profile refuses every write (a dry run only counts, so it runs);
 * destructive operations (drops, bulk updates and deletes, index drops, killOp) need the page's
 * `confirmed` on every profile; on production profiles and profiles that confirm writes every
 * write needs it.
 */

type MongoHandlers = HandlersOf<typeof mongoHostContractShape>;

export interface MongoHandlerContext {
  /** The session a call names; throws NOT_FOUND when it was closed. */
  readonly session: (sessionId: string) => Session;
  /** The connection's profile: its presentation holds the write rules. */
  readonly profile: ConnectionProfile;
}

let isMongo: Promise<typeof isMongoSession> | undefined;

/**
 * A session as a MongoSession, or NOT_SUPPORTED. The driver is imported on demand (a connection
 * host only loads its own engine's driver); by the time a MongoDB session exists it is loaded.
 */
export async function asMongoSession(session: Session): Promise<MongoSession> {
  if (session.engine !== 'mongodb') throw notMongo();
  isMongo ??= import('@joinery/driver-mongodb').then((driver) => driver.isMongoSession);
  if (!(await isMongo)(session)) throw notMongo();
  return session;
}

function notMongo(): JoineryError {
  return new JoineryError({
    code: 'NOT_SUPPORTED',
    message: 'MongoDB services need a MongoDB connection',
  });
}

function nsText(ns: { readonly db: string; readonly collection: string }): string {
  return `${ns.db}.${ns.collection}`;
}

/** Drops undefined values, so optional inputs are left out of the driver's options. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/** Reads at most `limit` bytes from a download, then stops it. */
async function readUpTo(
  chunks: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const parts: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  for await (const chunk of chunks) {
    const room = limit - length;
    if (chunk.length > room) {
      if (room > 0) parts.push(chunk.subarray(0, room));
      length += Math.max(room, 0);
      truncated = true;
      break;
    }
    parts.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return { bytes, truncated };
}

/** Default preview size of `gridfs.read`. */
const GRIDFS_READ_DEFAULT = 256 * 1024;

export function mongoHandlers(context: MongoHandlerContext): MongoHandlers {
  const { profile } = context;
  const session = (sessionId: string): Promise<MongoSession> =>
    asMongoSession(context.session(sessionId));
  const write = (request: WriteRequest, what: string, destructive = false): void =>
    checkMongoWrite(profile, request, what, destructive);

  return {
    serverInfo: async ({ sessionId }) => (await session(sessionId)).serverInfo(),
    useDatabase: async ({ sessionId, database }) => {
      await (await session(sessionId)).useDatabase(database);
    },

    async *find({ sessionId, ns, query, pageSize, executionId }, { signal }) {
      const s = await session(sessionId);
      yield* s.find(ns, query, defined({ pageSize, executionId, signal }));
    },
    count: async ({ sessionId, ns, filter, executionId, maxTimeMS }, { signal }) => ({
      count: await (
        await session(sessionId)
      ).count(ns, filter, defined({ executionId, maxTimeMS, signal })),
    }),
    estimatedCount: async ({ sessionId, ns, maxTimeMS }, { signal }) => ({
      count: await (await session(sessionId)).estimatedCount(ns, defined({ maxTimeMS, signal })),
    }),
    async *aggregate(input, { signal }) {
      const { sessionId, ns, pipeline, confirmed, ...options } = input;
      if (pipelineWrites(pipeline)) {
        write({ confirmed }, `Writing the results of a pipeline on ${nsText(ns)} ($out/$merge)`);
      }
      const s = await session(sessionId);
      yield* s.aggregate(ns, pipeline, defined({ ...options, signal }));
    },
    previewStage: async (input, { signal }) => {
      const { sessionId, ns, pipeline, stageIndex, ...options } = input;
      return (await session(sessionId)).previewStage(
        ns,
        pipeline,
        stageIndex,
        defined({ ...options, signal }),
      );
    },

    insertOne: async ({ sessionId, ns, document, confirmed }, { signal }) => {
      const s = await session(sessionId);
      write({ confirmed }, `Inserting a document into ${nsText(ns)}`);
      return s.insertOne(ns, document, { signal });
    },
    insertMany: async ({ sessionId, ns, documents, ordered, confirmed }, { signal }) => {
      const s = await session(sessionId);
      write({ confirmed }, `Inserting documents into ${nsText(ns)}`);
      return s.insertMany(ns, documents, defined({ ordered, signal }));
    },
    replaceOne: async ({ sessionId, ns, original, replacement, confirmed }, { signal }) => {
      const s = await session(sessionId);
      write({ confirmed }, `Replacing a document in ${nsText(ns)}`);
      return s.replaceOne(ns, original, replacement, { signal });
    },
    updateMany: async (input, { signal }) => {
      const { sessionId, ns, filter, update, confirmed, ...options } = input;
      const s = await session(sessionId);
      write({ confirmed, dryRun: options.dryRun }, `Updating documents in ${nsText(ns)}`, true);
      return s.updateMany(ns, filter, update, defined({ ...options, signal }));
    },
    deleteOne: async ({ sessionId, ns, id, dryRun, confirmed }, { signal }) => {
      const s = await session(sessionId);
      write({ confirmed, dryRun }, `Deleting a document from ${nsText(ns)}`);
      return s.deleteOne(ns, id, defined({ dryRun, signal }));
    },
    deleteMany: async ({ sessionId, ns, filter, dryRun, confirmed, ...options }, { signal }) => {
      const s = await session(sessionId);
      write({ confirmed, dryRun }, `Deleting documents from ${nsText(ns)}`, true);
      return s.deleteMany(ns, filter, defined({ ...options, dryRun, signal }));
    },
    explain: async ({ sessionId, ns, target, verbosity, maxTimeMS }, { signal }) =>
      (await session(sessionId)).explainQuery(
        ns,
        target,
        verbosity,
        defined({ maxTimeMS, signal }),
      ),
    analyzeSchema: async ({ sessionId, ns, options }, { signal }) =>
      (await session(sessionId)).analyzeSchema(ns, defined({ ...options, signal })),
    async *watch({ sessionId, scope, pipeline, options }, { signal }) {
      const s = await session(sessionId);
      yield* s.watch(scope, pipeline, defined({ ...options, signal }));
    },

    indexes: {
      list: async ({ sessionId, ns }) => (await session(sessionId)).listIndexes(ns),
      create: async ({ sessionId, ns, spec, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Creating an index on ${nsText(ns)}`);
        return { name: await s.createIndex(ns, spec) };
      },
      drop: async ({ sessionId, ns, name, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Dropping the index ${name} of ${nsText(ns)}`, true);
        await s.dropIndex(ns, name);
      },
      setHidden: async ({ sessionId, ns, name, hidden, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `${hidden ? 'Hiding' : 'Unhiding'} the index ${name}`);
        await s.setIndexHidden(ns, name, hidden);
      },
    },

    collections: {
      info: async ({ sessionId, ns }) => (await session(sessionId)).collectionInfo(ns),
      create: async ({ sessionId, ns, spec, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Creating the collection ${nsText(ns)}`);
        await s.createCollection(ns, spec);
      },
      createView: async ({ sessionId, ns, viewOn, pipeline, collation, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Creating the view ${nsText(ns)}`);
        await s.createView(ns, viewOn, pipeline, defined({ collation }));
      },
      collMod: async ({ sessionId, ns, changes, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Changing the options of ${nsText(ns)}`);
        await s.collMod(ns, changes);
      },
      rename: async ({ sessionId, ns, to, dropTarget, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Renaming ${nsText(ns)} to ${to}`, dropTarget === true);
        await s.renameCollection(ns, to, defined({ dropTarget }));
      },
      drop: async ({ sessionId, ns, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Dropping ${nsText(ns)}`, true);
        await s.dropCollection(ns);
      },
      dropDatabase: async ({ sessionId, db, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Dropping the database ${db}`, true);
        await s.dropDatabase(db);
      },
    },

    gridfs: {
      buckets: async ({ sessionId, db }) => (await session(sessionId)).listBuckets(db),
      async *list({ sessionId, bucket, ...options }) {
        const s = await session(sessionId);
        for await (const page of s.listFiles(bucket, defined(options))) {
          yield { files: [...page.files] };
        }
      },
      read: async ({ sessionId, bucket, id, maxBytes }, { signal }) => {
        const s = await session(sessionId);
        return readUpTo(s.downloadFile(bucket, id, { signal }), maxBytes ?? GRIDFS_READ_DEFAULT);
      },
      delete: async ({ sessionId, bucket, id, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Deleting a file from the ${bucket.bucket} bucket`, true);
        await s.deleteFile(bucket, id);
      },
      rename: async ({ sessionId, bucket, id, filename, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Renaming a file in the ${bucket.bucket} bucket`);
        await s.renameFile(bucket, id, filename);
      },
    },

    users: {
      list: async ({ sessionId, db, user, showPrivileges }) =>
        (await session(sessionId)).usersInfo(db, defined({ user, showPrivileges })),
      create: async ({ sessionId, db, spec, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Creating the user ${spec.user}@${db}`);
        await s.createUser(db, spec);
      },
      update: async ({ sessionId, db, user, spec, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Changing the user ${user}@${db}`);
        await s.updateUser(db, user, spec);
      },
      drop: async ({ sessionId, db, user, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Dropping the user ${user}@${db}`, true);
        await s.dropUser(db, user);
      },
      grantRoles: async ({ sessionId, db, user, roles, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Granting roles to ${user}@${db}`);
        await s.grantRoles(db, user, roles);
      },
      revokeRoles: async ({ sessionId, db, user, roles, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Revoking roles from ${user}@${db}`);
        await s.revokeRoles(db, user, roles);
      },
    },

    roles: {
      list: async ({ sessionId, db, role, showPrivileges, showBuiltinRoles }) =>
        (await session(sessionId)).rolesInfo(
          db,
          defined({ role, showPrivileges, showBuiltinRoles }),
        ),
      create: async ({ sessionId, db, spec, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Creating the role ${spec.role}@${db}`);
        await s.createRole(db, spec);
      },
      update: async ({ sessionId, db, role, spec, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Changing the role ${role}@${db}`);
        await s.updateRole(db, role, defined(spec));
      },
      drop: async ({ sessionId, db, role, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Dropping the role ${role}@${db}`, true);
        await s.dropRole(db, role);
      },
    },

    admin: {
      currentOp: async ({ sessionId, ...options }) =>
        (await session(sessionId)).currentOp(defined(options)),
      killOp: async ({ sessionId, opid, confirmed }) => {
        const s = await session(sessionId);
        write({ confirmed }, `Killing operation ${opid}`, true);
        await s.killOp(opid);
      },
      serverStatus: async ({ sessionId }) => (await session(sessionId)).serverStatus(),
      top: async ({ sessionId }) => (await session(sessionId)).top(),
    },
  };
}
