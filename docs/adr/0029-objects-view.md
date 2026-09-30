# 0029. The Objects view, and a click on a table opens it

- Status: Accepted
- Date: 2026-10-01

## Context

The explorer tree only listed names. Seeing how big a table is, how many rows it has, its engine
or its comment meant a query or the maintenance tool. Navicat's main area starts on an Objects
tab that lists what the chosen database, schema or folder holds, with each object's statistics.

A table also took a double-click to open, while in Navicat one click shows its data. The drivers
already returned the statistics in each node's `detail` ("for the object list pane"), but nothing
showed them.

## Decision

**The Objects tab** (`components/ObjectsPanel.tsx`, `state/objects-view.ts`,
`state/objects-model.ts`) adds to the tree and replaces nothing.

**What a click lists.** A click on a container still expands it, and also shows its objects:

| Engine         | Container clicked | Lists                 |
| -------------- | ----------------- | --------------------- |
| MySQL, MariaDB | database          | its tables            |
| PostgreSQL     | database          | its schemas           |
| PostgreSQL     | schema            | its tables            |
| MongoDB        | database          | its collections       |
| any            | folder            | that folder's objects |

- There is one Objects tab. The click opens it, or brings it forward.
- The chevron only expands.
- The tree marks the node the tab shows.

**Columns.** The list reads the explorer's own cache (`browse`), so the tree and the tab load,
refresh and fail together. The columns are the statistics present, in Navicat's order, with the
comment last:

- SQL: rows, data and index size, engine, auto increment, created and modified, collation,
  owner, and routine and partition details.
- MongoDB: documents, size, storage size, index size, indexes.

**Using the list:**

- Columns sort (numbers as numbers, empty values last), and a search narrows the list by name.
- A click selects, Cmd/Ctrl adds to the selection, Shift extends it, and arrows move.
- A double-click or Enter opens a table's data, a view's rows or a collection's documents. On a
  schema or database it goes in.
- A right-click opens the same menu as the tree. The object menus moved out of the tree into
  `ObjectMenu.tsx` and `MongoNodeMenu`, so both places share them.
- **Toolbar:**
  - SQL: open, design, new table, drop, import and export.
  - MongoDB: open and new collection.
  - Both: refresh.
- **Status bar:** the count, the selection, and the size on disk.

**A click on a table, a view or a collection opens it** (data view, query tab or collection
view). An open one is brought forward: views remember their query tab. The chevron expands the
object's columns and indexes. Double-click still works.

## Consequences

- Clicking a database or a folder moves the focus to the Objects tab. To expand one without
  that, click its chevron. End-to-end tests that only expand do so.
- Redis and Elasticsearch keep their own trees; the Objects tab does not cover them yet.
