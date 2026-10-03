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

**The name** changes everywhere at once. Version 0.1.0 had been out for a day and had a handful
of downloads, so file formats keep no compatibility with it; only a one-time migration of its
data folder carries saved connections over (below).

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

**`Assets.car` is compiled, not committed.** Only Xcode 26's actool compiles it, and only on
macOS 26: on macOS 15 its asset catalog agent crashes. A `macos-26` job in the packaging workflow
compiles it and hands it to the macOS packaging job, and fails rather than let a package go out
without it. A local macOS package needs the generator run on a Mac with macOS 26 and Xcode 26
first. This replaces 0032's committed catalog.

## Consequences

- Installs of 0.1.0 do not update themselves to Querybara. The bundle identifier, the Windows app
  ID and the user-data directory all change, so people reinstall.
- On its first launch, Querybara copies a 0.1.0 install's data from the sibling user-data folder:
  the store (renamed `querybara.db`), `known_hosts`, the converted SSH keys and Chromium's
  `Local State`. It runs only when Querybara has no store yet, never changes the old folder, and
  skips itself when `QUERYBARA_USER_DATA_DIR` is set. Values stored under the previous name are
  translated: the ER model draft format, a scheduled backup's format, method and file name, the
  default application name, and paths to converted SSH keys. A failure is logged and the app
  starts empty. The previous name appears only in that module (`previous-install.ts`).
- Saved passwords stay sealed as they were. On Windows the copied `Local State` holds the key, so
  they still open. On macOS and Linux the key is the old app's keychain or secret service entry;
  Querybara cannot read them and asks for each one once.
- Files 0.1.0 wrote outside its data folder do not open in Querybara: backup archives, saved ER
  models and profile export files. Open them with 0.1.0.
