import { ENGINES, JoineryError, type DriverAdapter, type EngineId } from '@joinery/core';

/**
 * The driver adapter for an engine, loaded on demand so a host only pulls in its own driver
 * (spec §2). Engines without a driver yet fail with NOT_SUPPORTED.
 */
export async function loadAdapter(engine: EngineId): Promise<DriverAdapter> {
  switch (engine) {
    case 'postgres': {
      const { createPostgresAdapter } = await import('@joinery/driver-postgres');
      return createPostgresAdapter();
    }
    case 'mysql':
    case 'mariadb': {
      const { createMysqlAdapter } = await import('@joinery/driver-mysql');
      return createMysqlAdapter({ engine });
    }
    default:
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `${ENGINES[engine].displayName} is not supported yet`,
      });
  }
}
