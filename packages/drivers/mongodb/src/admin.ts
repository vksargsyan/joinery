import { JoineryError } from '@joinery/core';
import {
  Int32,
  bsonTag,
  toEjson,
  type CollectionInfo,
  type CollectionStats,
  type CollectionType,
  type CollModSpec,
  type CreateCollectionSpec,
  type CreateUserSpec,
  type IndexInfo,
  type IndexKind,
  type IndexSpec,
  type MongoServerInfo,
  type Namespace,
  type Privilege,
  type RoleInfo,
  type RoleRef,
  type RoleSpec,
  type ServerStatusSummary,
  type TimeSeriesOptions,
  type TopEntry,
  type TopologyKind,
  type TopologyMember,
  type UpdateUserSpec,
  type UserInfo,
  type ValidationAction,
  type ValidationLevel,
} from '@joinery/mongo-tools';
import type { Document, IndexSpecification } from 'mongodb';

import {
  checkCollectionName,
  documentArg,
  documentsArg,
  driverDoc,
  ejson,
  type MongoContext,
} from './context';
import type { CurrentOpOptions } from './types';

/**
 * Index, collection, user and role administration and the admin reads for the server tools
 * view (spec §9 "Schema and admin", §15). Document-valued options are Extended JSON text.
 */

/** A JS number from a number or a bson numeric wrapper; undefined otherwise. */
export function numberOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  switch (bsonTag(value)) {
    case 'Int32':
    case 'Double':
      return (value as { value: number }).value;
    case 'Long':
    case 'Decimal128':
      return Number(String(value));
    default:
      return undefined;
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function docOf(value: unknown): Document | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Document)
    : undefined;
}

/** The kind of an index from its key pattern. */
export function indexKind(keys: Document, spec: Document = {}): IndexKind {
  if (spec['clustered'] === true) return 'clustered';
  const entries = Object.entries(keys);
  if (entries.some(([field]) => field === '$**' || field.endsWith('.$**'))) return 'wildcard';
  for (const [, value] of entries) {
    if (value === 'text') return 'text';
    if (value === '2dsphere') return '2dsphere';
    if (value === '2d') return '2d';
    if (value === 'hashed') return 'hashed';
  }
  return entries.length === 1 ? 'single' : 'compound';
}

// ---------------------------------------------------------------------------- indexes

/** Index sizes from $collStats and usage from $indexStats; missing when not permitted. */
async function indexStatistics(
  ctx: MongoContext,
  ns: Namespace,
): Promise<{ sizes: Document; usage: Map<string, Document> }> {
  const collection = ctx.db(ns.db).collection(ns.collection);
  const [sizes, usage] = await Promise.all([
    collection
      .aggregate([{ $collStats: { storageStats: {} } }], { maxTimeMS: 5000 })
      .toArray()
      .then((rows) => docOf(docOf(rows[0]?.['storageStats'])?.['indexSizes']) ?? {})
      .catch(() => ({}) as Document),
    collection
      .aggregate([{ $indexStats: {} }], { maxTimeMS: 5000 })
      .toArray()
      .then((rows) => new Map(rows.map((row) => [String(row['name']), row])))
      .catch(() => new Map<string, Document>()),
  ]);
  return { sizes, usage };
}

export async function listIndexes(ctx: MongoContext, ns: Namespace): Promise<IndexInfo[]> {
  return ctx.exclusive(async () => {
    const specs = await ctx.collection(ns).listIndexes(ctx.sessionOption()).toArray();
    const { sizes, usage } = await indexStatistics(ctx, ns);
    return specs.map((spec): IndexInfo => {
      const name = String(spec['name']);
      const keys = docOf(spec['key']) ?? {};
      const used = usage.get(name);
      const accesses = docOf(used?.['accesses']);
      const ttl = numberOf(spec['expireAfterSeconds']);
      const size = numberOf(sizes[name]);
      const ops = numberOf(accesses?.['ops']);
      const since = accesses?.['since'];
      return {
        name,
        keys: ejson(keys),
        kind: indexKind(keys, spec),
        unique: spec['unique'] === true,
        sparse: spec['sparse'] === true,
        hidden: spec['hidden'] === true,
        ...(ttl !== undefined ? { expireAfterSeconds: ttl } : {}),
        ...(spec['partialFilterExpression'] !== undefined
          ? { partialFilterExpression: ejson(spec['partialFilterExpression']) }
          : {}),
        ...(spec['collation'] !== undefined ? { collation: ejson(spec['collation']) } : {}),
        ...(spec['wildcardProjection'] !== undefined
          ? { wildcardProjection: ejson(spec['wildcardProjection']) }
          : {}),
        spec: ejson(spec),
        ...(size !== undefined ? { size } : {}),
        ...(ops !== undefined ? { usageOps: ops } : {}),
        ...(since instanceof Date ? { usageSince: since.toISOString() } : {}),
        ...(used?.['building'] === true ? { building: true } : {}),
      };
    });
  });
}

export async function createIndex(
  ctx: MongoContext,
  ns: Namespace,
  spec: IndexSpec,
): Promise<string> {
  const keys = documentArg(spec.keys, 'index keys');
  if (Object.keys(keys).length === 0) {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'An index needs at least one key',
    });
  }
  const options: Document = {};
  const set = (key: string, value: unknown): void => {
    if (value !== undefined) options[key] = value;
  };
  set('name', spec.name);
  set('unique', spec.unique);
  set('sparse', spec.sparse);
  set('hidden', spec.hidden);
  set('expireAfterSeconds', spec.expireAfterSeconds);
  set(
    'partialFilterExpression',
    spec.partialFilterExpression && documentArg(spec.partialFilterExpression, 'partial filter'),
  );
  set('collation', spec.collation && documentArg(spec.collation, 'collation'));
  set(
    'wildcardProjection',
    spec.wildcardProjection && documentArg(spec.wildcardProjection, 'wildcard projection'),
  );
  set('weights', spec.weights && documentArg(spec.weights, 'weights'));
  set('default_language', spec.defaultLanguage);
  set('language_override', spec.languageOverride);
  set('textIndexVersion', spec.textIndexVersion);
  set('2dsphereIndexVersion', spec['2dsphereIndexVersion']);
  set('bits', spec.bits);
  set('min', spec.min);
  set('max', spec.max);
  return ctx.exclusive(() =>
    ctx
      .collection(ns)
      .createIndex(driverDoc<IndexSpecification>(keys), { ...options, ...ctx.sessionOption() }),
  );
}

export async function dropIndex(ctx: MongoContext, ns: Namespace, name: string): Promise<void> {
  if (name === '_id_') {
    throw new JoineryError({
      code: 'VALIDATION_FAILED',
      message: 'The _id index cannot be dropped',
    });
  }
  await ctx.exclusive(() => ctx.collection(ns).dropIndex(name, ctx.sessionOption()));
}

export async function setIndexHidden(
  ctx: MongoContext,
  ns: Namespace,
  name: string,
  hidden: boolean,
): Promise<void> {
  await ctx.exclusive(() =>
    ctx
      .db(ns.db)
      .command(
        { collMod: checkCollectionName(ns.collection), index: { name, hidden } },
        ctx.sessionOption(),
      ),
  );
}

// ---------------------------------------------------------------------------- collections

function collectionStats(row: Document | undefined): CollectionStats | undefined {
  const storage = docOf(row?.['storageStats']);
  if (!storage && row?.['count'] === undefined) return undefined;
  const stats: { -readonly [K in keyof CollectionStats]: CollectionStats[K] } = {};
  const count = numberOf(row?.['count']) ?? numberOf(storage?.['count']);
  if (count !== undefined) stats.count = count;
  const size = numberOf(storage?.['size']);
  if (size !== undefined) stats.size = size;
  const storageSize = numberOf(storage?.['storageSize']);
  if (storageSize !== undefined) stats.storageSize = storageSize;
  const avg = numberOf(storage?.['avgObjSize']);
  if (avg !== undefined) stats.avgObjSize = avg;
  const indexSize = numberOf(storage?.['totalIndexSize']);
  if (indexSize !== undefined) stats.totalIndexSize = indexSize;
  const indexes = numberOf(storage?.['nindexes']);
  if (indexes !== undefined) stats.indexCount = indexes;
  return stats;
}

/** $collStats with storage stats and count; undefined for views or without the privilege. */
export async function statsOf(
  ctx: MongoContext,
  ns: Namespace,
  maxTimeMS = 5000,
): Promise<CollectionStats | undefined> {
  try {
    const rows = await ctx
      .db(ns.db)
      .collection(ns.collection)
      .aggregate([{ $collStats: { storageStats: {}, count: {} } }], { maxTimeMS })
      .toArray();
    return collectionStats(rows[0]);
  } catch {
    return undefined;
  }
}

export async function collectionInfo(ctx: MongoContext, ns: Namespace): Promise<CollectionInfo> {
  return ctx.exclusive(async () => {
    const entries = await ctx
      .rawDb(ns.db)
      .listCollections({ name: checkCollectionName(ns.collection) }, { nameOnly: false })
      .toArray();
    const entry = entries[0];
    if (!entry) {
      throw new JoineryError({
        code: 'NOT_FOUND',
        message: `There is no collection "${ns.collection}" in database "${ns.db}"`,
      });
    }
    const options = docOf(entry['options']) ?? {};
    const info = docOf(entry['info']) ?? {};
    const type: CollectionType =
      entry['type'] === 'view'
        ? 'view'
        : entry['type'] === 'timeseries'
          ? 'timeseries'
          : 'collection';
    const ttl = numberOf(options['expireAfterSeconds']);
    const timeseries = docOf(options['timeseries']);
    const stats = type === 'view' ? undefined : await statsOf(ctx, ns);
    return {
      name: String(entry['name']),
      type,
      options: ejson(options),
      readOnly: info['readOnly'] === true,
      capped: options['capped'] === true,
      ...(options['validator'] !== undefined ? { validator: ejson(options['validator']) } : {}),
      ...(typeof options['validationLevel'] === 'string'
        ? { validationLevel: options['validationLevel'] as ValidationLevel }
        : {}),
      ...(typeof options['validationAction'] === 'string'
        ? { validationAction: options['validationAction'] as ValidationAction }
        : {}),
      ...(options['collation'] !== undefined ? { collation: ejson(options['collation']) } : {}),
      ...(timeseries ? { timeseries: timeSeriesOf(timeseries) } : {}),
      ...(ttl !== undefined ? { expireAfterSeconds: ttl } : {}),
      ...(typeof options['viewOn'] === 'string' ? { viewOn: options['viewOn'] } : {}),
      ...(options['pipeline'] !== undefined ? { pipeline: ejson(options['pipeline']) } : {}),
      clustered: options['clusteredIndex'] !== undefined,
      ...(stats ? { stats } : {}),
    };
  });
}

function timeSeriesOf(doc: Document): TimeSeriesOptions {
  const granularity = stringOf(doc['granularity']);
  const span = numberOf(doc['bucketMaxSpanSeconds']);
  const rounding = numberOf(doc['bucketRoundingSeconds']);
  return {
    timeField: String(doc['timeField']),
    ...(typeof doc['metaField'] === 'string' ? { metaField: doc['metaField'] } : {}),
    ...(granularity === 'seconds' || granularity === 'minutes' || granularity === 'hours'
      ? { granularity }
      : {}),
    ...(span !== undefined ? { bucketMaxSpanSeconds: span } : {}),
    ...(rounding !== undefined ? { bucketRoundingSeconds: rounding } : {}),
  };
}

export async function createCollection(
  ctx: MongoContext,
  ns: Namespace,
  spec: CreateCollectionSpec = {},
): Promise<void> {
  const command: Document = { create: checkCollectionName(ns.collection) };
  if (spec.capped) {
    command['capped'] = true;
    command['size'] = spec.capped.size;
    if (spec.capped.max !== undefined) command['max'] = spec.capped.max;
  }
  if (spec.timeseries) {
    const ts = spec.timeseries;
    command['timeseries'] = {
      timeField: ts.timeField,
      ...(ts.metaField !== undefined ? { metaField: ts.metaField } : {}),
      ...(ts.granularity !== undefined ? { granularity: ts.granularity } : {}),
      ...(ts.bucketMaxSpanSeconds !== undefined
        ? { bucketMaxSpanSeconds: ts.bucketMaxSpanSeconds }
        : {}),
      ...(ts.bucketRoundingSeconds !== undefined
        ? { bucketRoundingSeconds: ts.bucketRoundingSeconds }
        : {}),
    };
  }
  if (spec.expireAfterSeconds !== undefined)
    command['expireAfterSeconds'] = spec.expireAfterSeconds;
  if (spec.clustered) {
    command['clusteredIndex'] = {
      key: { _id: new Int32(1) },
      unique: true,
      ...(spec.clustered.name !== undefined ? { name: spec.clustered.name } : {}),
    };
  }
  if (spec.collation !== undefined) command['collation'] = documentArg(spec.collation, 'collation');
  if (spec.validator !== undefined) command['validator'] = documentArg(spec.validator, 'validator');
  if (spec.validationLevel !== undefined) command['validationLevel'] = spec.validationLevel;
  if (spec.validationAction !== undefined) command['validationAction'] = spec.validationAction;
  await ctx.exclusive(() => ctx.db(ns.db).command(command, ctx.sessionOption()));
}

export async function createView(
  ctx: MongoContext,
  ns: Namespace,
  viewOn: string,
  pipeline: string,
  opts: { readonly collation?: string } = {},
): Promise<void> {
  const command: Document = {
    create: checkCollectionName(ns.collection),
    viewOn: checkCollectionName(viewOn),
    pipeline: documentsArg(pipeline, 'pipeline'),
  };
  if (opts.collation !== undefined) command['collation'] = documentArg(opts.collation, 'collation');
  await ctx.exclusive(() => ctx.db(ns.db).command(command, ctx.sessionOption()));
}

export async function collMod(
  ctx: MongoContext,
  ns: Namespace,
  changes: CollModSpec,
): Promise<void> {
  const command: Document = { collMod: checkCollectionName(ns.collection) };
  if (changes.validator !== undefined)
    command['validator'] = documentArg(changes.validator, 'validator');
  if (changes.validationLevel !== undefined) command['validationLevel'] = changes.validationLevel;
  if (changes.validationAction !== undefined)
    command['validationAction'] = changes.validationAction;
  if (changes.expireAfterSeconds !== undefined)
    command['expireAfterSeconds'] = changes.expireAfterSeconds;
  if (Object.keys(command).length === 1) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Nothing to change' });
  }
  await ctx.exclusive(() => ctx.db(ns.db).command(command, ctx.sessionOption()));
}

export async function renameCollection(
  ctx: MongoContext,
  ns: Namespace,
  to: string,
  opts: { readonly dropTarget?: boolean } = {},
): Promise<void> {
  await ctx.exclusive(() =>
    ctx.db('admin').command({
      renameCollection: `${ns.db}.${checkCollectionName(ns.collection)}`,
      to: `${ns.db}.${checkCollectionName(to)}`,
      dropTarget: opts.dropTarget ?? false,
    }),
  );
}

export async function dropCollection(ctx: MongoContext, ns: Namespace): Promise<void> {
  await ctx.exclusive(() =>
    ctx.db(ns.db).command({ drop: checkCollectionName(ns.collection) }, ctx.sessionOption()),
  );
}

export async function dropDatabase(ctx: MongoContext, db: string): Promise<void> {
  await ctx.exclusive(() => ctx.db(db).command({ dropDatabase: 1 }));
}

// ---------------------------------------------------------------------------- users and roles

function roleRefs(value: unknown): RoleRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RoleRef[] => {
    const doc = docOf(item);
    return doc && typeof doc['role'] === 'string' && typeof doc['db'] === 'string'
      ? [{ role: doc['role'], db: doc['db'] }]
      : [];
  });
}

function privileges(value: unknown): Privilege[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Privilege[] => {
    const doc = docOf(item);
    const resource = docOf(doc?.['resource']);
    if (!doc || !resource) return [];
    const actions = Array.isArray(doc['actions']) ? doc['actions'].map(String) : [];
    if (resource['cluster'] === true) return [{ resource: { cluster: true }, actions }];
    if (resource['anyResource'] === true) return [{ resource: { anyResource: true }, actions }];
    return [
      {
        resource: {
          db: String(resource['db'] ?? ''),
          collection: String(resource['collection'] ?? ''),
        },
        actions,
      },
    ];
  });
}

function privilegeDocs(list: readonly Privilege[]): Document[] {
  return list.map((p) => ({ resource: { ...p.resource }, actions: [...p.actions] }));
}

function roleDocs(list: readonly RoleRef[]): Document[] {
  return list.map((r) => ({ role: r.role, db: r.db }));
}

export async function usersInfo(
  ctx: MongoContext,
  db: string,
  opts: { readonly user?: string; readonly showPrivileges?: boolean } = {},
): Promise<UserInfo[]> {
  const reply = await ctx.exclusive(() =>
    ctx.db(db).command({
      usersInfo: opts.user !== undefined ? { user: opts.user, db } : 1,
      showPrivileges: opts.showPrivileges ?? false,
      showCredentials: false,
    }),
  );
  const users = Array.isArray(reply['users']) ? (reply['users'] as Document[]) : [];
  return users.map((u) => ({
    user: String(u['user']),
    db: String(u['db']),
    roles: roleRefs(u['roles']),
    ...(u['inheritedRoles'] !== undefined ? { inheritedRoles: roleRefs(u['inheritedRoles']) } : {}),
    ...(u['inheritedPrivileges'] !== undefined
      ? { inheritedPrivileges: privileges(u['inheritedPrivileges']) }
      : {}),
    ...(Array.isArray(u['mechanisms']) ? { mechanisms: u['mechanisms'].map(String) } : {}),
    ...(u['customData'] !== undefined ? { customData: ejson(u['customData']) } : {}),
  }));
}

export async function rolesInfo(
  ctx: MongoContext,
  db: string,
  opts: {
    readonly role?: string;
    readonly showPrivileges?: boolean;
    readonly showBuiltinRoles?: boolean;
  } = {},
): Promise<RoleInfo[]> {
  const reply = await ctx.exclusive(() =>
    ctx.db(db).command({
      rolesInfo: opts.role !== undefined ? { role: opts.role, db } : 1,
      showPrivileges: opts.showPrivileges ?? false,
      showBuiltinRoles: opts.showBuiltinRoles ?? false,
    }),
  );
  const roles = Array.isArray(reply['roles']) ? (reply['roles'] as Document[]) : [];
  return roles.map((r) => ({
    role: String(r['role']),
    db: String(r['db']),
    isBuiltin: r['isBuiltin'] === true,
    roles: roleRefs(r['roles']),
    ...(r['inheritedRoles'] !== undefined ? { inheritedRoles: roleRefs(r['inheritedRoles']) } : {}),
    ...(r['privileges'] !== undefined ? { privileges: privileges(r['privileges']) } : {}),
    ...(r['inheritedPrivileges'] !== undefined
      ? { inheritedPrivileges: privileges(r['inheritedPrivileges']) }
      : {}),
  }));
}

export async function createUser(
  ctx: MongoContext,
  db: string,
  spec: CreateUserSpec,
): Promise<void> {
  const command: Document = { createUser: spec.user, roles: roleDocs(spec.roles) };
  if (spec.password !== undefined) command['pwd'] = spec.password;
  if (spec.customData !== undefined)
    command['customData'] = documentArg(spec.customData, 'custom data');
  if (spec.mechanisms !== undefined) command['mechanisms'] = [...spec.mechanisms];
  await ctx.exclusive(() => ctx.db(db).command(command));
}

export async function updateUser(
  ctx: MongoContext,
  db: string,
  user: string,
  spec: UpdateUserSpec,
): Promise<void> {
  const command: Document = { updateUser: user };
  if (spec.password !== undefined) command['pwd'] = spec.password;
  if (spec.roles !== undefined) command['roles'] = roleDocs(spec.roles);
  if (spec.customData !== undefined)
    command['customData'] = documentArg(spec.customData, 'custom data');
  if (spec.mechanisms !== undefined) command['mechanisms'] = [...spec.mechanisms];
  if (Object.keys(command).length === 1) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Nothing to change' });
  }
  await ctx.exclusive(() => ctx.db(db).command(command));
}

export async function dropUser(ctx: MongoContext, db: string, user: string): Promise<void> {
  await ctx.exclusive(() => ctx.db(db).command({ dropUser: user }));
}

export async function createRole(ctx: MongoContext, db: string, spec: RoleSpec): Promise<void> {
  await ctx.exclusive(() =>
    ctx.db(db).command({
      createRole: spec.role,
      privileges: privilegeDocs(spec.privileges),
      roles: roleDocs(spec.roles),
    }),
  );
}

export async function updateRole(
  ctx: MongoContext,
  db: string,
  role: string,
  spec: Partial<Pick<RoleSpec, 'privileges' | 'roles'>>,
): Promise<void> {
  const command: Document = { updateRole: role };
  if (spec.privileges !== undefined) command['privileges'] = privilegeDocs(spec.privileges);
  if (spec.roles !== undefined) command['roles'] = roleDocs(spec.roles);
  if (Object.keys(command).length === 1) {
    throw new JoineryError({ code: 'VALIDATION_FAILED', message: 'Nothing to change' });
  }
  await ctx.exclusive(() => ctx.db(db).command(command));
}

export async function dropRole(ctx: MongoContext, db: string, role: string): Promise<void> {
  await ctx.exclusive(() => ctx.db(db).command({ dropRole: role }));
}

export async function grantRoles(
  ctx: MongoContext,
  db: string,
  user: string,
  roles: readonly RoleRef[],
): Promise<void> {
  await ctx.exclusive(() => ctx.db(db).command({ grantRolesToUser: user, roles: roleDocs(roles) }));
}

export async function revokeRoles(
  ctx: MongoContext,
  db: string,
  user: string,
  roles: readonly RoleRef[],
): Promise<void> {
  await ctx.exclusive(() =>
    ctx.db(db).command({ revokeRolesFromUser: user, roles: roleDocs(roles) }),
  );
}

// ---------------------------------------------------------------------------- admin reads

export async function currentOp(ctx: MongoContext, opts: CurrentOpOptions = {}): Promise<string[]> {
  const pipeline: Document[] = [
    {
      $currentOp: {
        allUsers: opts.allUsers ?? true,
        idleConnections: opts.idleConnections ?? false,
      },
    },
  ];
  if (opts.filter !== undefined) pipeline.push({ $match: documentArg(opts.filter, 'filter') });
  pipeline.push({ $limit: Math.max(1, Math.floor(opts.limit ?? 1000)) });
  const ops = await ctx.exclusive(() =>
    ctx.rawDb('admin').aggregate(pipeline, { maxTimeMS: 10_000 }).toArray(),
  );
  return ops.map((op) => ejson(op));
}

export async function killOp(ctx: MongoContext, opid: number | string): Promise<void> {
  await ctx.exclusive(() => ctx.db('admin').command({ killOp: 1, op: opid }));
}

export async function serverStatus(ctx: MongoContext): Promise<ServerStatusSummary> {
  const status = await ctx.exclusive(() => ctx.db('admin').command({ serverStatus: 1 }));
  const connections = docOf(status['connections']);
  const opcounters = docOf(status['opcounters']);
  const mem = docOf(status['mem']);
  const network = docOf(status['network']);
  const counters: Record<string, number> = {};
  for (const [key, value] of Object.entries(opcounters ?? {})) {
    const n = numberOf(value);
    if (n !== undefined) counters[key] = n;
  }
  return {
    host: String(status['host'] ?? ''),
    version: String(status['version'] ?? ''),
    uptimeSeconds: numberOf(status['uptime']) ?? 0,
    ...(connections
      ? {
          connections: {
            current: numberOf(connections['current']) ?? 0,
            available: numberOf(connections['available']) ?? 0,
          },
        }
      : {}),
    ...(opcounters ? { opcounters: counters } : {}),
    ...(mem
      ? {
          memoryMb: {
            resident: numberOf(mem['resident']) ?? 0,
            virtual: numberOf(mem['virtual']) ?? 0,
          },
        }
      : {}),
    ...(network
      ? {
          network: {
            bytesIn: numberOf(network['bytesIn']) ?? 0,
            bytesOut: numberOf(network['bytesOut']) ?? 0,
            requests: numberOf(network['numRequests']) ?? 0,
          },
        }
      : {}),
    raw: toEjson(status),
  };
}

export async function top(ctx: MongoContext): Promise<TopEntry[]> {
  const reply = await ctx.exclusive(() => ctx.db('admin').command({ top: 1 }));
  const totals = docOf(reply['totals']) ?? {};
  const entries: TopEntry[] = [];
  for (const [ns, value] of Object.entries(totals)) {
    const doc = docOf(value);
    if (!doc) continue;
    const out: Record<string, { time: number; count: number }> = {};
    for (const [category, stats] of Object.entries(doc)) {
      const s = docOf(stats);
      if (!s) continue;
      out[category] = { time: numberOf(s['time']) ?? 0, count: numberOf(s['count']) ?? 0 };
    }
    entries.push({ ns, totals: out });
  }
  return entries.sort((a, b) => a.ns.localeCompare(b.ns));
}

// ---------------------------------------------------------------------------- server info

/** What `hello` says about the deployment. */
export function topologyOf(hello: Document): TopologyKind {
  if (hello['msg'] === 'isdbgrid') return 'sharded';
  if (typeof hello['setName'] === 'string') return 'replicaSet';
  if (hello['serviceId'] !== undefined) return 'loadBalanced';
  return 'standalone';
}

export async function serverInfo(ctx: MongoContext): Promise<MongoServerInfo> {
  return ctx.exclusive(async () => {
    const admin = ctx.db('admin');
    const [hello, build] = await Promise.all([
      admin.command({ hello: 1 }),
      admin.command({ buildInfo: 1 }),
    ]);
    const topology = topologyOf(hello);
    const storage = await admin
      .command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 })
      .then((status) => stringOf(docOf(status['storageEngine'])?.['name']))
      .catch(() => undefined);
    let members: TopologyMember[] = [];
    if (topology === 'replicaSet') {
      members = await admin
        .command({ replSetGetStatus: 1 })
        .then((status) =>
          (Array.isArray(status['members']) ? (status['members'] as Document[]) : []).map((m) => ({
            host: String(m['name']),
            state: String(m['stateStr'] ?? ''),
            healthy: numberOf(m['health']) === 1,
            ...(m['self'] === true ? { self: true } : {}),
          })),
        )
        .catch(() => {
          const hosts = Array.isArray(hello['hosts']) ? hello['hosts'].map(String) : [];
          return hosts.map((host) => ({
            host,
            state: host === hello['primary'] ? 'PRIMARY' : 'SECONDARY',
            healthy: true,
            ...(host === hello['me'] ? { self: true } : {}),
          }));
        });
    } else if (topology === 'sharded') {
      members = await admin
        .command({ listShards: 1 })
        .then((reply) =>
          (Array.isArray(reply['shards']) ? (reply['shards'] as Document[]) : []).map((s) => ({
            host: String(s['host']),
            state: String(s['_id']),
            healthy: numberOf(s['state']) !== 0,
          })),
        )
        .catch(() => []);
    }
    const version = String(build['version'] ?? '');
    return {
      version,
      topology,
      ...(typeof hello['setName'] === 'string' ? { setName: hello['setName'] } : {}),
      members,
      ...(storage !== undefined ? { storageEngine: storage } : {}),
      modules: Array.isArray(build['modules']) ? build['modules'].map(String) : [],
      ...(numberOf(hello['maxWireVersion']) !== undefined
        ? { maxWireVersion: numberOf(hello['maxWireVersion'])! }
        : {}),
    };
  });
}
