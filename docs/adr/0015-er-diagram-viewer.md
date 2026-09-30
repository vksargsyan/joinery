# 0015. ER diagrams: a model from the metadata cache, one line router for canvas and export

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §8 lists ER modelling for MySQL, MariaDB and PostgreSQL among the visual tools that share
one canvas stack, React Flow with elkjs auto-layout, and the per-connection metadata cache (§5).
The first part is reading: an entity-relationship diagram of a database, or of one PostgreSQL
schema, reverse-engineered from its structure, which people pan through, rearrange, and export
for documents and reviews. Editing a model and generating DDL from it come later and will need
the same model and drawing.

Three things have to agree: where elkjs puts the boxes (it needs their sizes before anything is
on screen), what the canvas draws, and the exported image. React Flow measures nodes after they
render and routes edges between handles with its own path functions; a PNG captured from the
screen depends on the window, the theme and the zoom, and misses everything scrolled out of
view.

## Decision

**A pure model in the renderer** (`state/er-diagram/model.ts`): `erDiagram(snapshot, dialect,
{ schema, includeViews })` turns a `SchemaSnapshot` from `loadSnapshot` into tables (columns
with type, nullability and P/F/U keys) and a relationship per foreign key. Crow's-foot ends are
read from the schema: the referenced end is "exactly one" when every referencing column is NOT
NULL and "zero or one" otherwise; the referencing end is "zero or many", or "zero or one" when
its columns are the primary key or a unique key (one to one). A foreign key that reaches outside
the shown schemas brings a stub of the referenced table with only the referenced columns,
drawn dashed. MySQL and MariaDB tables take the database as their schema.

**Sizes are computed, not measured.** `boxSize` derives a box's width from its text (a fixed
advance per character, clamped to 180-380 px) and its height from the columns shown (all,
keys and relationship columns only, or none). elkjs lays out those boxes (the layered layout of
ADR 0014, referenced tables to the right); the canvas renders nodes at exactly those sizes with
CSS truncation; the export uses the same numbers. Tables that appear later (views turned on, a
table created since) are laid out among themselves and placed beside the diagram, so an
arrangement the user made by dragging survives a reload.

**One line router** (`route.ts`): a relationship leaves the referencing column's row and reaches
the referenced column's row horizontally, with a straight stretch of 28 px at each end for the
glyph, and turns at right angles with rounded corners: across the gap between boxes side by
side, around the nearer side of boxes above one another, and in a loop off the right side for a
self-reference. The canvas draws it in a custom React Flow edge from the nodes' live positions
(`useInternalNode`), so lines follow a drag; each node carries one hidden handle per side only
because React Flow needs handles to render an edge. The glyphs are SVG markers from one table of
shapes (`markers.ts`), with ids prefixed per panel so several diagrams can be open at once.

**Export from the model**: `diagramSvg` writes a standalone SVG document (light colours, a
caption, hidden tables left out) from the model and the positions; PNG is that SVG drawn on a
canvas at 2x and encoded in the page. Mermaid `erDiagram` text is the third format, for Markdown
that renders it. Files go through a new `dialogs.writeFile` in main that takes text or base64
bytes (up to 64 MB) and writes only to a path granted by `dialogs.saveFile` in this session, the
rule `jobs.start` already follows. Mermaid and SVG text can also go to the clipboard.

**The panel** (`components/er-diagram/`) has the schema picker, columns shown, types, views,
auto layout, fit, refresh and export in its toolbar; the tables on the left with a filter that
also rings matching boxes, visibility per table and a click that brings a table into view; the
canvas with a legend; and the selected table's columns and relationships on the right, each
relationship a link to the other table. Selecting a table fades everything not related to it;
the right-click menu opens its data, opens it in the table designer, shows only it and its
neighbours, or hides it. The diagram reloads when the connection's metadata version changes.

## Consequences

- The canvas, the layout and the exported image agree to the pixel on box sizes and lines
  without measuring the DOM, and the export does not depend on the window or the theme.
- Computed widths are estimates for proportional text; a long name in a narrow font can end in
  an ellipsis a few pixels early. The full name is always in the tooltip and the inspector.
- Lines are routed per relationship and may overlap where several reach the same column; with
  crow's feet at the rows and the selected table's relationships highlighted, they stay
  readable. Routing around boxes is not attempted.
- Diagrams are views of the live structure; positions are kept for the panel's lifetime only.
  Saving a layout, and editing the model with DDL generated through the table designer's
  statements, belong to forward engineering.
- `dialogs.writeFile` is general-purpose, so later exports (other diagrams, reports) need no new
  main handler.
