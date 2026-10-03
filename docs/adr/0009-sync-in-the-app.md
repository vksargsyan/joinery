# 0009. Structure and data sync in the app: runner jobs, results kept in main

- Status: Accepted
- Date: 2026-09-29

## Context

`@querybara/sync` compares schema snapshots into tickable operations, generates dependency-ordered
scripts and HTML reports, and compares table data with server-side range checksums over two
Sessions; querybara-cli runs it as `compare` and `data-compare`. The desktop app needs the same
(spec §13): pick two connections, review and tick operations, see both definitions side by
side, preview the script, apply it with progress and stop-on-error, re-compare, page through
row differences, apply data changes, export scripts and reports, save comparisons.

Three constraints shape it. Drivers never load into main or the renderer (ADR 0004, 0006). A
structure diff can be megabytes and a data diff unbounded, so neither can shuttle between
processes on every click. And the write rules (read-only, production, confirm writes, spec §4)
must hold in the process that runs the statements, whatever the page sends.

## Decision

**Compares and applies are job runner jobs.** Four job kinds join import, export and Run SQL
File: `structure-compare`, `structure-apply`, `data-compare` and `data-apply`
(`src/shared/sync-jobs.ts`). A compare opens both connections in the runner, each through its
own tunnel when its profile has one; `start` carries the second resolved profile as `source`.
They show in the job list with progress, cancel and history like every job, and a job's `done`
now carries a `result` for main to keep. Scripts for a selection, the HTML report and the data
sync script are quick runner requests, beside the wizards' previews.

**Main keeps the comparison; the page names it.** `SyncService` (main) keeps each finished
comparison by job id: the full diff with its step order and the source snapshot it was made
from, or a data compare's spool folder. The page gets the diff without the step order and asks
`sync.structure.script({ jobId, selected })`; it ticks operations locally with the engine's
selection helpers (`setOperationSelected`, `missingDependencies`), which need no drivers. A
comparison is forgotten when its panel closes, when newer ones push it out (20 kept), and at
quit.

**An apply runs only the reviewed script.** The page sends the selection and the SHA-256 of the
script it showed; the runner generates the script again from the kept diff and refuses to run a
different one. It then reads the target again and compares it with the kept source snapshot
(spec §13, step 8): the result must hold none of the applied operations, and becomes the panel's
comparison. PostgreSQL scripts run in one transaction; MySQL and MariaDB warn that DDL is not
transactional and ask for an explicit tick.

**Data compares spool to disk.** Main makes a folder per data compare under the app's temporary
folder; the runner writes row differences as display-text pages (the first 10,000 per table and
action) and every sync statement, per action, as JSON lines. Main pages rows out of it for the
grid; the runner reads the statements back to apply them or write the script, so a large diff
never sits in memory and the counts and scripts always cover every row. Tables pair by name and
need a primary or unique NOT NULL key on both sides (`pairDataTables`, added to `@querybara/sync`,
reports why others are skipped). Applying runs one transaction per table and pass: deletes,
child tables first, then updates and inserts, parents first (`dataSyncOrder`), stopping at the
first error; the panel then compares again.

**Write rules twice.** Main refuses to start an apply on a read-only target and needs
`confirmed` for production and confirm-writes targets; the runner checks the same rules against
the profile it was given before running a statement.

**Saved comparisons are a table of their own** (migration 3, `saved_comparisons`): the two
connections as references that a deleted connection clears, and the databases, schemas, options,
rename mapping and data settings as a JSON definition the app validates.

## Consequences

- A structure compare of a large schema crosses the runner → main boundary once, and each script
  request sends the diff back to the runner. Cheap next to introspection; a runner-side cache
  would save it at the cost of state in a process that shuts down when idle.
- A comparison does not survive an app restart; saved comparisons keep the settings to run it
  again. Scheduling saved comparisons (spec §14) can reuse the job kinds as they are.
- The row grid shows the first 10,000 differences per table and action; the counts, the script
  and the apply cover every row.
- Schemas pair by name on PostgreSQL, so comparing schema `a` with schema `b` is out of scope;
  compare two databases instead. Data compare also crosses engine families (no checksums then),
  with one PostgreSQL schema.
- MongoDB and Elasticsearch sync (spec §13) are not covered here.
