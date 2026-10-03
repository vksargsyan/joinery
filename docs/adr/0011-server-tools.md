# 0011. Server tools: one engine-neutral vocabulary, statements built and checked in the host

- Status: Accepted
- Date: 2026-09-29

## Context

Spec §15 asks for a monitoring view, a session list, top queries, user management, maintenance
and settings on MySQL, MariaDB, PostgreSQL and MongoDB (Redis has its own module, ADR 0007),
with charts polled at a user-set interval, and with every action showing the statement or
command it runs. The engines differ in everything: pg_stat_activity against SHOW PROCESSLIST
against $currentOp, pg_stat_statements against performance_schema digests against the
profiler, role membership and RLS policies that only PostgreSQL has, and columns that change
between PostgreSQL 13 and 18 or between MySQL and MariaDB. Privileges and extensions are often
missing, and managed services refuse SUPER and ALTER SYSTEM.

Six tabs times three engine families written as engine-specific wire types and components would
triple the renderer, and a preview built in the page could drift from what the host runs.

## Decision

**An engine-neutral vocabulary in `@querybara/core`** (`server-tools.ts`): `ServerTools` and the
shapes it returns. What only one engine has travels as labelled data, not as types: monitor
tiles are gauges, counters (the page derives per-second rates) or counter pairs (the page
derives the ratio over each interval: cache hit ratio, average latency), sections are small
tables with unit-hinted columns, sessions and top queries carry a `detail` record with column
labels, settings carry the scopes they can change in. The renderer draws every engine with the
same components; the Redis INFO dashboard's sparklines and history are reused.

**Each driver implements `ServerTools`** in new files (`server-tools/` in the SQL drivers,
`server-tools.ts` in MongoDB), over the public Session contract only: SQL through `execute`,
MongoDB through `execute` of command documents (switching the session's database for the
commands that run in one, serialised). Version differences are read, not assumed: `to_jsonb`
rows for pg_stat_* views, pg_stat_statements columns looked up per installed extension version,
MariaDB detected from the version banner. Missing prerequisites come back as data with a reason
and a fix (`TopQueries.unavailable`: not installed, not loaded, disabled, no privilege), and
privilege errors get hints naming the privilege or role.

**Actions are data; statements are built only in the host.** A `ServerAction` (kill, maintenance,
setting, grant...) goes to `serverTools.preview`, which returns the exact statements with
passwords masked; the page shows them in the confirmation; `serverTools.run` rebuilds the same
statements from the same action and runs them. Names are quoted with `@querybara/sql-tools`,
values are literals, and anything the server can name itself (a function's signature) is
resolved on the server rather than taken from the page. Policy expressions, the only SQL the
user types, are checked to be one expression that cannot escape its parentheses.

**The host enforces the write rules** (`apps/desktop/src/shared/server-tools-safety.ts`): a
read-only profile refuses every change (CHECK TABLE, validate and session-only settings still
run); kills, maintenance, settings, drops and revokes need confirmation on every profile; every
change needs it on production and confirm-writes profiles. The page asks through the same
rules before it sends.

**One panel per connection, its own sessions.** The server tools panel opens its own sessions
(one per database on PostgreSQL, where objects are reachable only from their database), polls
the monitor whichever tab is showing, and keeps the history per connection for the app session.

## Consequences

- A new engine (Elasticsearch next) implements `ServerTools` and the existing tabs show it.
- The monitor's derived figures are computed once, in a pure view model, for every engine.
- A preview costs one round trip; in exchange the confirmation always shows what runs.
- Engine-specific depth that does not fit the vocabulary (MongoDB users and roles) stays in its
  module and is linked from the Users tab.
