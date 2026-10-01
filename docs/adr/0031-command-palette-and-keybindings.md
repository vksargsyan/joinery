# 0031. A command palette, Go to Object, and key bindings as VS Code's

- Status: Accepted
- Date: 2026-10-01

## Context

Every action took the mouse: a menu, a toolbar button or a tree node. Few keys did anything
outside the editor and the grid. People who use VS Code expect:

- ⌘P to open something by a few of its letters;
- ⌘⇧P to run any command by name;
- key bindings they can see in one place and change.

## Decision

**Commands** (`state/commands.ts`, `components/app-commands.ts`):

- Each command has an id, a category, a title, a glyph, an optional condition, and what it runs.
- **Groups:** connection, query, table, collection, view, tools, preferences and help.
- **Commands that need a choice** ask for it in the palette's list: Connect…, Disconnect…,
  Create Table… (which schema), Create Collection… (which database).
- **Recently used:** the palette remembers recently used commands, but not its own two (Show All
  Commands, Go to Table or Collection).

**The palette** (`components/CommandPalette.tsx`) sits at the top of the window, as VS Code's
quick input:

- **⌘P, Go to Table or Collection.** It searches the tables, views and collections of the
  connected connections (`state/quick-open.ts`):
  - SQL connections answer from their schema snapshot, the one autocomplete reads;
  - every connection answers from what its explorer has loaded;
  - MongoDB loads the collections of its first eight databases.
  - Recently opened objects come first, and an entry opens as a click in the tree does.
- **">" (⌘⇧P) lists the commands:** recently used first, then the others, each with its key
  binding as key caps.
- **Matching** is fuzzy (`lib/fuzzy.ts`): characters in order, with runs, word starts and the
  start scoring highest. Matches show in rust.
- **The title bar's middle** is VS Code's command center, the active tab's title in a search box
  that opens the palette.

**Key bindings** (`state/keybindings.ts`, `lib/keys.ts`):

- **Format:** VS Code's, "mod+shift+p", with chords as "mod+k mod+s". `mod` is ⌘ on macOS and
  Ctrl elsewhere.
- **Reading keys:** letters, digits and punctuation are read by position, so Shift and keyboard
  layouts do not change them.
- **One listener on the window** runs the bound command before the page's own handlers.
  - After a chord's first key it waits 1.5 s for the second, and says so at the bottom of the
    window.
  - Keys without ⌘, Ctrl or Alt (F5) leave text fields alone.
  - Nothing runs while a dialog is open.
- **Defaults** include:

  | Keys  | Command            |
  | ----- | ------------------ |
  | ⌘⇧P   | Commands           |
  | ⌘P    | Go to Object       |
  | ⌘K ⌘S | Keyboard Shortcuts |
  | ⌘K ⌘T | Theme              |
  | ⌘T    | New query tab      |
  | ⌘W    | Close tab          |
  | ⌃Tab  | Next tab           |
  | ⌃⇧Tab | Previous tab       |
  | F5    | Refresh            |
  | ⌘⇧N   | New connection     |
  | ⌘⇧F   | Search connections |
  | ⌘⇧H   | History            |
  | ⌘⇧O   | Objects            |
  | ⌘⇧J   | Jobs               |

- **The user's bindings** override the defaults by command, with "" for none. They are kept in
  the app's settings (`keybindings`), the way keybindings.json is, and replaced whole on update.

**The Keyboard Shortcuts editor** (`components/KeybindingsPanel.tsx`) is a tab listing every
command with its keys and source (Default or User):

- **Search:** by name, id or keys.
- **Recording:** a double-click, Enter or the pencil records new keys. Press them, a chord of two
  too, then Enter; Escape cancels.
- **Shared keys:** a binding two commands share is marked.
- **Remove and reset:** a binding can be removed, or reset to its default.

**Menus:**

- **View menu:** it gains Command Palette…, Go to Table or Collection… and Keyboard Shortcuts.
  The Windows and Linux menu bar shows their current keys.
- **Ctrl+W:** on Windows and Linux, the window's Close moves to Ctrl+Shift+W, as in VS Code, so
  Ctrl+W closes the tab.

## Consequences

- Panels of no connection (Schedules, Keyboard Shortcuts) count as no active connection, so New
  Query falls back to a connected one.
- The icon names moved to `components/icon-names.ts`, so modules without JSX (state) can name
  glyphs.
