import { QuerybaraError, type DriverAdapter, type EngineId } from '@querybara/core';

/**
 * The driver adapter for an engine, loaded on demand so a host only pulls in its own driver
 * (spec §2). An engine without a driver fails with NOT_SUPPORTED.
 */
export async function loadAdapter(engine: EngineId): Promise<DriverAdapter> {
  switch (engine) {
    case 'postgres': {
      const { createPostgresAdapter } = await import('@querybara/driver-postgres');
      return createPostgresAdapter();
    }
    case 'mysql':
    case 'mariadb': {
      const { createMysqlAdapter } = await import('@querybara/driver-mysql');
      return createMysqlAdapter({ engine });
    }
    case 'mongodb': {
      const [{ checkConnection, createMongoAdapter }, { withSshStepCheck }] = await Promise.all([
        import('@querybara/driver-mongodb'),
        import('@querybara/tunnel'),
      ]);
      return withSshStepCheck(createMongoAdapter(), (resolved, deps) =>
        checkConnection(resolved, deps),
      );
    }
    case 'redis': {
      const [{ createRedisAdapter }, { withSshStepCheck }] = await Promise.all([
        import('@querybara/driver-redis'),
        import('@querybara/tunnel'),
      ]);
      const adapter = createRedisAdapter();
      return withSshStepCheck(adapter, (resolved, deps) => adapter.checkConnection(resolved, deps));
    }
    case 'elasticsearch': {
      const [{ createSearchAdapter }, { withSshStepCheck }] = await Promise.all([
        import('@querybara/driver-elasticsearch'),
        import('@querybara/tunnel'),
      ]);
      const adapter = createSearchAdapter();
      return withSshStepCheck(adapter, (resolved, deps) => adapter.checkConnection(resolved, deps));
    }
    default: {
      // Every engine has a driver; a profile from a newer version may name one this lacks.
      const unknown: never = engine;
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: `The engine "${String(unknown)}" is not supported`,
      });
    }
  }
}
