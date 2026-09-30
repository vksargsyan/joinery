import type {
  IndexColumn,
  IndexDef,
  IntrospectScope,
  SchemaSnapshot,
  TableDef,
  ViewDef,
} from '@joinery/core';
import { toEjson } from '@joinery/mongo-tools';
import type { Document } from 'mongodb';

import { indexKind, numberOf } from './admin';
import type { MongoContext } from './context';

/**
 * A SchemaSnapshot of one MongoDB database (spec §13: compare and sync indexes, validators and
 * collection options). Following the producer conventions in core/schema.ts as far as they fit:
 *
 * - The snapshot holds one schema named after the database.
 * - Collections and time series collections are `tables` (by name) with no columns (documents
 *   have no fixed columns). The `_id` index is the `primaryKey` ({ name: "_id_", columns:
 *   ["_id"] }) and is not repeated in `indexes`.
 * - Each other index is an IndexDef: its key pattern in order as `columns` (`order` desc for
 *   -1; special keys such as "text", "2dsphere" or "hashed" set `method`), `unique`, `where`
 *   (the partialFilterExpression as canonical Extended JSON), `invisible` (hidden) and
 *   `definition` (the whole index spec minus the version, as canonical Extended JSON, so TTL,
 *   sparse, collation, weights and wildcard projections compare too).
 * - Table `options` hold the collection options as strings: validator (canonical Extended
 *   JSON), validationLevel, validationAction, capped, size, max, collation, timeseries,
 *   expireAfterSeconds, clusteredIndex and changeStreamPreAndPostImages; "type" is "timeseries"
 *   for time series collections.
 * - Views are `views` whose `definition` is the pipeline (canonical Extended JSON) and whose
 *   options hold viewOn (and collation).
 *
 * Left out: system.* collections, users and roles, GridFS as buckets (their .files and .chunks
 * are ordinary collections here), Atlas Search indexes, sharding and the data itself.
 */

const OPTION_KEYS = [
  'validator',
  'validationLevel',
  'validationAction',
  'capped',
  'size',
  'max',
  'collation',
  'timeseries',
  'expireAfterSeconds',
  'clusteredIndex',
  'changeStreamPreAndPostImages',
] as const;

function optionText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  const n = numberOf(value);
  if (n !== undefined) return String(n);
  return toEjson(value);
}

/** An index spec → IndexDef (see the module comment). */
export function indexDef(spec: Document): IndexDef {
  const keys = (spec['key'] ?? {}) as Document;
  const kind = indexKind(keys, spec);
  const columns: IndexColumn[] = Object.entries(keys).map(([name, direction]) => {
    const n = numberOf(direction);
    return {
      name,
      order: n !== undefined && n < 0 ? 'desc' : 'asc',
      ...(typeof direction === 'string' ? { expression: direction } : {}),
    };
  });
  const { v: _v, ns: _ns, ...definition } = spec;
  return {
    name: String(spec['name']),
    columns,
    unique: spec['unique'] === true,
    ...(kind !== 'single' && kind !== 'compound' ? { method: kind } : {}),
    ...(spec['partialFilterExpression'] !== undefined
      ? { where: toEjson(spec['partialFilterExpression']) }
      : {}),
    include: [],
    invisible: spec['hidden'] === true,
    definition: toEjson(definition),
  };
}

export async function introspectMongo(
  ctx: MongoContext,
  database: string,
  scope: IntrospectScope,
  serverVersion: string,
): Promise<SchemaSnapshot> {
  const include = scope.include ? new Set(scope.include) : undefined;
  const wantTables = !include || include.has('table');
  const wantViews = !include || include.has('view');
  const db = ctx.rawDb(database);
  const collections = (await db.listCollections({}, { nameOnly: false }).toArray())
    .filter((c) => !String(c['name']).startsWith('system.'))
    .sort((a, b) => String(a['name']).localeCompare(String(b['name'])));

  const tables: TableDef[] = [];
  const views: ViewDef[] = [];
  for (const entry of collections) {
    const name = String(entry['name']);
    const options = (entry['options'] ?? {}) as Document;
    if (entry['type'] === 'view') {
      if (!wantViews) continue;
      views.push({
        name,
        materialized: false,
        definition: toEjson(options['pipeline'] ?? []),
        columns: [],
        options: {
          viewOn: String(options['viewOn'] ?? ''),
          ...(options['collation'] !== undefined
            ? { collation: toEjson(options['collation']) }
            : {}),
        },
        indexes: [],
      });
      continue;
    }
    if (!wantTables) continue;
    const specs = await db
      .collection(name)
      .listIndexes()
      .toArray()
      .catch(() => [] as Document[]);
    const tableOptions: Record<string, string> = {};
    if (entry['type'] === 'timeseries') tableOptions['type'] = 'timeseries';
    for (const key of OPTION_KEYS) {
      if (options[key] !== undefined) tableOptions[key] = optionText(options[key]);
    }
    const hasIdIndex = specs.some((s) => s['name'] === '_id_');
    tables.push({
      name,
      kind: 'table',
      columns: [],
      ...(hasIdIndex || options['clusteredIndex'] !== undefined
        ? { primaryKey: { name: '_id_', columns: ['_id'] } }
        : {}),
      uniques: [],
      indexes: specs
        .filter((s) => s['name'] !== '_id_')
        .map(indexDef)
        .sort((a, b) => a.name.localeCompare(b.name)),
      foreignKeys: [],
      checks: [],
      triggers: [],
      options: tableOptions,
    });
  }
  return {
    engine: 'mongodb',
    serverVersion,
    database,
    options: {},
    schemas: [
      {
        name: database,
        tables,
        views,
        routines: [],
        sequences: [],
        types: [],
        events: [],
      },
    ],
    extensions: [],
    capturedAt: new Date().toISOString(),
  };
}
