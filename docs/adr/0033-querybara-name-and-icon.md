# 0033. The name Querybara, and a capybara icon

- Status: Accepted
- Date: 2026-10-03
- Supersedes: the artwork and the macOS tile of [0032](0032-app-icon.md)

## Context

The product's first name was already the name of another SQL database manager. Keeping it would
confuse people looking for either app and could draw a trademark dispute. The new name is
Querybara, on the domain querybara.com, with a new icon: a capybara resting a paw on a database
cylinder, drawn on cream.

## Decision

**The name** changes everywhere at once, with no compatibility layer. Version 0.1.0 had been out
for a day and had a handful of downloads.

- **Product and packages:** Querybara, the `querybara` command, `@querybara/*` packages,
  `QUERYBARA_*` environment variables, `QuerybaraError`.
- **App ID:** `com.querybara.desktop`, after the domain. It sets the macOS bundle identifier, the
  managed-preferences domain and the Windows app user model ID.
- **Backups:** the archive is `.qbak`, and its magic is `QBAK\r\n\x1a\n` with the trailer
  `QBAKEND\0`. The lengths are unchanged.
- **Repository:** `vksargsyan/querybara`. The update feed follows the repository.

**The artwork** (`apps/desktop/build/icon.svg`) is the capybara traced to SVG from the 1254 px
original at twice its size, in six flat colours: orange, two browns, an outline brown, navy and
the cylinder's cream bands. The ground stays transparent. Windows, Linux and the About dialog show
it free-standing.

**macOS** sets it on a cream tile (`#fffdf8` to `#f1ebdf`, top to bottom), the ground it was drawn
on, in light and dark mode alike. The capybara's dark outline would sink into the Tenmoku tile of 0032. The rest of 0032 stands: the artwork at 70 % of the tile, the `.icns` for macOS 15 and
earlier, and the Icon Composer package compiled into `Assets.car` for macOS 26 and later.

**`Assets.car` is compiled, not committed.** Only Xcode 26's actool compiles it. The macOS
packaging job selects Xcode 26 or later and runs the icon generator before packaging, and fails
when actool is missing rather than ship a package without it. A local macOS package needs the
generator run on a Mac with Xcode 26 first. This replaces 0032's committed catalog.

## Consequences

- Installs of 0.1.0 do not update themselves to Querybara. The bundle identifier, the Windows app
  ID and the user-data directory all change, so people reinstall. Saved connections and keychain
  entries stay with the old app.
- A backup archive made by 0.1.0 does not restore in Querybara. Restore it with 0.1.0.
