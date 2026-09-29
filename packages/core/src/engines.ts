import { z } from 'zod';

/** Every engine Joinery 1.0 talks to (spec §2). */
export const ENGINE_IDS = [
  'mysql',
  'mariadb',
  'postgres',
  'mongodb',
  'redis',
  'elasticsearch',
  'opensearch',
] as const;

export const engineIdSchema = z.enum(ENGINE_IDS);
export type EngineId = z.infer<typeof engineIdSchema>;

/** Engines that speak SQL and share the SQL base adapter. */
export const SQL_ENGINE_IDS = ['mysql', 'mariadb', 'postgres'] as const;
export type SqlEngineId = (typeof SQL_ENGINE_IDS)[number];

/** SQL dialects the SQL tooling understands. MariaDB is its own dialect on the MySQL protocol. */
export type SqlDialect = SqlEngineId;

export type EngineFamily = 'sql' | 'document' | 'key-value' | 'search';

export interface EngineInfo {
  readonly id: EngineId;
  readonly displayName: string;
  readonly family: EngineFamily;
  readonly defaultPort: number;
}

export const ENGINES: Readonly<Record<EngineId, EngineInfo>> = {
  mysql: { id: 'mysql', displayName: 'MySQL', family: 'sql', defaultPort: 3306 },
  mariadb: { id: 'mariadb', displayName: 'MariaDB', family: 'sql', defaultPort: 3306 },
  postgres: { id: 'postgres', displayName: 'PostgreSQL', family: 'sql', defaultPort: 5432 },
  mongodb: { id: 'mongodb', displayName: 'MongoDB', family: 'document', defaultPort: 27017 },
  redis: { id: 'redis', displayName: 'Redis', family: 'key-value', defaultPort: 6379 },
  elasticsearch: {
    id: 'elasticsearch',
    displayName: 'Elasticsearch',
    family: 'search',
    defaultPort: 9200,
  },
  opensearch: { id: 'opensearch', displayName: 'OpenSearch', family: 'search', defaultPort: 9200 },
};

export function isSqlEngine(engine: EngineId): engine is SqlEngineId {
  return (SQL_ENGINE_IDS as readonly EngineId[]).includes(engine);
}
