# 0018. Saved ER models: drafts in the local store, model files as documents

- Status: Accepted
- Date: 2026-09-30
- Amends: [0016](0016-er-model-editing.md) ("a model lives for the panel's lifetime")

## Context

ADR 0016 kept an edited ER model only while its diagram was open: closing the panel asked
before throwing the changes away, and quitting Joinery lost them. Two things were missing.
People have to be able to stop in the middle of a design and come back to it, after closing the
diagram or restarting the app. And a model should be something to keep and hand on: saved to a
file, reviewed in version control, and opened on another database (a colleague's, a staging
copy, a new schema) to make that database match it.

The two need different meanings. Unapplied changes are relative to the database the model
started from. Reopened later, they must still change only what the user changed, even if
someone has changed the live schema since. Otherwise, the script would undo the other person's
change. A model file is a description of what a schema should look like. Opened on a database,
its script is whatever makes that database match.

## Decision

**One document format** (`erModelDocumentSchema` in `@joinery/ipc`, format
`joinery.er-model`, version 1) holds:

- the engine, database and schema it was saved from;
- the model's edited schema, plus any other schema the model changed where a foreign key
  followed a renamed or dropped table, as snapshot schema definitions;
- the live name each table and column came from;
- the layout: the boxes' places by table (with the schema only for tables of another schema),
  hidden tables, the columns shown and whether views are.

A draft also holds `base`, the whole database snapshot the model started from. A file never
does. The schema is built from the core snapshot types, so the IPC secret audit (every output
typed, nothing free-form) holds.

**Drafts** live in the local store (migration 5, `er_model_drafts`), one per connection, database
and schema, deleted with the connection. The editor writes the draft half a second after each
change, undo and box move included, and removes it when the model changes nothing, is applied,
or is discarded. A pending draft is written when the panel closes, so closing no longer asks. A
diagram that opens on a schema with a draft resumes it in edit mode: the model on its own base,
the layout restored, and a note saying so. If the live schema has changed since, the editor
flags it as stale (ADR 0016). Drafts of the database's other schemas are offered in a banner
with Resume and Discard. The edit bar says whether the changes are kept.

**Model files** are pretty-printed JSON (`*.model.json`), saved from the diagram's Model menu
with the shown schema as edited, or as it is live when not editing. Opening one on a diagram
**rebases** it onto the live schema there:

- The file's edited schema takes the shown schema's place, and its references to its own schema
  follow the new name.
- Each table and column keeps its saved origin where the live schema has it. Otherwise it takes
  the live one of the same name, else it is new. Saved origins claim first, so a table renamed
  away and a new table under the old name stay apart.

The result opens in edit mode against the live schema, to review and apply like any edit. It
creates tables in an empty schema, and renames and alters where the same tables exist. It is
kept as a draft from then on. MySQL and MariaDB models open on each other; PostgreSQL models
only on PostgreSQL. Files are read through `dialogs.readFile`, which main allows only for a file
picked with `dialogs.openFile` in this window (up to 64 MB).

## Consequences

- Nothing typed into a model is lost by closing a panel or quitting. A crash loses at most the
  last half-second of edits.
- A draft costs a whole database snapshot in the store (the base). That is what makes reopening
  it safe. Drafts over 32 MB are refused with a note to save a file instead.
- A file carries no base, so opening it where the schema has drifted shows the full difference,
  drops included. The review lists them, and the apply needs them acknowledged, as for any edit.
- The document is versioned. A file or draft from a newer Joinery is refused with a message,
  and the draft is left in place.
