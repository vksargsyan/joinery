import { JoineryError, type DriverAdapter, type EngineId } from '@joinery/core';

/**
 * The driver adapter for an engine, loaded on demand so a host only pulls in its own driver
 * (spec §2). An engine without a driver fails with NOT_SUPPORTED.
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
    case 'mongodb': {
      const [{ checkConnection, createMongoAdapter }, { withSshStepCheck }] = await Promise.all([
        import('@joinery/driver-mongodb'),
        import('@joinery/tunnel'),
      ]);
      return withSshStepCheck(createMongoAdapter(), (resolved, deps) =>
        checkConnection(resolved, deps),
      );
    }
    case 'redis': {
      const [{ createRedisAdapter }, { withSshStepCheck }] = await Promise.all([
        import('@joinery/driver-redis'),
        import('@joinery/tunnel'),
      ]);
      const adapter = createRedisAdapter();
      return withSshStepCheck(adapter, (resolved, deps) => adapter.checkConnection(resolved, deps));
    }
    case 'elasticsearch':
    case 'opensearch': {
      const [{ createSearchAdapter }, { withSshStepCheck }] = await Promise.all([
        import('@joinery/driver-elasticsearch'),
        import('@joinery/tunnel'),
      ]);
      const adapter = createSearchAdapter({ engine });
      return withSshStepCheck(adapter, (resolved, deps) => adapter.checkConnection(resolved, deps));
    }
    default: {
      // Every engine has a driver; a profile from a newer version may name one this lacks.
      const unknown: never = engine;
      throw new JoineryError({
        code: 'NOT_SUPPORTED',
        message: `The engine "${String(unknown)}" is not supported`,
      });
    }
  }
}
