import type { EngineId } from './engines';
import { atLeast } from './version';

export const EXPLAIN_FORMATS = ['text', 'json', 'tree', 'analyze'] as const;
export type ExplainFormat = (typeof EXPLAIN_FORMATS)[number];

/**
 * What an adapter and the connected server support (spec §2). The UI shows only what is
 * supported, so every optional feature is gated on one of these flags.
 */
export interface Capabilities {
  /** DDL can run inside a transaction and roll back (PostgreSQL). */
  readonly transactionalDdl: boolean;
  /** A namespace level below the database (PostgreSQL schemas). */
  readonly schemas: boolean;
  readonly serverSideCursors: boolean;
  readonly explainFormats: readonly ExplainFormat[];
  /** A running statement can be cancelled from a separate control connection. */
  readonly queryCancel: boolean;
  readonly transactions: boolean;
  readonly storedRoutines: boolean;
  readonly events: boolean;
  readonly sequences: boolean;
  readonly materializedViews: boolean;
  readonly partitions: boolean;
  readonly changeStreams: boolean;
  readonly clusterMode: boolean;
  /** INSERT/UPDATE/DELETE ... RETURNING. */
  readonly returning: boolean;
}

const NONE: Capabilities = {
  transactionalDdl: false,
  schemas: false,
  serverSideCursors: false,
  explainFormats: [],
  queryCancel: false,
  transactions: false,
  storedRoutines: false,
  events: false,
  sequences: false,
  materializedViews: false,
  partitions: false,
  changeStreams: false,
  clusterMode: false,
  returning: false,
};

/** Capabilities of each engine's current supported versions, before version adjustments. */
export const BASE_CAPABILITIES: Readonly<Record<EngineId, Capabilities>> = {
  mysql: {
    ...NONE,
    serverSideCursors: true,
    explainFormats: ['text', 'json', 'tree', 'analyze'],
    queryCancel: true,
    transactions: true,
    storedRoutines: true,
    events: true,
    partitions: true,
  },
  mariadb: {
    ...NONE,
    serverSideCursors: true,
    explainFormats: ['text', 'json', 'analyze'],
    queryCancel: true,
    transactions: true,
    storedRoutines: true,
    events: true,
    sequences: true,
    partitions: true,
    returning: true,
  },
  postgres: {
    ...NONE,
    transactionalDdl: true,
    schemas: true,
    serverSideCursors: true,
    explainFormats: ['text', 'json', 'analyze'],
    queryCancel: true,
    transactions: true,
    storedRoutines: true,
    sequences: true,
    materializedViews: true,
    partitions: true,
    returning: true,
  },
  mongodb: {
    ...NONE,
    serverSideCursors: true,
    // queryPlanner and executionStats verbosity.
    explainFormats: ['json', 'analyze'],
    queryCancel: true,
    transactions: true,
    changeStreams: true,
  },
  redis: { ...NONE, clusterMode: true },
  elasticsearch: { ...NONE, queryCancel: true, clusterMode: true },
  opensearch: { ...NONE, queryCancel: true, clusterMode: true },
};

/**
 * Capabilities for an engine at a given server version. Unknown versions get the base set.
 * Runtime facts (a MongoDB standalone has no change streams, a Redis node may not be in
 * cluster mode) are for the adapter to apply after connecting.
 */
export function capabilitiesFor(engine: EngineId, serverVersion?: string): Capabilities {
  const base = BASE_CAPABILITIES[engine];
  if (serverVersion === undefined) return base;
  switch (engine) {
    case 'mysql':
      return {
        ...base,
        explainFormats: base.explainFormats.filter(
          (f) =>
            (f !== 'analyze' || atLeast(serverVersion, '8.0.18')) &&
            (f !== 'tree' || atLeast(serverVersion, '8.0.16')),
        ),
      };
    case 'mariadb':
      return {
        ...base,
        sequences: atLeast(serverVersion, '10.3.0'),
        returning: atLeast(serverVersion, '10.5.0'),
      };
    default:
      return base;
  }
}
