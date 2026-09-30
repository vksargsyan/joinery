# Joinery

A cross-platform desktop database manager built with Electron, React and Node.js, in TypeScript
end to end. The target is Navicat Premium parity for MySQL, MariaDB and PostgreSQL, Studio
3T-level tooling for MongoDB, and first-class Redis and Elasticsearch support in one app.

![Joinery running a query against PostgreSQL](docs/images/desktop-query.png)

## Status

The foundation, the SQL MVP and the NoSQL modules are built: MySQL, MariaDB and PostgreSQL work
end to end in the desktop app and on the command line, MongoDB and Redis (or Valkey) connect,
browse, query and edit there too, and Elasticsearch has documents, SQL, index and cluster
administration. Data moves between engines with transfers, backups and restores.

What works today:

- **Connections**: profiles with host/port, socket or URI endpoints; the four TLS modes (default
  verify-full); passwords saved in the OS keychain, remembered for the session, or asked every
  time; URI and pgpass import; encrypted profile export; stepwise Test Connection.
- **SSH tunnels and proxies**: SSH with password, private key (OpenSSH, PEM, PuTTY converted on
  import) or ssh-agent, jump hosts and keep-alives, one SSH session shared by a connection's
  tabs; SOCKS5 and HTTP proxies; MongoDB replica sets, Redis Sentinel and Cluster reached node by
  node through them; host keys checked against a known_hosts file the app and the CLI share,
  with a trust prompt for new keys and a blocking warning for changed ones.
- **Querying**: a Monaco editor with run all / statement at cursor / selection; a splitter that
  understands `DELIMITER`, dollar quoting and nested comments; `:name` / `$1` / `?` parameters;
  confirmation before risky writes and for production profiles; streaming results into a canvas
  grid 1,000 rows at a time; server-side cancel; transaction controls; history. Visual explain
  (Explain and Explain Analyze) shows the plan tree with cost, estimated against actual rows and
  the slowest node. Editor buffers are autosaved and come back as tabs after a crash.
- **Visual query builder** (MySQL, MariaDB, PostgreSQL): tables on a canvas with joins proposed
  from foreign keys, side panels for columns, criteria, grouping, sort and limit, and the SQL
  kept in step both ways; SQL the builder cannot show opens read-only. Runs go through the query
  tab, with its safety checks, streaming and history.
- **ER diagrams** (MySQL, MariaDB, PostgreSQL): a database or schema reverse-engineered into
  tables, keys and crow's-foot relationships, laid out automatically and draggable; all columns,
  keys only or names only; a table selected brings out its relationships, with its columns and
  references beside the canvas; search, hide and show only related tables; export as SVG, PNG or
  Mermaid. **Edit model** turns the diagram into a designer: add and rename tables, columns,
  keys and relationships (drag from a column to another table), with undo and redo; Review &
  apply shows the exact CREATE/ALTER script (renames stay renames, data loss is flagged) and
  runs it with the usual write-safety checks, or opens it in a SQL tab. Unapplied changes are
  kept and come back when the diagram reopens, even after a restart; models save as
  `.model.json` files that open on another database or schema to review and apply there.
- **Autocomplete**: keywords, schemas, tables, columns with alias resolution, join conditions
  from foreign keys, functions with signature help, and snippets, computed in a Web Worker from
  a per-connection metadata cache that is ready at connect and refreshes after DDL.
- **Table data**: tables open in an editable grid with server-side sort, a visual filter builder
  or raw WHERE, keyset paging as you scroll, an estimated total with exact count on demand, and
  grid, form and JSON views. Type-aware cell editors with NULL, empty and DEFAULT kept distinct;
  staged edits, inserts and deletes with undo, applied in one transaction after showing the SQL,
  with conflict detection; foreign key lookups and links; copy as TSV, CSV, JSON, Markdown or
  SQL, and paste from spreadsheets. Columns can be hidden, reordered, pinned and resized, and
  saved as named views with their sort and filter.
- **Table designer**: create and alter tables (columns, indexes, foreign keys, unique and check
  constraints, triggers, partitions, options, comment) with validation as you type; Save shows
  the script with data-loss warnings and row counts before running it. Drop table checks what
  depends on the table.
- **Structure sync**: compare two databases, review create / alter / drop operations with
  destructive ones unselected, generate a dependency-ordered script, apply it, and re-compare
  to zero differences. Data compare with server-side range checksums and sync scripts.
  Comparisons can be saved and re-run.
- **Data transfer**: copy tables, collections or keys between connections in one streaming job:
  SQL to SQL across engines (an editable type mapping; create, drop and create, truncate or
  append; keys, indexes and foreign keys after the data), SQL to MongoDB (child rows embedded
  through a foreign key), MongoDB to SQL (flattened fields, child tables or JSON columns for
  arrays) and Redis to Redis (DUMP/RESTORE with TTLs, Cluster-aware).
- **Import and export**: wizards for CSV, TSV, JSON, JSON Lines (gzip too), Excel (.xlsx, streamed,
  with a worksheet picker and header row) and XML (rows at a detected or chosen path) into an
  existing or a new table, with format, delimiter, header and encoding detection, a live
  preview, auto-matched columns, inferred types for new tables, and append, update, upsert,
  delete and replace modes; exports of tables or query results to CSV, TSV, JSON, JSON Lines,
  Excel (typed cells, real dates, a worksheet per table), XML, SQL INSERTs, SQL with DDL, HTML
  or Markdown, one file per table or combined, gzip-compressed or zipped; Run SQL File with stop
  or continue and an error log. Saved wizard settings.
- **Job runner**: imports, exports and SQL files run in their own utility process, several at
  once, with progress, cancel (which rolls back), failed rows by row, line and column, a job
  history and a desktop notification when a long job ends.
- **Backup and restore**: logical backups of PostgreSQL, MySQL and MariaDB in one consistent
  snapshot, MongoDB collections with their options and indexes, and Redis keys with their TTLs,
  to SQL, gzipped SQL or the Joinery archive ([.jbak](docs/backup-archive-format.md): one file
  per object, optional AES-256-GCM encryption with a passphrase); pg_dump and mysqldump when
  installed; restores of everything or selected objects into any database, listing what would
  be dropped before asking; a Redis BGSAVE button.
- **MongoDB**: host lists, SRV, SCRAM, LDAP and X.509 sign-in; an explorer of databases,
  collections, views, time series, GridFS buckets, indexes, users and roles; a collection view
  with a mongosh-syntax query bar and a visual query builder (fields from a sample, typed
  conditions, projection and sort) kept in step with the generated find(), tree, table (with
  drill-down into arrays and sub-documents) and JSON views, a document editor with Extended JSON
  types and conflict detection, bulk update and delete with a matched-count preview, visual
  explain that flags collection scans, an aggregation editor with per-stage previews, an index
  manager, schema analysis exported as JSON Schema or applied as a validator, collection and view
  options, a change stream viewer, a GridFS browser, users and roles, and a command console. A
  SQL tab translates a SELECT to find() or aggregate() as it is typed, runs it, and opens it in
  the collection view or the aggregation editor; any query exports as a Node.js, Python, Java,
  C#, Go or PHP program for the official driver.
- **Redis and Valkey**: standalone, Sentinel and Cluster with ACL users; a SCAN-based key browser
  with a namespace tree, type filters and lazy memory sizes (cluster-wide in Cluster mode);
  editors for strings, hashes, lists, sets, sorted sets, streams (groups and pending entries),
  RedisJSON, HyperLogLog, bitmaps and geo; TTL, rename and copy; bulk delete with a dry run; a CLI
  with autocomplete and inline docs; Pub/Sub, an INFO dashboard, slow log, clients, latency,
  MONITOR, big keys, ACL users, a configuration editor (per node in Cluster mode) and the
  Sentinel/Cluster topology.
- **Elasticsearch**: node URLs or an Elastic Cloud ID; basic auth, API key or
  bearer token; TLS modes; one node through an SSH tunnel or proxy; an explorer with index
  health, data streams and aliases; a Kibana-style console with autocomplete from the open API
  specification; a document grid paged past 10,000 hits with editing, conflict detection and
  bulk actions; SQL with Translate to DSL, and ES|QL, with aggregations as a tree or a table;
  index operations, create index, a mapping editor that plans a reindex when a change cannot
  apply in place, and reindex with live progress; cluster health, nodes, shard allocation with
  its explanation, disk watermarks and tasks; aliases with atomic swaps, index and component
  templates, ILM policies, ingest pipelines with simulate, and snapshots with restore.
  Writes follow the same confirmation rules as SQL.
- **Server tools** (MySQL, MariaDB, PostgreSQL, MongoDB): a monitor polled at a chosen interval
  with the history kept for the session (connections, QPS or TPS, cache and buffer pool hit
  ratios, locks, replication and replica lag, the oplog window); sessions with cancel and
  terminate (KILL QUERY / KILL CONNECTION, killOp); top queries from pg_stat_statements,
  performance_schema digests or the profiler, with the reason and fix when they are off; users,
  roles, membership and a grants matrix, plus default privileges and row-level security policies
  on PostgreSQL; VACUUM, ANALYZE, REINDEX, CLUSTER, OPTIMIZE, CHECK, REPAIR, compact and
  validate; settings with SET, ALTER DATABASE, ALTER SYSTEM, SET GLOBAL / PERSIST or
  setParameter. Every change shows its exact statement first.
- **joinery-cli**: the same engine headless — test, query, compare, data-compare, ddl, import,
  export, run-file, transfer and profile management; test and query for MongoDB, Redis and
  Elasticsearch too; backup and restore for every engine.

Not built yet: the scheduler, Parquet, cloud sync and the AI assistant; the embedded mongosh
shell for MongoDB; RediSearch and offline RDB analysis; a query builder for Elasticsearch. The
product specification lists the full scope.

## Repository layout

pnpm workspaces with Turborepo ([ADR 0001](docs/adr/0001-monorepo-and-source-packages.md)).

| Path                             | Package                         | What it is                                                                                        |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `apps/desktop`                   | `@joinery/desktop`              | Electron app: main, sandboxed preload, React renderer, connection hosts, job runner               |
| `apps/cli`                       | `@joinery/cli`                  | `joinery` command-line tool                                                                       |
| `packages/core`                  | `@joinery/core`                 | Domain types, capability flags, schema snapshot, driver adapter contract                          |
| `packages/ipc`                   | `@joinery/ipc`                  | Typed RPC over MessagePort with zod-validated contracts                                           |
| `packages/storage`               | `@joinery/storage`              | Local SQLite store, migrations, sealed secrets, URI/pgpass import                                 |
| `packages/sql-tools`             | `@joinery/sql-tools`            | Lexer, statement splitter, parameters, safety checks, formatter, diagnostics, query builder model |
| `packages/sync`                  | `@joinery/sync`                 | Structure diff and script generation, data compare                                                |
| `packages/table-data`            | `@joinery/table-data`           | Table data paging, filters, staged changes and apply, cell parsing, copy/paste                    |
| `packages/drivers/sql-base`      | `@joinery/driver-sql-base`      | Shared endpoint, TLS, error mapping and Test Connection logic                                     |
| `packages/drivers/postgres`      | `@joinery/driver-postgres`      | PostgreSQL adapter (pg, pg-cursor)                                                                |
| `packages/drivers/mysql`         | `@joinery/driver-mysql`         | MySQL and MariaDB adapter (mysql2)                                                                |
| `packages/drivers/mongodb`       | `@joinery/driver-mongodb`       | MongoDB adapter (mongodb) with document, index, GridFS and change stream services                 |
| `packages/mongo-tools`           | `@joinery/mongo-tools`          | mongosh-style query parsing, Extended JSON, find() text, schema analysis                          |
| `packages/drivers/redis`         | `@joinery/driver-redis`         | Redis and Valkey adapter (ioredis): standalone, Sentinel, Cluster; keys, CLI, tools               |
| `packages/redis-tools`           | `@joinery/redis-tools`          | redis-cli tokenizer and reply formats, command docs, INFO parsers, value codecs                   |
| `packages/drivers/elasticsearch` | `@joinery/driver-elasticsearch` | Elasticsearch adapter on its own HTTP client: documents, SQL, administration                      |
| `packages/search-tools`          | `@joinery/search-tools`         | Console parser, lossless JSON, request classifier, SQL and admin reply readers, autocomplete      |
| `packages/tunnel`                | `@joinery/tunnel`               | SSH tunnels (jump hosts, shared sessions), HTTP/SOCKS5 proxies, host key checks                   |
| `packages/transfer`              | `@joinery/transfer`             | Streaming CSV/TSV/JSON/Excel/XML import, export also to HTML/Markdown, ZIP, mapping               |
| `packages/backup`                | `@joinery/backup`               | Backup and restore for every engine, the .jbak archive, pg_dump/mysqldump                         |

Packages under `packages/` never import Electron, so the CLI and the tests use them directly.

## Getting started

Requirements: Node.js 22.13 or later and pnpm 10 (`corepack enable` picks up the pinned
version).

```sh
pnpm install
pnpm check            # format check, lint, typecheck and unit tests across the workspace
```

Run the desktop app in development:

```sh
pnpm --filter @joinery/desktop dev
```

Build a test installer for the current OS with `pnpm --filter @joinery/desktop package` (output
in `apps/desktop/dist`). The Package workflow builds and smoke-tests the installers of every
platform: AppImage, deb and rpm (x64, arm64), NSIS, MSI and zip (x64, arm64), and a universal
macOS DMG. A `v*` tag builds a release, signed and notarised when the signing secrets are set,
with auto-update (stable and beta channels, staged rollout, a policy switch for managed fleets),
a CycloneDX SBOM and third-party licence notices, into a draft GitHub release; see
[docs/releasing.md](docs/releasing.md). Test builds are not signed: macOS asks you to allow them
in System Settings → Privacy & Security the first time they open.

Build and use the CLI:

```sh
pnpm --filter @joinery/cli build
node apps/cli/dist/joinery.mjs --help
node apps/cli/dist/joinery.mjs compare postgres://app@db1/shop postgres://app@db2/shop --out sync.sql
node apps/cli/dist/joinery.mjs query "postgres://app@10.0.3.7/shop" --ssh ops@bastion.example.com --ssh-agent -e "select 1"
node apps/cli/dist/joinery.mjs import dev --table public.people --file people.csv --mode upsert --key id
node apps/cli/dist/joinery.mjs export dev --table orders --table items --format sql-ddl --one-file --out shop.sql.gz --gzip
node apps/cli/dist/joinery.mjs import dev --table sales --file q3.xlsx --sheet July --create --key id
node apps/cli/dist/joinery.mjs export dev --table orders --table items --format xlsx --one-file --out shop.xlsx
node apps/cli/dist/joinery.mjs run-file dev migrate.sql --continue
JOINERY_BACKUP_PASSPHRASE=… node apps/cli/dist/joinery.mjs backup prod --out shop.jbak --encrypt
node apps/cli/dist/joinery.mjs restore dev shop.jbak --select public.orders --database shop_copy --create-database
```

The CLI shares the desktop app's saved connections (`--store` or `JOINERY_STORE` point it at
another store file).

## Tests

- `pnpm test` runs the unit tests of every package.
- `pnpm test:integration` runs the driver, sync round-trip and CLI suites against real servers.
  Each engine's suite runs only when its URL is set, for example:

  ```sh
  export JOINERY_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/joinery_test
  export JOINERY_TEST_MYSQL_URL=mysql://root:secret@127.0.0.1:3306/joinery_test
  export JOINERY_TEST_MARIADB_URL=mariadb://root:secret@127.0.0.1:3307/joinery_test
  pnpm test:integration
  ```

  Test URLs default to TLS off; add `?tls=verify-full` (and the `JOINERY_TEST_*_TLS_CA`
  variables) to test TLS.

- `xvfb-run -a pnpm --filter @joinery/desktop test:e2e` drives the built Electron app with
  Playwright against `JOINERY_TEST_POSTGRES_URL` (drop `xvfb-run` on a desktop).

CI runs format, lint, typecheck and unit tests, a dependency audit, the integration suites
against PostgreSQL, MySQL and MariaDB service containers (the full version matrix nightly), and
the desktop end-to-end tests.

## Design documents

- Architecture decision records: [`docs/adr`](docs/adr/README.md).
- The product and technical specification is a living document shared separately; each ADR
  cites the section it implements.

## Conventions

Strict TypeScript with no `any`, ESLint and Prettier, an ADR for every major choice, and
conventional commits.
