/**
 * What an Elasticsearch cluster supports (spec §2, §11). Every difference between versions and
 * distributions (the default and OSS flavours) is one of these flags, so the module shows only
 * what the connected cluster can do.
 */

export interface SearchCapabilities {
  /** ES|QL (`POST /_query`): Elasticsearch 8.11 and later, default distribution. */
  readonly esql: boolean;
  /** The SQL API (`/_sql`): 6.3 and later, default distribution. */
  readonly sql: boolean;
  /** Data streams: 7.9 and later, default distribution. */
  readonly dataStreams: boolean;
  /** Index lifecycle management (ILM): 6.6 and later, default distribution. */
  readonly lifecycle: boolean;
  /** Point in time (`/_pit`) for consistent deep paging: 7.10 and later, default distribution. */
  readonly pointInTime: boolean;
  /** The `_shard_doc` sort, the cheapest tiebreaker for search_after under a point in time. */
  readonly shardDocSort: boolean;
  /** `search_after` paging (every supported version). */
  readonly searchAfter: boolean;
  /** Async search (`/_async_search`): 7.7 and later, default distribution. */
  readonly asyncSearch: boolean;
  /** Composable index templates (`/_index_template`) and component templates. */
  readonly composableTemplates: boolean;
  /** Cloning an index (`POST /<index>/_clone/<target>`): 7.4 and later. */
  readonly cloneIndex: boolean;
  /** The security APIs (`/_security`) are on. */
  readonly security: boolean;
}

/** The facts the flags are derived from, as `GET /` reports them. */
export interface SearchServerFacts {
  /** "9.4.0", "7.17.28". */
  readonly version: string;
  /** Elasticsearch's `build_flavor`: "default" or "oss" (the OSS flavour lacks X-Pack). */
  readonly buildFlavor?: string;
  /** Security is on (the cluster asked for credentials or accepted them). */
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
  // The OSS flavour (7.x) has none of X-Pack: no SQL, ILM, point in time or async search.
  const xpack = facts.buildFlavor !== 'oss';
  return {
    esql: xpack && versionAtLeast(version, '8.11'),
    sql: xpack && versionAtLeast(version, '6.3'),
    dataStreams: xpack && versionAtLeast(version, '7.9'),
    lifecycle: xpack && versionAtLeast(version, '6.6'),
    pointInTime: xpack && versionAtLeast(version, '7.10'),
    shardDocSort: versionAtLeast(version, '7.12'),
    searchAfter: true,
    asyncSearch: xpack && versionAtLeast(version, '7.7'),
    composableTemplates: versionAtLeast(version, '7.8'),
    cloneIndex: versionAtLeast(version, '7.4'),
    security: xpack && facts.securityEnabled !== false,
  };
}
