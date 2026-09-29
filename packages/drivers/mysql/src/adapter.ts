import {
  capabilitiesFor,
  JoineryError,
  type Capabilities,
  type ConnectionCheckResult,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';
import { checkConnection as checkSqlConnection } from '@joinery/driver-sql-base';

import { MysqlSession } from './session';

export interface MysqlAdapterOptions {
  /** Which engine the adapter serves. The session detects the real flavour from the server. */
  readonly engine: 'mysql' | 'mariadb';
}

/** The MySQL and MariaDB driver adapter (mysql2, with the MariaDB dialect handled here). */
export class MysqlAdapter implements DriverAdapter {
  readonly engine: 'mysql' | 'mariadb';

  constructor(options: MysqlAdapterOptions) {
    this.engine = options.engine;
  }

  capabilities(serverVersion?: string): Capabilities {
    return capabilitiesFor(this.engine, serverVersion);
  }

  connect(resolved: ResolvedProfile): Promise<Session> {
    const engine = resolved.profile.engine;
    if (engine !== 'mysql' && engine !== 'mariadb') {
      return Promise.reject(
        new JoineryError({
          code: 'VALIDATION_FAILED',
          message: `The MySQL adapter cannot open a ${engine} profile`,
        }),
      );
    }
    return MysqlSession.open(resolved, this.engine);
  }

  checkConnection(resolved: ResolvedProfile): AsyncIterable<ConnectionCheckResult> {
    return checkSqlConnection(resolved, this);
  }
}

/** Creates the adapter for MySQL or MariaDB. */
export function createMysqlAdapter(
  options: MysqlAdapterOptions = { engine: 'mysql' },
): DriverAdapter {
  return new MysqlAdapter(options);
}

/** Test Connection for a MySQL or MariaDB profile (spec §4), step by step. */
export function checkConnection(resolved: ResolvedProfile): AsyncIterable<ConnectionCheckResult> {
  const engine = resolved.profile.engine === 'mariadb' ? 'mariadb' : 'mysql';
  return checkSqlConnection(resolved, new MysqlAdapter({ engine }));
}
