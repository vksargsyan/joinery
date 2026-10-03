# 0007. MongoDB and Redis: engine services beside the Session contract

- Status: Accepted; "Tunnels reach one host" superseded by [ADR 0008](0008-multi-node-tunnels.md)
- Date: 2026-09-29

## Context

The Session contract in `@querybara/core` (spec §3) was shaped by the SQL engines: one statement
in, column-oriented result chunks out. MongoDB and Redis need that for their consoles, but most
of their modules are not statements at all (spec §9, §10): a find with a projection, an
optimistic document replace, an aggregation stage preview, a SCAN page across cluster nodes, a
hash field edit, a Pub/Sub subscription. Their values do not fit the SQL cell model either: BSON
has types JSON cannot tell apart (Int32, Int64, Double, Decimal128, dates, binary subtypes), and
Redis keys and values are arbitrary bytes.

The renderer is sandboxed and can bundle only browser-safe code (ADR 0004), so it cannot import
the official `mongodb` driver or `ioredis`.

## Decision

**Each engine's session extends Session with its own services.** `MongoSession` and
`RedisSession` (exported by `@querybara/driver-mongodb` and `@querybara/driver-redis`, recognised
with `isMongoSession` / `isRedisSession`) keep `execute` for the consoles and querybara-cli and add
typed methods for everything else. Core stays engine-neutral; nothing SQL-specific grew into it.

**A pure tools package per engine.** `@querybara/mongo-tools` and `@querybara/redis-tools`, like
`@querybara/sql-tools`, hold what both sides need and the renderer can bundle: the mongosh-literal
parser and formatter, find() text, schema analysis and the wire types; the redis-cli tokenizer,
reply formats, command docs and autocomplete, parsers and value codecs. The drivers import them;
the renderer imports only them.

**Values cross processes in lossless, structured-clone-safe forms.** MongoDB documents, filters
and pipelines travel as canonical Extended JSON v2 strings, parsed and formatted only at the
edges. Redis keys and values travel as `Uint8Array`, shown and accepted through `displayBytes` /
`parseDisplayBytes`, so any key round-trips.

**One connection-host namespace per engine.** The `mongo.*` and `redis.*` contracts sit on the
connection-host contract beside the SQL methods, their zod schemas typed from the tools
packages' and drivers' exported types so a drift fails to compile. A host loads a driver only
for its own engine.

**Write rules are enforced in the connection host** (`shared/mongo-writes.ts`,
`shared/redis-safety.ts`), with the page sending an explicit confirmation: read-only profiles
refuse every write; destructive operations (drops, bulk updates and deletes, `$out`/`$merge`,
index drops, KILL-type commands, ACL changes) always need confirmation; production and
confirm-writes profiles need it for every write. The page shows the exact command first.

**GridFS files move by path, not through the page.** Uploads and downloads go from main's file
grants (ADR 0006) to the connection host over new parent-port messages (`request`, `response`,
`request-progress`, `cancel-request`), so file bytes never pass through main's IPC to the
renderer; only small previews do.

**Tunnels reach one host.** A single host, or a single-host URI, can go through SSH or a proxy
(MongoDB then connects with `directConnection`); host lists, SRV, Sentinel and Cluster are
refused with an explanation. Test Connection through a transport runs the adapter's own stepwise
check with the SSH step supplied by the tunnel manager (`withSshStepCheck`).

**The MongoDB console runs command documents.** The embedded mongosh shell the spec asks for
(the Apache-2.0 `@mongosh/*` packages) works against our own client in a spike, but brings about
129 MB of dependencies that must stay outside the Vite bundle; it waits for a packaging decision.

## Consequences

- Each engine's module grows without touching the SQL path, and querybara-cli uses the same
  drivers through `execute` (`querybara test` and `querybara query` for both engines).
- Two contracts to keep in step with two drivers; the type-level link between wire types and
  zod schemas is what keeps them honest.
- Extended JSON strings cost a parse on each side, which is small next to the network and keeps
  every BSON type exact through the grid, the editor and exports.
- Replica sets, Sentinel and Cluster through SSH need one forward per node (ioredis `natMap`, a
  MongoDB host map); until then those topologies connect directly or not at all.
