import {
  capabilitiesFor,
  QuerybaraError,
  type Capabilities,
  type ConnectionCheckResult,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@querybara/core';
import { checkConnection as checkSqlConnection } from '@querybara/driver-sql-base';

import { PostgresSession } from './session';

/** The PostgreSQL driver adapter (pg + pg-cursor). */
export class PostgresAdapter implements DriverAdapter {
  readonly engine = 'postgres' as const;

  capabilities(serverVersion?: string): Capabilities {
    return capabilitiesFor('postgres', serverVersion);
  }

  connect(resolved: ResolvedProfile): Promise<Session> {
    if (resolved.profile.engine !== 'postgres') {
      return Promise.reject(
        new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `The PostgreSQL adapter cannot open a ${resolved.profile.engine} profile`,
        }),
      );
    }
    return PostgresSession.open(resolved);
  }

  checkConnection(resolved: ResolvedProfile): AsyncIterable<ConnectionCheckResult> {
    return checkSqlConnection(resolved, this);
  }
}

/** Creates the PostgreSQL adapter. */
export function createPostgresAdapter(): DriverAdapter {
  return new PostgresAdapter();
}

/** Test Connection for a PostgreSQL profile (spec §4), step by step. */
export function checkConnection(resolved: ResolvedProfile): AsyncIterable<ConnectionCheckResult> {
  return checkSqlConnection(resolved, new PostgresAdapter());
}
