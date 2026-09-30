# 0013. Packaging, auto-update and the licence audit: electron-builder and GitHub Releases

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §20 asks for signed installers on every platform (Windows NSIS, MSI and a portable zip;
a universal macOS DMG and zip, notarised; Linux AppImage, deb, rpm and Flatpak), auto-update
through electron-updater with stable and beta channels, a staged rollout and a switch that turns
updates off for managed fleets, and a licence audit before release; §18 adds a software bill of
materials per release. The repository has no signing certificates yet, so everything that signs
must be configuration that runs once the secrets exist and is skipped cleanly until then. The
ad-hoc signed macOS test build and its install-and-smoke-test must keep working.

Two facts shape the rest. electron-vite bundles every dependency into `out/` (ADR 0004) and the
local store is `node:sqlite` (ADR 0002), so the package carries no `node_modules` and no native
module to rebuild per target. And the app's dependencies are all build-time `devDependencies`,
so the declared dependency tree says nothing about what actually ships: the bundle does.

## Decision

**Two electron-builder configurations, and the update feed as the release switch.**
`electron-builder.yml` is the release build: it publishes to GitHub Releases, so electron-builder
writes `resources/app-update.yml` into the app and `latest*.yml` next to the installers.
`electron-builder.adhoc.yml` extends it for test builds (pull requests, `pnpm package`): no
`publish`, ad-hoc macOS signature, no notarisation. The app only updates itself when it finds
the feed, so no test build, development run or e2e test can ever prompt for an update.

**Targets.** NSIS (one installer holding x64 and arm64), a per-machine MSI and a zip for
Windows; a universal DMG and zip for macOS (the zip is what Squirrel.Mac updates from); AppImage,
deb and rpm for x64 and arm64. **No Flatpak**: electron-builder's `flatpak` target produces a
single-file bundle that no update channel reaches (electron-updater cannot replace it and there
is no repository), defaults to the end-of-life 20.08 runtime, and needs flatpak-builder with
about a gigabyte of runtime, SDK and Electron base app on the runner for each build. The route
that serves Flatpak users is a Flathub listing (`dev.joinery.desktop`, on
`org.electronjs.Electron2.BaseApp`) that repackages the released x64 and arm64 builds and gets
updates from Flathub; it needs a Flathub submission, outside this repository.

**Signing is configuration in the Package workflow.** Secrets reach a job only in `v*` tag runs.
macOS: a Developer ID certificate and an App Store Connect API key, hardened runtime, notarytool,
then `stapler validate` and `spctl --assess`; without both, the release falls back to the ad-hoc
build. Windows: a `.pfx` certificate or Azure Trusted Signing, with `forceCodeSigning` so a
failed signature fails the release. Without secrets the release is unsigned and says so.

**Auto-update: electron-updater on GitHub Releases.** Channels map to GitHub's pre-release flag,
which electron-updater's GitHub provider already understands: stable = channel `latest`, no
pre-releases (GitHub's "latest release"); beta = channel `beta` with pre-releases (the newest
release of either kind); `allowDowngrade` stays off, so leaving beta waits for the next stable.
The staged rollout is electron-updater's `stagingPercentage` in the release metadata, set at
build time or afterwards by `scripts/rollout.ts`. A controller in main (`updates.ts`) drives the
updater behind a small port, reports a typed status (`updates.*` in the main contract) to the
About box and a quiet "ready, restart" notice, and checks 30 s after start and every 4 hours.
The updater runs in its own session that may only reach GitHub over https. It replaces NSIS
installs, app bundles, AppImages, and deb and rpm installs (through the graphical sudo prompt,
only when the user presses Restart). A Windows build without a code-signing publisher never
updates itself, since electron-updater would skip its Authenticode check; MSI, zip and unpacked
installs are updated by redeploying.

**The policy switch** (`update-policy.ts`) merges every machine-wide source an administrator
controls: `HKLM\SOFTWARE\Policies\Joinery` (Group Policy, Intune), macOS managed preferences for
`dev.joinery.desktop` (MDM profiles), `/Library/Application Support/Joinery/policy.json`,
`/etc/joinery/policy.json`, and `JOINERY_DISABLE_UPDATES`. Any source can turn updates off, the
first names the channel, and a file that exists but does not parse turns updates off. Windows
has no policy file, because standard users can create folders under `%ProgramData%`.

**The licence audit reads the bundle.** A Vite plugin (`scripts/third-party.ts`) collects the
npm package of every module that rendered code into main, preload, renderer and worker chunks,
adds the Electron runtime and Tailwind's compiled CSS, and writes `third-party.json` (the About
box's licence list) and `THIRD_PARTY_NOTICES.txt`. It fails the build when a shipped package is
AGPL, GPL, LGPL or SSPL with no permissive choice, or declares no usable licence (unless a
person recorded the licence they read under `reviewed`). Since it runs in `electron-vite build`,
CI, the e2e runs and every package build enforce it.

**The SBOM is CycloneDX 1.6 JSON from the pnpm lockfile** (`scripts/sbom.ts`): the desktop app's
dependency closure with versions, purls, integrity hashes, licences and the dependency graph,
shipped packages `required` and build tools `excluded` according to the licence report. It is
written by our own ~300 lines because `@cyclonedx/cyclonedx-npm` reads npm's tree, not pnpm's,
and cdxgen brings a large dependency tree of its own for what is a lockfile walk; the output was
checked against the official 1.6 schema.

Icons come from one SVG, rendered by resvg (a build-time tool) into `.icns`, `.ico` and the
Linux PNG set, committed and checked by a unit test.

## Consequences

- Nothing about a release can be published by a pull request; releases start as drafts that a
  maintainer reviews and publishes, and publishing is what makes installed apps see them.
- The signing and notarisation paths run for the first time on the first tag with secrets;
  until then CI proves the unsigned and ad-hoc paths, the release configuration and the feed.
- `test/update-feed.test.ts` runs electron-updater's own GitHub provider against a fake GitHub,
  so an upgrade that changes channel, downgrade or staging behaviour fails a unit test. Beta
  checks cost one 404 (`beta*.yml`) before falling back to `latest*.yml`.
- Release smoke tests press "Check for updates" against GitHub, so a bundling mistake in
  electron-updater fails the release instead of the first real update.
- deb and rpm updates need a polkit agent (`pkexec`); without one the notice shows the error and
  users install the new package by hand.
- A dependency with an unreadable licence stops the build until someone reads it; a copyleft one
  must be replaced. The SBOM and the notices are release assets next to `SHA256SUMS.txt`.
- Licence keys stay out of scope until the licensing model, an open question in the spec, is
  decided.
