# 0025. The Kiln design system for the app's look

- Status: Accepted
- Date: 2026-09-30

## Context

Querybara's theme was a set of neutral blue-grey tokens (`bg`, `panel`, `panel-2`, `hover`,
`border`, `fg`, `muted`, `accent` and three status colours) that components used through
Tailwind. Monaco and the Glide data grids, which draw on a canvas, carried their own hex values.
The app is to follow **Kiln**, a design system first made as a warm editor theme fired from
ceramic glazes. It has two themes: Tenmoku (dark) and Bisque (light).

Kiln is precise about roles:

- **Grounds are a ladder.** Chrome sits one step deeper than the working surface, and floating
  surfaces one step raised.
- **Rust is the only accent.** Selections are washes of it, not fills.
- **The other glazes carry meaning.** Celadon is success, ochre warning, red error, cobalt info.
- **Geometry is VS Code's workbench.** Controls are 26px tall with 2px corners; tree rows are
  22px.
- **Code is set in Rec Mono Duotone.** Its cursive italic marks comments.

## Decision

**Kiln's tokens become the theme tokens.** `styles.css` declares every Kiln colour as a `--k-*`
property per theme:

- Tenmoku under `[data-theme='dark']`, Bisque under `[data-theme='light']`.
- The app's role names map onto them:
  - `bg` is the working surface.
  - `panel` is chrome (`bg-deep`).
  - `panel-2` is a raised surface.
  - `accent` is rust.
  - `danger`, `warning` and `success` are red, ochre and celadon.
  - `focus` is rust at 60%.
- Existing components keep their classes and change look together.
- Kiln's own names are Tailwind colours too (`deep`, `raised`, `pressed`, `faint`, `rust`,
  `cobalt`, `list-active`, `badge`…), for new work.
- Environments take a glaze each: dev celadon, test cobalt, staging ochre, production red.
- Tailwind's radius scale is set to VS Code's (`rounded` is 2px).
- `shadow-widget` is the only shadow; floating surfaces use it.

**The shared controls follow Kiln's components:**

- **Buttons:**
  - The primary button is solid rust, and there is one per view.
  - Secondary buttons are `bg-hover`.
  - A destructive button is a secondary with red text, never a red fill.
  - Chrome buttons (`quiet`) are muted until hovered.
- **Inputs and selects** sit on `bg-deep` and take a rust focus border.
- **Menus, popovers and dialogs** sit on the raised ground with a border and the widget shadow.
  A highlighted menu row is the rust list wash.
- **Selected toggles** are a rust 20% wash with `fg` text instead of a solid fill.
- **Tree rows** are 22px, with muted text and a rust focus wash.
- **Editor tabs** get a rust top hairline when active, dimmed in a group without focus.
- **The status bar** is 22px on the chrome ground.

**Canvas-drawn parts take the same values from `lib/kiln.ts`.** A test checks that it matches
`styles.css`.

- **Monaco:**
  - Kiln themes are defined in `lib/monaco.ts`: the Workbench map for the editor chrome, the
    Syntax map for tokens.
    - Keywords are rust, built-in functions cobalt, strings celadon, numbers and constants
      lilac.
    - Object keys are peach, regex and escapes teal.
    - Comments are italic, operators `punct`.
  - The language-specific rules of Monaco's base themes (`string.sql`, `predefined.sql`) are
    repeated, since they would otherwise win.
  - Every editor takes Kiln's code setting: Rec Mono Duotone, a 1.65 line height, and a 2px
    rust cursor.
- **Grids:**
  - Cells are on the working surface and headers on the chrome ground.
  - Selection is a rust wash, search hits ochre, links cobalt, NULL `faint`.
  - Staged edits, inserts and deletes use ochre, celadon and red washes.

**Fonts are bundled.**

- Rec Mono Duotone and Rec Mono Linear (Recursive 1.085, SIL Open Font License 1.1) ship as
  woff2 files in the renderer's assets. UI text stays the platform font at 13px, as Kiln
  specifies.
- The licence report (ADR 0013) gains bundled assets: files that are not npm packages, each
  with its licence file, listed with `source: 'asset'`.
- The About box and the notices show them. The SBOM names them as generic components instead
  of looking them up in the lockfile.

## Consequences

- One edit to `styles.css` and `lib/kiln.ts` restyles the whole app; components do not carry
  colours.
- Panel-specific polish (spacing, density, individual layouts) is left to later changes, each
  against the design system. This record covers the tokens and the shared controls.
- Kiln's file glyphs (Kiln Glyphs) are not used yet: the tree's icons stay the app's own.
