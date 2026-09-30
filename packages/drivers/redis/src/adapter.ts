import {
  capabilitiesFor,
  type Capabilities,
  type ConnectionCheckResult,
  type DriverAdapter,
  type ResolvedProfile,
  type Session,
} from '@joinery/core';

import { checkRedisConnection, type RedisCheckDeps } from './check';
import { RedisSessionImpl } from './session';
import type { RedisSession } from './types';

/** The Redis / Valkey driver adapter (ioredis): standalone, Sentinel and Cluster. */
export class RedisAdapter implements DriverAdapter {
  readonly engine = 'redis' as const;

  /** Cluster mode is a runtime fact: sessions report it; queries can always be cancelled. */
  capabilities(serverVersion?: string): Capabilities {
    return { ...capabilitiesFor('redis', serverVersion), queryCancel: true };
  }

  connect(resolved: ResolvedProfile): Promise<RedisSession> {
    return RedisSessionImpl.open(resolved);
  }

  checkConnection(
    resolved: ResolvedProfile,
    deps: Partial<RedisCheckDeps> = {},
  ): AsyncIterable<ConnectionCheckResult> {
    return checkRedisConnection(resolved, this, deps);
  }
}

/** The shared adapter instance. */
export const redisAdapter = new RedisAdapter();

export function createRedisAdapter(): RedisAdapter {
  return new RedisAdapter();
}

/** Narrows a generic session to the Redis session with its key services and tools. */
export function isRedisSession(session: Session): session is RedisSession {
  return (
    session.engine === 'redis' && typeof (session as Partial<RedisSession>).scan === 'function'
  );
}
