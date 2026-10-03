# 0016. ER model editing: a snapshot edited in place, applied through the structure compare

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §8's ER modelling has a second half after the viewer (ADR 0015): forward engineering.
People add tables, columns, keys and relationships on the diagram, and Querybara writes the SQL
that makes the database match, both for a new design (an empty schema) and for changes to an
existing one. The script has to be right in the ways the table designer and structure sync
already are: dependency order, renames that stay renames, destructive steps flagged, the
engine's quirks (PostgreSQL identities and one transaction, MySQL's `CHANGE COLUMN` and
`RENAME TABLE`, foreign key checks), and the write-safety rules and confirmations that every
write in the app goes through.

Two ways to build it were weighed. The first was a model of its own (entities, attributes,
relationships) with a generator to DDL. That generator would repeat what `@querybara/sync`
already does, and it would need its own diff to produce ALTERs against a live database. The
second was editing a `SchemaSnapshot` in place and handing the edited snapshot to the structure
compare as the desired state, against the live snapshot it started from.

## Decision

**The model is the snapshot.** An ER diagram goes into edit mode on one schema (PostgreSQL) or
database (MySQL, MariaDB). The model starts as the live snapshot, and each edit is a pure
function from one `ModelState` to the next (`state/er-diagram/edit.ts`): add, rename or drop a
table; add, rename, retype, reorder or drop a column; NOT NULL, default, comment and identity or
AUTO_INCREMENT; primary and unique keys; add, change or drop a foreign key. Edits keep the model
consistent the way the server would require. A renamed or dropped column or table follows into
keys, indexes and the foreign keys that reference it, in every schema. A new table gets an
`id bigint` identity (AUTO_INCREMENT) primary key. A relationship to a table's key adds
referencing columns named after it in the singular (`customer_id`), with the key's type (serial
becomes its integer), NOT NULL in a new table and nullable in a live one. Types are respelled
the way snapshots spell them (`varchar(20)` becomes `character varying(20)`), so an edit to the
same type is no change. What the server would refuse is left to the table designer's
`validateTable`, run on every table the model adds or changes, against the rest of the model
with that table as it is live.

**Origins make renames.** The model remembers the live name of every table and column it
started from. `renameRules` turns the differences into the structure compare's rename rules,
so the script says `RENAME TO` / `RENAME COLUMN` / `CHANGE COLUMN`, not a drop and a create.

**The script is the structure compare's.** `compareSchemas(model, live, { renames })` and
`generateScript(…, { include: 'all' })` produce the operations, the ordered statements, the
destructive flags and the warnings. A new design is the same compare against an empty schema.
Warnings about existing rows are left out for tables the script creates.

**Undo and redo** are a stack of model states (200 deep); a refused edit is not a step. The
view draws the model through the same diagram pipeline as the live structure (ADR 0015). New
tables get a place at once (where the canvas was double-clicked, or right of the diagram), and a
renamed table keeps its box's place.

**On the canvas**, boxes move by their header while editing, because each column row is a
connection handle. Dragging from a row to a row of another table adds a foreign key between
those columns. Dragging from a key onto a plain column is read the other way round, and
dropping on a box references its key. A double click on the empty canvas adds a table,
relationships are selected with a click, and Delete removes the selection. New and changed
tables and columns are marked, and tables with errors carry a count. Beside the canvas, the
table editor has the name, comment, columns (type with suggestions from the designer's type
catalog, PK, UQ, NN, AI, default, move and delete), references with their ON DELETE and
ON UPDATE rules, and the tables that reference it. The relationship editor has the rules and
Delete.

**Review & apply** shows the counts by kind, the problems that block the apply, the changes
that lose data (which must be acknowledged), the warnings, and the highlighted script. The
script can be copied, saved as `.sql`, or opened in a SQL tab. Apply runs it with the table
designer's `runScript` on a session on the diagram's database, so the write-safety rules and
confirmations are the ones every write goes through. On success the editor closes and the
metadata cache is invalidated, so the diagram reloads. On failure the model stays, and a
non-transactional (MySQL) script's partial effect is read again. The panel is marked unsaved
while the model has changes, so closing it asks first.

The live structure is not reread into the model while editing. If the metadata shows the
edited schema changed on the server, the edit bar says so. The script still says only what the
model changes, so it does not undo someone else's change.

## Consequences

- No new DDL generator or diff. The model's scripts get every fix and dialect rule the
  structure compare and the table designer get, and the tests assert exact statements for both
  families.
- The model holds everything a snapshot holds, so indexes, checks, triggers, partitions and
  table options survive edits untouched. Editing them is the table designer's job, and it can
  be opened from the diagram outside edit mode.
- A model lives for the panel's lifetime. Saving models between sessions (the local store or a
  model file), designing for an engine other than the connection's, and editing views are
  later work.
- Relationships to tables in other schemas stay as they are and can be dropped, but new ones
  are drawn within the edited schema only.
