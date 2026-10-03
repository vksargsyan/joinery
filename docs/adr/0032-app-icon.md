# 0032. The app icon: a joined cylinder, and an Icon Composer icon for macOS 26

- Status: Superseded in part by [0033](0033-querybara-name-and-icon.md) (the artwork and the macOS
  tile)
- Date: 2026-10-01

## Context

The icon was a dovetail joint in amber and navy. Those colours were not Kiln's, and the mark did
not say "database".

macOS 26 and later draw an app's icon from an asset catalog (`Assets.car`, compiled from an Icon
Composer `.icon`). An app with only an `.icns` gets its icon shrunk into a grey tile of the
system's. On macOS 27 that happened to the old icon too, rounded tile and all.

electron-builder 26 can compile a `.icon` at packaging time (`mac.icon: x.icon`), but it needs
Xcode 26's actool on the packaging machine, and it then replaces the `.icns` with actool's.

## Decision

**The artwork** (`apps/desktop/build/icon.svg`):

- A database cylinder built from interlocking parts: three rust bands and a tall face under an
  ivory top. (Replaced by the capybara in 0033.)
- It has a transparent ground. Windows, Linux and the About dialog show it free-standing, at the
  size the SVG gives it.

**macOS** sets it on a Tenmoku tile (Kiln's raised and deep grounds, top to bottom):

- **Tile colour:** the same tile in light and dark mode. The ivory top fades into Bisque.
- **Size:** the artwork's height is 70 % of the tile, centred on what it draws.
- **macOS 15 and earlier** read `icon.icns`: the tile on Apple's grid (824 of 1024 px).
- **macOS 26 and later** read `Assets.car`:
  - `scripts/icons.ts` writes the Icon Composer package `build/icon.icon` (the tile as its fill,
    the artwork as one layer with the system's shadow and no glass);
  - it compiles the package with actool when Xcode 26 or later is installed.
  - `electron-builder.yml` copies `Assets.car` into the bundle's resources and names the icon
    with `CFBundleIconName`.

**`Assets.car` is committed**, like the other generated icons, so packaging needs no Xcode 26:

- CI's macOS runner and Linux and Windows machines package with it as it is.
- A unit test checks that it is an asset catalog and that the packaging bundles it.

## Consequences

- On macOS 26 and later the icon fills the system's tile in the Dock, Finder and Launchpad, with
  the system's shadow. Tinted mode tints it as it does every app.
- Changing the SVG means regenerating on a Mac with Xcode 26:
  `pnpm --filter @querybara/desktop icons`. Elsewhere the generator says that `Assets.car` was not
  compiled.
- The unit test cannot tell a stale `Assets.car` from a fresh one: actool's output is not
  reproducible byte for byte.
- `Assets.car` adds about 2 MB to the bundle.
