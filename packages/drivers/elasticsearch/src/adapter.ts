import type {
  Capabilities,
  ConnectionCheckResult,
  DriverAdapter,
  ResolvedProfile,
  Session,
} from '@joinery/core';

import { checkSearchConnection, type SearchCheckDeps } from './check';
import { ElasticSearchSession, searchCoreCapabilities } from './session';

/**
 * The Elasticsearch and OpenSearch driver adapter (ADR 0010). One adapter serves both engines:
 * they speak the same HTTP API, and every difference is a capability flag the session reads
 * from the server. Sessions are SearchSessions: narrow them with `isSearchSession`.
 */
export class SearchAdapter implements DriverAdapter {
  constructor(readonly engine: 'elasticsearch' | 'opensearch') {}

  capabilities(serverVersion?: string): Capabilities {
    return searchCoreCapabilities(this.engine, serverVersion);
  }

  connect(resolved: ResolvedProfile): Promise<Session> {
    return ElasticSearchSession.open(resolved);
  }

  /**
   * Test Connection, with injectable network primitives and `runSshStep` for profiles with an
   * SSH tunnel or proxy (@joinery/tunnel's `runSshStep` bound to a TransportManager).
   */
  checkConnection(
    resolved: ResolvedProfile,
    deps: Partial<SearchCheckDeps> = {},
  ): AsyncIterable<ConnectionCheckResult> {
    return checkSearchConnection(resolved, deps);
  }
}

/** Creates the adapter for Elasticsearch (the default) or OpenSearch. */
export function createSearchAdapter(
  options: { readonly engine?: 'elasticsearch' | 'opensearch' } = {},
): SearchAdapter {
  return new SearchAdapter(options.engine ?? 'elasticsearch');
}
