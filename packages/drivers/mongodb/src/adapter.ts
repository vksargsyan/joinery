import type {
  Capabilities,
  ConnectionCheckResult,
  DriverAdapter,
  ResolvedProfile,
  Session,
} from '@querybara/core';

import { checkMongoConnection, type MongoCheckDeps } from './check';
import { MongoDbSession, mongoCapabilities } from './session';

/**
 * The MongoDB driver adapter (the official `mongodb` package). Sessions it opens are
 * MongoSessions: narrow them with `isMongoSession` to reach the document services.
 */
export class MongoAdapter implements DriverAdapter {
  readonly engine = 'mongodb' as const;

  /** Before connecting the topology is unknown, so transactions and change streams are assumed. */
  capabilities(serverVersion?: string): Capabilities {
    return mongoCapabilities(serverVersion, 'replicaSet');
  }

  connect(resolved: ResolvedProfile): Promise<Session> {
    return MongoDbSession.open(resolved);
  }

  checkConnection(resolved: ResolvedProfile): AsyncIterable<ConnectionCheckResult> {
    return checkMongoConnection(resolved, { connect: (profile) => MongoDbSession.open(profile) });
  }
}

/** The MongoDB adapter; one instance serves every profile. */
export const mongodbAdapter: DriverAdapter = new MongoAdapter();

/** Creates the MongoDB adapter (the same shape as the SQL drivers' factories). */
export function createMongoAdapter(): DriverAdapter {
  return new MongoAdapter();
}

/**
 * Test Connection with injectable network primitives, including `runSshStep` for profiles with
 * an SSH tunnel or proxy (pass @querybara/tunnel's `runSshStep` bound to a TransportManager).
 */
export function checkConnection(
  resolved: ResolvedProfile,
  deps: Partial<MongoCheckDeps> = {},
): AsyncIterable<ConnectionCheckResult> {
  return checkMongoConnection(resolved, {
    connect: (profile) => MongoDbSession.open(profile),
    ...deps,
  });
}
