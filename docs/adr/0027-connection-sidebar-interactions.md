# 0027. The connection side bar works as Navicat's

- Status: Accepted
- Date: 2026-10-01

## Context

The connection side bar connected on a single click and showed a chevron on every connection,
so browsing the list opened connections by accident. Its header had a folder button and a
"+ New" button, and a long list could not be narrowed. Navicat, which the app's users know, has
settled answers for these.

## Decision

**Connections** (`components/Sidebar.tsx`):

- A click selects a connection. A double-click, or Enter, connects it; on a connected one it
  folds or unfolds the tree.
- While it connects, a small rust spinner takes the place of its actions button ("…"), also
  while the password prompt is open.
- Only a connected connection has a chevron, and the chevron folds its tree. A lost or failed one
  shows a red dot.
- The engine icon is dimmed until the connection is open. The green status dot is gone; a
  connection's own colour still shows as a dot.

**Menus:** every item of the tree's menus (connections, folders, objects, MongoDB, Redis and
Elasticsearch nodes) has its own glyph in the Kiln Glyphs manner, as the header's menu does.

**The header** keeps the "Connections" title and a kebab menu at its right. The menu has three
items, each with its own glyph:

- New connection.
- New folder.
- Close all connections, with the count of open ones; disabled when none are open. A connection
  still connecting is left to finish.

**The bottom of the side bar** holds the search and the filter (`state/sidebar-filter.ts`):

- **Search:** matches connection and folder names, ignoring case. The match shows in bold rust,
  and every folder that shows is open while searching.
- **Filter:** engines (with their icons), environments, and "Connected only". A rust dot marks the
  filter button while the filter is on.
- **No match:** when nothing matches, the tree says so and offers to show all connections.
- Both last while the app runs. There are no favourites.

## Consequences

- End-to-end tests connect with a double-click and open the connection dialog from the header's
  menu (`openNewConnection` in `e2e/app.ts`).
- The tree's other rows (objects, keys, indexes) keep click-to-toggle; `Row`'s `clickToggles`
  option turns it off for connections.
