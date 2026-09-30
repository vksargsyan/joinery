# 0010. Elasticsearch: one driver on our own HTTP client

- Status: Accepted
- Date: 2026-09-29

## Context

Spec §11 adds Elasticsearch. Its versions and distributions differ in details that matter to a
client: the OSS flavour of 7.x has none of X-Pack (no SQL, ILM, point in time or async search),
composable templates arrived in 7.8, data streams in 7.9 and ES|QL in 8.11. Users run clusters
from 7.17 to 9.x, behind TLS, API keys, bearer tokens, reverse proxies with a path prefix,
Elastic Cloud IDs and SSH bastions.

The official clients do not fit. `@elastic/elasticsearch` 9 refuses any server that is not
Elasticsearch 9 by default (product check, `compatible-with=9` media types that 7.x and 8.x
reject); `@elastic/transport` brings undici, an HTTP proxy agent and OpenTelemetry. None of them keeps
64-bit numbers or `1.10` exactly: they parse bodies with `JSON.parse`, and documents in a
database tool must round-trip byte for byte.

The renderer is sandboxed and bundles only browser-safe code (ADR 0004); the Kibana-style console
needs a parser, a formatter and autocomplete there.

## Decision

**One adapter, capability flags from the server.** `@joinery/driver-elasticsearch` serves the
`elasticsearch` engine. At connect it reads `GET /` (version and build flavour) and derives
`SearchCapabilities`: ES|QL, the SQL API, data streams, ILM, point in time with `search_after`,
and so on, so every version and distribution difference is a flag. Services grow as methods on `SearchSession` (grouped: cluster, indices, aliases, data streams,
documents, raw request) so later panels add methods without reshaping these.

**Our own HTTP client on `node:http` / `node:https`, no runtime dependency.** It sends plain
`application/json` (and `application/x-ndjson` for bulk), keeps connections alive, applies the
profile's connect and query timeouts, and aborts on an `AbortSignal`. Each call carries an
`X-Opaque-Id` (`joinery-<execution id>`), so `cancel` also cancels the server tasks it started.
Sniffing is an option and off by default: the addresses nodes publish are often unreachable from
a desktop.

**Bodies stay text.** Requests and responses cross every boundary as JSON text. A token-tree
parser with source offsets (`@joinery/search-tools`) reads what the client needs and slices
documents out of replies as the server wrote them, so a `_source` with `1234567890123456789` or
`1.10` comes back unchanged in the console, the explorer and joinery-cli.

**Connection settings.** A list of node URLs or an Elastic Cloud ID; basic auth, API key or bearer
token, read only from the resolved secrets and never echoed (errors are redacted before they
leave the driver). The URL scheme decides TLS: `https://` uses the profile's TLS mode, `http://`
has none, and the connection dialog keeps the two consistent, as `rediss://` does for Redis. An
SSH tunnel or proxy reaches one URL (or the Cloud ID's endpoint) through `@joinery/tunnel`; the
request keeps the node's own name for the Host header and TLS verification. Errors map to
Joinery codes with hints: authentication, missing privileges, index not found, version
conflicts (`CONFLICT` for `if_seq_no` / `if_primary_term` writes), circuit breakers and
read-only index blocks.

**A pure tools package.** `@joinery/search-tools` holds the Kibana console parser and formatter,
lossless JSON helpers, the request classifier behind the write rules, the wire types, the
capability flags and autocomplete. Autocomplete data is generated from the open Elasticsearch
API specification (github.com/elastic/elasticsearch-specification, Apache 2.0) by
`scripts/generate-api-spec.mjs`, which records the branch and date.

**Write rules in the connection host.** Every request is classified (`classifyRequest`):
GET and HEAD read, known read endpoints read whatever their method (`POST _search`), anything
else writes. Read-only profiles refuse writes; deleting indices or documents, closing indices,
delete by query, force merge and bulk requests with deletes are destructive and always ask;
production and confirm-writes profiles ask for every write. The console asks before sending;
the host checks again and refuses without the page's confirmation. joinery-cli applies the same
rules with `--yes`.

## Consequences

- No product check or telemetry code in the app, and one code path from 7.17 to 9.x; the price
  is owning an HTTP client (about 400 lines) and its tests.
- The capability flags are the only place version differences live; the nightly matrix covers
  7.17, 8.19 and 9.x to keep them honest.
- Autocomplete follows the Elasticsearch specification's branch; regenerating it is one command.
