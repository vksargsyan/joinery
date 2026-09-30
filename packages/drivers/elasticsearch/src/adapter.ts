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
 * The Elasticsearch driver adapter (ADR 0010). Every difference between versions and
 * distributions is a capability flag the session reads from the server. Sessions are
 * SearchSessions: narrow them with `isSearchSession`.
 */
export class SearchAdapter implements DriverAdapter {
  readonly engine = 'elasticsearch';

  capabilities(serverVersion?: string): Capabilities {
    return searchCoreCapabilities(serverVersion);
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

export function createSearchAdapter(): SearchAdapter {
  return new SearchAdapter();
}
