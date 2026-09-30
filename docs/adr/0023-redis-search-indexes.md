# 0023. Redis search indexes: FT.* as engine services, read by redis-tools

- Status: Accepted
- Date: 2026-09-30

## Context

The Redis Query Engine (RediSearch) indexes hashes and JSON documents under key prefixes and
queries them by text, tags, numeric ranges, places and vectors. Redis 8 bundles it, as Redis
Stack did, and Valkey has valkey-search, which speaks a subset of the same FT.* commands. Before
this, Joinery reached it only through the CLI: FT.INFO printed as a flat list of more than 100
lines, and FT.CREATE had to be written by hand.

The replies are RESP2 arrays whose shapes vary:

- FT.INFO alternates keys and values, with nested groups.
- Each field in FT.INFO is its own array of `identifier`, `attribute` and `type`, followed by
  options with values (`WEIGHT 2`) and flags without one (`SORTABLE`, `UNF`).
- valkey-search nests a vector's settings and writes flags as `CASESENSITIVE 0`.
- FT.SEARCH's layout changes with WITHSCORES and NOCONTENT.

## Decision

_*FT.* commands are engine services of the Redis driver (ADR 0007), read and built by pure code
in `@joinery/redis-tools`, and shown in a Search indexes tool._*

- **`redis-tools/search.ts`** reads replies and builds commands:
  - `parseSearchInfo` reads FT.INFO into an index's definition, fields (options and flags kept
    apart), document and term counts, memory, indexing progress, failures, and every figure
    flattened (`gc_stats.bytes_collected`).
  - `parseSearchReply` reads FT.SEARCH. Keys and values stay bytes.
  - `searchCreateArgs` builds FT.CREATE from a definition, and `definitionOf` rebuilds a
    definition from FT.INFO. The Schema view shows the command that recreates an index,
    and Duplicate starts from it.
  - `suggestSearchFields` proposes fields from sample documents: hash fields, or JSON scalar
    paths and arrays as `path[*]`. Each gets a type from its values: numbers become NUMERIC,
    `lon,lat` GEO, comma lists or short repeated values TAG, anything else TEXT.
  - It is pure, so the page previews the exact FT.CREATE before sending it. It is tested against
    replies recorded from Redis 8.2 and valkey-search.
- **The driver** (`search.ts`):
  - FT._LIST, FT.INFO, FT.SEARCH (paging, sort, returned fields, scores, dialect, params),
    FT.EXPLAIN, FT.CREATE and FT.DROPINDEX (with DD on request), and suggestions from up to 50
    keys read with SCAN … TYPE.
  - Commands go to the target node, or the first primary. In a cluster each shard has its own
    index, so the tool picks the node.
  - Without the module, "unknown command" becomes NOT_SUPPORTED, with the servers that have it.
- **Write rules in the host**:
  - Creating an index is a write.
  - Dropping one is destructive, and its confirmation says whether the documents go with it.
  - In the CLI, FT.DROPINDEX, FT.DROP and FT.ALIASDEL are destructive; FT.CREATE, FT.ALTER,
    aliases, synonyms, dictionaries and suggestions are writes; the query commands are reads.
- **The Search indexes tool** sits in each Redis connection's Tools folder. It shows the indexes
  and one index at a time:
  - **Query:** the query text, sort by a sortable field, page size, dialect, scores, verbatim,
    keys only, FT.EXPLAIN, a clause to insert per field, and a syntax reference. The results
    table's key opens the value editor.
  - **Schema:** the fields, and the FT.CREATE that recreates the index, to copy.
  - **Details:** every figure FT.INFO reported.

  A new index is written as a form: name, hashes or JSON, prefixes, filter, and a row per field
  with the options its type has (weight and no-stemming for TEXT, separator and case for TAG;
  algorithm, dimension, distance and element type for VECTOR). "Suggest from keys" fills it in.
  An index that is still indexing existing keys shows its progress.

## Consequences

- Only CI's nightly Redis 8.0 has the module. Pull requests run Redis 7.4, where the driver and
  end-to-end tests check the NOT_SUPPORTED path; the full path was run against Redis 8.2
  locally.
- valkey-search is read, including its nested vector settings. Its queries are narrower (for
  example, `*` is refused), and the tool shows the server's message as it is.
- FT.AGGREGATE, aliases, synonyms, spelling and FT.ALTER stay in the CLI for now. The tool
  covers finding, reading and creating indexes, which is where the raw replies were hardest.
