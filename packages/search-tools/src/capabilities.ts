/**
 * What an Elasticsearch or OpenSearch cluster supports (spec §2, §11). Elasticsearch and
 * OpenSearch share one adapter, and every difference between them, their versions and their
 * distributions (the Elasticsearch default and OSS flavours, OpenSearch's plugins) is one of
 * these flags, so the module shows only what the connected cluster can do.
 */

export const SEARCH_DISTRIBUTIONS = ['elasticsearch', 'opensearch'] as const;
export type SearchDistribution = (typeof SEARCH_DISTRIBUTIONS)[number];

export interface SearchCapabilities {
  /** ES|QL (`POST /_query`): Elasticsearch 8.11 and later, default distribution. */
  readonly esql: boolean;
  /** SQL through Elasticsearch's SQL API (`/_sql`) or OpenSearch's SQL plugin (`/_plugins/_sql`). */
  readonly sql: 'elasticsearch' | 'opensearch' | null;
  /** OpenSearch's Piped Processing Language (the SQL plugin's `/_plugins/_ppl`). */
  readonly ppl: boolean;
  /** Data streams: Elasticsearch 7.9+ (default distribution) and every OpenSearch. */
  readonly dataStreams: boolean;
  /** Index lifecycle: Elasticsearch ILM, or OpenSearch's Index State Management plugin. */
  readonly lifecycle: 'ilm' | 'ism' | null;
  /**
   * Point in time for consistent deep paging: Elasticsearch 7.10+ (`/_pit`, default
   * distribution) and OpenSearch 2.4+ (`/_search/point_in_time`).
   */
  readonly pointInTime: boolean;
  /** The `_shard_doc` sort, the cheapest tiebreaker for search_after under a point in time. */
  readonly shardDocSort: boolean;
  /** `search_after` paging (every supported version). */
  readonly searchAfter: boolean;
  /** Async search (`/_async_search`): Elasticsearch 7.7+, default distribution. */
  readonly asyncSearch: boolean;
  /** Composable index templates (`/_index_template`) and component templates. */
  readonly composableTemplates: boolean;
  /** Security APIs: Elasticsearch's `/_security`, or the OpenSearch security plugin's. */
  readonly security: 'elasticsearch' | 'opensearch' | null;
}

/** The facts the flags are derived from, as `GET /` and `_cat/plugins` report them. */
export interface SearchServerFacts {
  readonly distribution: SearchDistribution;
  /** "9.4.0", "7.17.28", "3.5.0". */
  readonly version: string;
  /** Elasticsearch's `build_flavor`: "default" or "oss" (the OSS flavour lacks X-Pack). */
  readonly buildFlavor?: string;
  /** Installed plugin components, e.g. "opensearch-sql", "opensearch-index-management". */
  readonly plugins?: readonly string[];
  /** Elasticsearch security is on (the cluster asked for credentials or accepted them). */
  readonly securityEnabled?: boolean;
}

function versionParts(version: string): [number, number, number] {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : [0, 0, 0];
}

/** True when `version` is at least `minimum` ("8.11" or "8.11.0"). */
export function versionAtLeast(version: string, minimum: string): boolean {
  const a = versionParts(version);
  const b = versionParts(minimum);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** The capability flags for a cluster (see SearchCapabilities). */
export function searchCapabilities(facts: SearchServerFacts): SearchCapabilities {
  const { version } = facts;
  const plugins = new Set(facts.plugins ?? []);
  if (facts.distribution === 'opensearch') {
    const sqlPlugin = plugins.has('opensearch-sql');
    return {
      esql: false,
      sql: sqlPlugin ? 'opensearch' : null,
      ppl: sqlPlugin,
      dataStreams: true,
      lifecycle: plugins.has('opensearch-index-management') ? 'ism' : null,
      pointInTime: versionAtLeast(version, '2.4'),
      shardDocSort: versionAtLeast(version, '2.4'),
      searchAfter: true,
      asyncSearch: plugins.has('opensearch-asynchronous-search'),
      composableTemplates: true,
      security: plugins.has('opensearch-security') ? 'opensearch' : null,
    };
  }
  // The OSS flavour (7.x) has none of X-Pack: no SQL, ILM, point in time or async search.
  const xpack = facts.buildFlavor !== 'oss';
  return {
    esql: xpack && versionAtLeast(version, '8.11'),
    sql: xpack && versionAtLeast(version, '6.3') ? 'elasticsearch' : null,
    ppl: false,
    dataStreams: xpack && versionAtLeast(version, '7.9'),
    lifecycle: xpack && versionAtLeast(version, '6.6') ? 'ilm' : null,
    pointInTime: xpack && versionAtLeast(version, '7.10'),
    shardDocSort: versionAtLeast(version, '7.12'),
    searchAfter: true,
    asyncSearch: xpack && versionAtLeast(version, '7.7'),
    composableTemplates: versionAtLeast(version, '7.8'),
    security: xpack && facts.securityEnabled !== false ? 'elasticsearch' : null,
  };
}

/** The display name of a distribution. */
export function distributionName(distribution: SearchDistribution): string {
  return distribution === 'opensearch' ? 'OpenSearch' : 'Elasticsearch';
}
