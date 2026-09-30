# 0030. Table data in pages; menus open at the pointer

- Status: Accepted
- Date: 2026-10-01

## Context

The table data view loaded 500 rows at a time as the grid scrolled (spec §7). Scrolling far
kept every page in memory, there was no way to jump to the end or to a page, and a row's position
said nothing about where it was in the table. Navicat shows one page of rows, with first,
previous, a page number, next and last, and the page size under a gear.

The grid's right-click menu and the column header menu opened away from the pointer. They
anchored on a `position: fixed` element inside a dock panel, and a dock panel is its own
containing block, so "fixed" was measured from the panel, not the window. The menus were also
plain lists without glyphs.

## Decision

**Pages** (`state/table/paging.ts`, the pager in `TableDataPanel.tsx`):

- The grid shows one page at a time: 1,000 rows by default, or 100, 500, 5,000 or 10,000, chosen
  under the gear. The size is kept in local storage for every table.
- **Boundaries and reads.** Page boundaries are those of LIMIT and OFFSET; how a page is read
  depends on the move.
  - Next and previous continue from the last or first row the server returned, by key when the
    table has one (keyset paging, cheap on any page).
  - A page typed by number reads at its offset, as does every move of a table without a key.
  - Last takes the exact count, counted first when it is not known yet.
- **Edge cases.**
  - A step past a page that was exactly full keeps that page and marks it the last.
  - A page number past the end shows an empty page.
- **Staged changes.** Changing the page or its size asks to discard them first, as a new sort or
  filter does, since their rows may leave the grid.
- **Numbering.** Row numbers, and the Form view's record numbers, count on from the pages
  before. The Form view's Previous and Next cross into the neighbouring pages.

**MongoDB collections page the same way** (`state/mongo/pages.ts`, the shared `Pager`). Each
page is a find with its own skip and limit, inside the skip and limit typed in the query bar
(limit 0 is none). Pages hold 100 documents by default, or 50, 500 or 1,000. Last counts the
matching documents first, and the tree and table number documents on from the pages before.

**Toolbars** of the table data view and the collection view carry a glyph on every button. The
collection view's tools (aggregate, SQL, indexes, schema, options, watch) sit under one Tools
menu, each with what it does, so the toolbar stays on one row.

**Menus at the pointer.** Pointer menus anchor on `PointerAnchor`, a point rendered into the
document body. It is used by the grid's cell menu, the column header menu and the Objects view.

**The cell menu:**

- A header naming the column and its type.
- Set NULL and Set DEFAULT, each disabled when the column has no such value.
- Open referenced row.
- Copy (⌘C), and "Copy as" as a submenu with every format.
- Add, duplicate, revert and delete (last, in red).

Every item of the cell and header menus has its own glyph, and shortcuts are right-aligned.

## Consequences

- The grid no longer asks for rows as it scrolls (`onVisibleRows` is gone).
- The footer's "N rows loaded" counts the rows of the page shown.
