# Joinery

A cross-platform desktop database manager built with Electron, React and Node.js, in TypeScript
end to end. The target is Navicat Premium parity for MySQL, MariaDB and PostgreSQL, Studio
3T-level tooling for MongoDB, and first-class Redis and Elasticsearch support in one app.

![Joinery running a query against PostgreSQL](docs/images/desktop-query.png)

## Status

This is the phase 0 foundation: MySQL, MariaDB and PostgreSQL work end to end in the desktop app
and on the command line. MongoDB, Redis and Elasticsearch are designed for (engine ids,
capability flags, profile shapes) but have no drivers yet.

What works today:

- **Connections**: profiles with host/port, socket or URI endpoints; the four TLS modes (default
  verify-full); passwords saved in the OS keychain, remembered for the session, or asked every
  time; URI and pgpass import; encrypted profile export; stepwise Test Connection.
- **Querying**: a Monaco editor with run all / statement at cursor / selection; a splitter that
  understands `DELIMITER`, dollar quoting and nested comments; `:name` / `$1` / `?` parameters;
  confirmation before risky writes and for production profiles; streaming results into a canvas
  grid 1,000 rows at a time; server-side cancel; transaction controls; history.
- **Structure sync**: compare two databases, review create / alter / drop operations with
  destructive ones unselected, generate a dependency-ordered script, apply it, and re-compare
  to zero differences. Data compare with server-side range checksums and sync scripts.
- **joinery-cli**: the same engine headless — test, query, compare, data-compare, ddl and
  profile management.

Not built yet: SSH tunnels and proxies, the job runner and scheduler, backup and restore, data
transfer and import/export wizards, visual designers and ER modelling, explain plan views,
grid editing, server tools, cloud sync and the AI assistant. The product specification lists
the full scope.

## Repository layout

pnpm workspaces with Turborepo ([ADR 0001](docs/adr/0001-monorepo-and-source-packages.md)).

| Path                        | Package                    | What it is                                                                       |
| --------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `apps/desktop`              | `@joinery/desktop`         | Electron app: main, sandboxed preload, React renderer, connection host processes |
| `apps/cli`                  | `@joinery/cli`             | `joinery` command-line tool                                                      |
| `packages/core`             | `@joinery/core`            | Domain types, capability flags, schema snapshot, driver adapter contract         |
| `packages/ipc`              | `@joinery/ipc`             | Typed RPC over MessagePort with zod-validated contracts                          |
| `packages/storage`          | `@joinery/storage`         | Local SQLite store, migrations, sealed secrets, URI/pgpass import                |
| `packages/sql-tools`        | `@joinery/sql-tools`       | Lexer, statement splitter, parameters, safety checks, formatter, diagnostics     |
| `packages/sync`             | `@joinery/sync`            | Structure diff and script generation, data compare                               |
| `packages/drivers/sql-base` | `@joinery/driver-sql-base` | Shared endpoint, TLS, error mapping and Test Connection logic                    |
| `packages/drivers/postgres` | `@joinery/driver-postgres` | PostgreSQL adapter (pg, pg-cursor)                                               |
| `packages/drivers/mysql`    | `@joinery/driver-mysql`    | MySQL and MariaDB adapter (mysql2)                                               |

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

Build and use the CLI:

```sh
pnpm --filter @joinery/cli build
node apps/cli/dist/joinery.mjs --help
node apps/cli/dist/joinery.mjs compare postgres://app@db1/shop postgres://app@db2/shop --out sync.sql
```

The CLI shares the desktop app's saved connections (`--store` or `JOINERY_STORE` point it at
another store file).

## Tests

- `pnpm test` runs the unit tests of every package.
- `pnpm test:integration` runs the driver and CLI suites against real servers.
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
