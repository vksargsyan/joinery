import type { Redis } from 'ioredis';

import type { Arg, RedisConnection } from './client';
import type { RedisServerInfo } from './types';

/**
 * What the service modules (keys, values, tools, browse, execute) need from the session. The
 * session implements it; the modules stay free functions that are easy to read and test.
 */
export interface RedisContext {
  readonly conn: RedisConnection;
  readonly server: RedisServerInfo;
  readonly keyDelimiter: string;
  /** The session's current logical database. */
  readonly database: number;
  /**
   * Runs a command for a service: keyed commands are routed by slot in Cluster mode, keyless
   * ones go to `node` (default: the first primary). Errors are mapped to QuerybaraErrors.
   */
  call(args: readonly Arg[], node?: Redis): Promise<unknown>;
  /**
   * Standalone / Sentinel: runs commands in logical database `db`, wrapped in SELECTs written in
   * one go so no other command interleaves. Returns the replies; throws the first error.
   */
  inDatabase(db: number, commands: readonly (readonly Arg[])[]): Promise<unknown[]>;
  /** MULTI ... EXEC in one write (Cluster: the keys must share a slot). Throws the first error. */
  transaction(commands: readonly (readonly Arg[])[]): Promise<unknown[]>;
  /** The node for a `node` option ("host:port"); the default node when omitted. */
  nodeFor(address: string | undefined): Redis;
  /** Nodes a keyspace-wide operation covers: the given node, or every primary. */
  scanNodes(address: string | undefined): Redis[];
}

/** Throws AbortError-style cancellation when the signal fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error('Cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
