import { QuerybaraError, type BrowseNode, type BrowseNodeKind } from '@querybara/core';
import type { Document } from 'mongodb';

import { indexKind, numberOf, statsOf } from './admin';
import { ejson, type MongoContext } from './context';
import { gridFsBuckets } from './gridfs';

/**
 * The MongoDB object explorer tree (spec §5), one level at a time:
 *
 *     database / folder / collection (or time series) / "indexes" / index
 *
 * Folder segments are stable ids (`collections`, `views`, `time-series`, `gridfs`, `users`,
 * `roles`, `indexes`); their display name is in `name`. GridFS buckets are found as
 * `<bucket>.files` / `<bucket>.chunks` pairs, and those two collections are left out of
 * Collections, as are `system.*` collections. Nothing reads documents: sizes and counts come from
 * listDatabases and $collStats (bounded: the first 200 collections of a folder, 8 at a time).
 */

export const MONGO_FOLDERS = [
  ['collections', 'Collections'],
  ['views', 'Views'],
  ['time-series', 'Time series'],
  ['gridfs', 'GridFS buckets'],
  ['users', 'Users'],
  ['roles', 'Roles'],
] as const;

const STATS_LIMIT = 200;
const STATS_CONCURRENCY = 8;

type Detail = Record<string, string | number | null>;

function node(
  kind: BrowseNodeKind,
  name: string,
  path: readonly string[],
  hasChildren: boolean,
  extra?: Record<string, string | number | null | undefined>,
): BrowseNode {
  const detail: Detail = {};
  for (const [key, value] of Object.entries(extra ?? {}))
    if (value !== undefined) detail[key] = value;
  return {
    kind,
    name,
    path,
    hasChildren,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

function notFound(path: readonly string[]): QuerybaraError {
  return new QuerybaraError({
    code: 'NOT_FOUND',
    message: `Nothing to browse at ${path.join(' / ')}`,
  });
}

/** Runs `work` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await work(items[index]!);
    }
  });
  await Promise.all(runners);
  return out;
}

/** listCollections with options; falls back to names only for users without listCollections. */
async function collectionsOf(ctx: MongoContext, db: string): Promise<Document[]> {
  try {
    return await ctx.db(db).listCollections({}, { nameOnly: false }).toArray();
  } catch (error) {
    if (numberOf((error as { code?: unknown }).code) !== 13) throw error;
    return ctx
      .db(db)
      .listCollections({}, { nameOnly: true, authorizedCollections: true })
      .toArray();
  }
}

function isHidden(name: string, buckets: ReadonlySet<string>): boolean {
  if (name.startsWith('system.')) return true;
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  const suffix = name.slice(dot + 1);
  return (suffix === 'files' || suffix === 'chunks') && buckets.has(name.slice(0, dot));
}

export async function browseMongo(
  ctx: MongoContext,
  path: readonly string[],
): Promise<BrowseNode[]> {
  if (path.length === 0) {
    const reply = await ctx
      .db('admin')
      .command({ listDatabases: 1, nameOnly: false, authorizedDatabases: true });
    const databases = Array.isArray(reply['databases']) ? (reply['databases'] as Document[]) : [];
    return databases
      .map((d) =>
        node('database', String(d['name']), [String(d['name'])], true, {
          sizeOnDisk: numberOf(d['sizeOnDisk']),
          empty: d['empty'] === true ? 'yes' : undefined,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const [db, folder, object, sub] = path;
  if (path.length === 1) {
    return MONGO_FOLDERS.map(([id, label]) => node('folder', label, [db!, id], true));
  }
  if (path.length === 2) {
    switch (folder) {
      case 'collections':
      case 'views':
      case 'time-series':
        return listFolder(ctx, db!, folder);
      case 'gridfs':
        return listBuckets(ctx, db!);
      case 'users':
        return listUsers(ctx, db!);
      case 'roles':
        return listRoles(ctx, db!);
      default:
        throw notFound(path);
    }
  }
  if (folder !== 'collections' && folder !== 'time-series') throw notFound(path);
  if (path.length === 3)
    return [node('folder', 'Indexes', [db!, folder, object!, 'indexes'], true)];
  if (path.length === 4 && sub === 'indexes') {
    const specs = await ctx.db(db!).collection(object!).listIndexes().toArray();
    return specs.map((spec) => {
      const keys = (spec['key'] ?? {}) as Document;
      return node('index', String(spec['name']), [...path, String(spec['name'])], false, {
        keys: ejson(keys),
        kind: indexKind(keys, spec),
        unique: spec['unique'] === true ? 'yes' : undefined,
        hidden: spec['hidden'] === true ? 'yes' : undefined,
        expireAfterSeconds: numberOf(spec['expireAfterSeconds']),
      });
    });
  }
  throw notFound(path);
}

async function listFolder(
  ctx: MongoContext,
  db: string,
  folder: 'collections' | 'views' | 'time-series',
): Promise<BrowseNode[]> {
  const all = await collectionsOf(ctx, db);
  const buckets = new Set(gridFsBuckets(all.map((c) => String(c['name']))));
  const type = folder === 'collections' ? 'collection' : folder === 'views' ? 'view' : 'timeseries';
  const entries = all
    .filter((c) => (c['type'] ?? 'collection') === type && !isHidden(String(c['name']), buckets))
    .sort((a, b) => String(a['name']).localeCompare(String(b['name'])));
  if (folder === 'views') {
    return entries.map((c) => {
      const options = (c['options'] ?? {}) as Document;
      const name = String(c['name']);
      return node('view', name, [db, folder, name], false, {
        viewOn: typeof options['viewOn'] === 'string' ? options['viewOn'] : undefined,
      });
    });
  }
  const stats = await mapLimited(entries.slice(0, STATS_LIMIT), STATS_CONCURRENCY, (c) =>
    statsOf(ctx, { db, collection: String(c['name']) }, 2000),
  );
  return entries.map((c, i) => {
    const name = String(c['name']);
    const options = (c['options'] ?? {}) as Document;
    const s = stats[i];
    const ts = (options['timeseries'] ?? {}) as Document;
    return node(
      folder === 'collections' ? 'collection' : 'time-series',
      name,
      [db, folder, name],
      true,
      {
        count: s?.count,
        size: s?.size,
        storageSize: s?.storageSize,
        indexSize: s?.totalIndexSize,
        indexes: s?.indexCount,
        capped: options['capped'] === true ? 'yes' : undefined,
        timeField: typeof ts['timeField'] === 'string' ? ts['timeField'] : undefined,
        metaField: typeof ts['metaField'] === 'string' ? ts['metaField'] : undefined,
        granularity: typeof ts['granularity'] === 'string' ? ts['granularity'] : undefined,
      },
    );
  });
}

async function listBuckets(ctx: MongoContext, db: string): Promise<BrowseNode[]> {
  const names = (await collectionsOf(ctx, db)).map((c) => String(c['name']));
  const buckets = gridFsBuckets(names);
  const counts = await mapLimited(buckets.slice(0, STATS_LIMIT), STATS_CONCURRENCY, (bucket) =>
    ctx
      .db(db)
      .collection(`${bucket}.files`)
      .estimatedDocumentCount({ maxTimeMS: 2000 })
      .catch(() => undefined),
  );
  return buckets.map((bucket, i) =>
    node('gridfs-bucket', bucket, [db, 'gridfs', bucket], false, { files: counts[i] }),
  );
}

async function listUsers(ctx: MongoContext, db: string): Promise<BrowseNode[]> {
  const reply = await ctx.db(db).command({ usersInfo: 1 });
  const users = Array.isArray(reply['users']) ? (reply['users'] as Document[]) : [];
  return users
    .map((u) => {
      const roles = Array.isArray(u['roles']) ? (u['roles'] as Document[]) : [];
      const name = String(u['user']);
      return node('user', name, [db, 'users', name], false, {
        roles: roles.map((r) => `${String(r['role'])}@${String(r['db'])}`).join(', '),
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listRoles(ctx: MongoContext, db: string): Promise<BrowseNode[]> {
  const reply = await ctx.db(db).command({ rolesInfo: 1, showBuiltinRoles: false });
  const roles = Array.isArray(reply['roles']) ? (reply['roles'] as Document[]) : [];
  return roles
    .map((r) => {
      const inherited = Array.isArray(r['roles']) ? (r['roles'] as Document[]) : [];
      const name = String(r['role']);
      return node('role', name, [db, 'roles', name], false, {
        roles: inherited.map((x) => `${String(x['role'])}@${String(x['db'])}`).join(', '),
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
