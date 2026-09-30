import type { BrowseNode } from '@joinery/core';
import { collectionReference, quoteShellString } from '@joinery/mongo-tools';

import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';

/**
 * The MongoDB object explorer (spec §5): what a tree node from the driver's `browse` stands for,
 * the mongosh command a drop runs (shown before it runs), and the drop itself through the typed
 * services. Paths are database / folder / object, and for collections / "indexes" / index; the
 * folder segments are the driver's stable ids (collections, views, time-series, gridfs, users,
 * roles).
 */

export type MongoObject =
  | { readonly kind: 'database'; readonly db: string }
  | {
      readonly kind: 'collection' | 'view' | 'time-series';
      readonly db: string;
      readonly name: string;
    }
  | {
      readonly kind: 'index';
      readonly db: string;
      readonly collection: string;
      readonly name: string;
    }
  | {
      readonly kind: 'gridfs-bucket' | 'user' | 'role';
      readonly db: string;
      readonly name: string;
    };

/** The object a node stands for; undefined for folders. */
export function mongoObjectOf(node: BrowseNode): MongoObject | undefined {
  const [db, , object, , index] = node.path;
  if (db === undefined) return undefined;
  switch (node.kind) {
    case 'database':
      return { kind: 'database', db };
    case 'collection':
    case 'view':
    case 'time-series':
    case 'gridfs-bucket':
    case 'user':
    case 'role':
      return object === undefined ? undefined : { kind: node.kind, db, name: object };
    case 'index':
      return object === undefined || index === undefined
        ? undefined
        : { kind: 'index', db, collection: object, name: index };
    default:
      return undefined;
  }
}

/** Collections, views and time series open in the collection view on double-click. */
export function opensCollection(node: BrowseNode): boolean {
  return node.kind === 'collection' || node.kind === 'view' || node.kind === 'time-series';
}

/** `db.getSiblingDB('shop')`: the shell's handle on a database. */
export function databaseReference(db: string): string {
  return `db.getSiblingDB(${quoteShellString(db)})`;
}

/** `db.getSiblingDB('shop').orders` (or `.getCollection('…')` for names that need it). */
export function namespaceReference(db: string, collection: string): string {
  return `${databaseReference(db)}${collectionReference(collection).slice('db'.length)}`;
}

/** The mongosh command that drops the object (what the confirmation shows), if it can be dropped. */
export function dropCommand(object: MongoObject): string | undefined {
  switch (object.kind) {
    case 'database':
      return `${databaseReference(object.db)}.dropDatabase()`;
    case 'collection':
    case 'view':
    case 'time-series':
      return `${namespaceReference(object.db, object.name)}.drop()`;
    case 'index':
      return object.name === '_id_'
        ? undefined
        : `${namespaceReference(object.db, object.collection)}.dropIndex(${quoteShellString(object.name)})`;
    case 'user':
      return `${databaseReference(object.db)}.dropUser(${quoteShellString(object.name)})`;
    case 'role':
      return `${databaseReference(object.db)}.dropRole(${quoteShellString(object.name)})`;
    case 'gridfs-bucket':
      return undefined;
  }
}

/** What the drop confirmation calls the object: "collection shop.orders". */
export function describeObject(object: MongoObject): string {
  switch (object.kind) {
    case 'database':
      return `database ${object.db}`;
    case 'time-series':
      return `time series collection ${object.db}.${object.name}`;
    case 'index':
      return `index ${object.name} of ${object.db}.${object.collection}`;
    case 'gridfs-bucket':
      return `GridFS bucket ${object.db}.${object.name}`;
    default:
      return `${object.kind} ${object.kind === 'user' || object.kind === 'role' ? `${object.name}@${object.db}` : `${object.db}.${object.name}`}`;
  }
}

/** The tree folder that lists the object, reloaded after it is dropped. */
export function listingPath(object: MongoObject): string[] {
  switch (object.kind) {
    case 'database':
      return [];
    case 'collection':
      return [object.db, 'collections'];
    case 'view':
      return [object.db, 'views'];
    case 'time-series':
      return [object.db, 'time-series'];
    case 'index':
      return [object.db, 'collections', object.collection, 'indexes'];
    case 'gridfs-bucket':
      return [object.db, 'gridfs'];
    case 'user':
      return [object.db, 'users'];
    case 'role':
      return [object.db, 'roles'];
  }
}

/** One session per connection for the explorer's own actions (drops), opened on first use. */
const lanes = new Map<string, SessionLane>();

function laneFor(profileId: string): SessionLane {
  let lane = lanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    lanes.set(profileId, lane);
  }
  return lane;
}

/**
 * Drops the object after the user confirmed its command, then reloads the folder that listed
 * it. The connection host applies the write rules again (a read-only profile refuses).
 */
export async function dropMongoObject(profileId: string, object: MongoObject): Promise<void> {
  await laneFor(profileId).run(async (host, sessionId) => {
    const confirmed = true;
    switch (object.kind) {
      case 'database':
        return host.mongo.collections.dropDatabase({ sessionId, db: object.db, confirmed });
      case 'collection':
      case 'view':
      case 'time-series':
        return host.mongo.collections.drop({
          sessionId,
          ns: { db: object.db, collection: object.name },
          confirmed,
        });
      case 'index':
        return host.mongo.indexes.drop({
          sessionId,
          ns: { db: object.db, collection: object.collection },
          name: object.name,
          confirmed,
        });
      case 'user':
        return host.mongo.users.drop({ sessionId, db: object.db, user: object.name, confirmed });
      case 'role':
        return host.mongo.roles.drop({ sessionId, db: object.db, role: object.name, confirmed });
      case 'gridfs-bucket':
        return undefined;
    }
  });
  await loadChildren(profileId, listingPath(object));
}
