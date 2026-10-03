# Packaging and releasing

How Querybara's installers are built, signed, updated and audited (spec §18 "Signed builds, a
software bill of materials per release", §20 "Packaging and updates"). The decisions behind it
are in [ADR 0013](adr/0013-packaging-and-updates.md).

## What the Package workflow builds

`.github/workflows/package.yml` runs on pull requests that touch packaging, on `v*` tags and on
manual dispatch. Every job installs what it built and runs the packaged smoke tests
(`apps/desktop/e2e/packaged/*.packaged.ts`: the window loads from `app.asar`, a connection host
starts, a query runs against PostgreSQL where the runner has one, and the About box shows the
version, the update status and the licence report).

| Job           | Runner             | Builds                                                         | Smoke test                                                                              |
| ------------- | ------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `linux`       | `ubuntu-24.04`     | AppImage, deb, rpm for x64 and arm64; the SBOM and notices     | installed x64 deb against a PostgreSQL service; x64 AppImage with updates off by policy |
| `linux-arm64` | `ubuntu-24.04-arm` | (uses `linux`'s packages)                                      | installed arm64 deb against a PostgreSQL service                                        |
| `windows`     | `windows-2025`     | NSIS (one installer for x64 and arm64), MSI and zip, each arch | NSIS install against the image's PostgreSQL; MSI install with the Group Policy switch   |
| `macos`       | `macos-15`         | universal DMG (and zip for signed releases)                    | installed from the DMG, against Homebrew PostgreSQL                                     |
| `release`     | `ubuntu-24.04`     | a draft GitHub release with everything above (tags only)       |                                                                                         |

The Windows arm64 packages are built but not smoke-tested. On the `windows-11-arm` runner the
NSIS installer's silent install finished without putting `querybara.exe` under
`%LOCALAPPDATA%\Programs` (the x64 install of the same installer works), so the job that tested
it was dropped until that is investigated. Treat the arm64 NSIS install as unverified.

In a release whose updates are on (a signed Windows or macOS build, the Linux deb), the smoke
test also presses "Check for updates" and waits for the answer from GitHub, which proves that
electron-updater loads from the archive.

Two configurations:

- `apps/desktop/electron-builder.adhoc.yml`: **test builds** (pull requests, branch runs,
  `pnpm --filter @querybara/desktop package`). Unsigned, ad-hoc signed on macOS, and without an
  update feed, so the app never tries to update itself; its About box says "test build".
- `apps/desktop/electron-builder.yml`: **release builds** (a `v*` tag). It carries the update
  feed (`publish` → GitHub Releases of `vksargsyan/querybara`), which electron-builder writes into
  `resources/app-update.yml`, and the update metadata next to the installers: `latest.yml`
  (Windows), `latest-mac.yml`, `latest-linux.yml` and `latest-linux-arm64.yml`. CI always runs
  electron-builder with `--publish never`; the `release` job uploads.

**Flatpak is not built.** electron-builder's `flatpak` target makes a single-file bundle that no
update channel reaches (electron-updater cannot replace it and there is no Flatpak repository),
defaults to the end-of-life Freedesktop 20.08 runtime, and needs flatpak-builder plus about a
gigabyte of runtime, SDK and Electron base app on the runner for every build. Flatpak users are
better served by a Flathub listing that repackages the released x64 and arm64 builds; ADR 0013
has the outline.

## Cutting a release

1. Set the version in `apps/desktop/package.json`: `1.4.0` for stable, `1.4.0-beta.1` for beta.
2. Tag the commit `v<version>` and push the tag. (A manual run of the workflow with the tag
   selected rebuilds a release; its `rollout` input sets the staged rollout.)
3. The workflow builds, signs where the secrets exist, smoke-tests, then creates a **draft**
   release with the installers, the update metadata, `SHA256SUMS.txt`, the SBOM and the notices.
   It fails if the tag does not match the version. A version with a pre-release part becomes a
   GitHub pre-release.
4. Review the draft (notes, assets) and publish it. Installed apps see it on their next check.

Channels follow GitHub's release types, not file names: electron-builder writes `latest*.yml`
for every version when publishing to GitHub. The **stable** channel follows GitHub's latest
release, which is never a pre-release; the **beta** channel takes the newest release of either
kind (it asks for `beta*.yml` first and falls back to `latest*.yml`). Leaving beta never
downgrades: the app stays on its beta until a newer stable ships.
`apps/desktop/test/update-feed.test.ts` checks these rules against electron-updater itself.

Protect the `v*` tag pattern (Settings → Rules) so that only maintainers can start a release:
the signing secrets are only used in tag runs.

## Signing and notarisation secrets

Each is used only in release runs, only when present, and never printed. Without them the
release is still built: unsigned on Windows (it then refuses to update itself) and ad-hoc
signed on macOS (without an update feed). Pull requests never see them.

**macOS** (Developer ID Application certificate, notarisation through an App Store Connect API
key):

| Secret                       | Contents                                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| `MAC_CERTIFICATE_P12_BASE64` | the Developer ID Application certificate and key, `.p12`, base64  |
| `MAC_CERTIFICATE_PASSWORD`   | the `.p12` password                                               |
| `APPLE_API_KEY_P8`           | the text of the App Store Connect API key (`AuthKey_XXXXXXXX.p8`) |
| `APPLE_API_KEY_ID`           | its key id                                                        |
| `APPLE_API_ISSUER`           | its issuer id                                                     |

`apps/desktop/scripts/set-mac-signing-secrets.sh DeveloperID.p12 AuthKey_XXXXXXXXXX.p8` checks
both files first (a Developer ID Application certificate, not expired, with its private key; an
API key that reads as one; a key id and an issuer id of the right shape), then stores the five
secrets with `gh`, asking for the password and the issuer id rather than taking them as
arguments; `--check` checks without storing. By hand, `base64 -i DeveloperID.p12 | pbcopy` gives
the certificate value. electron-builder imports the
certificate into a temporary keychain, signs with the hardened runtime and
`build/entitlements.mac.plist`, and notarises with notarytool; the job then checks
`stapler validate` and `spctl --assess`. The certificate without the API key is not used: an
app signed but not notarised is refused by Gatekeeper anyway.

**Windows**, either a code-signing certificate:

| Secret                           | Contents                                |
| -------------------------------- | --------------------------------------- |
| `WINDOWS_CERTIFICATE_PFX_BASE64` | the certificate and key, `.pfx`, base64 |
| `WINDOWS_CERTIFICATE_PASSWORD`   | the `.pfx` password                     |

or Azure Trusted Signing (for certificates kept in an HSM):

| Name                              | Kind     | Contents                                                      |
| --------------------------------- | -------- | ------------------------------------------------------------- |
| `AZURE_TENANT_ID`                 | secret   | the service principal's tenant                                |
| `AZURE_CLIENT_ID`                 | secret   | its client id                                                 |
| `AZURE_CLIENT_SECRET`             | secret   | its client secret                                             |
| `AZURE_TRUSTED_SIGNING_ENDPOINT`  | variable | e.g. `https://weu.codesigning.azure.net`                      |
| `AZURE_TRUSTED_SIGNING_ACCOUNT`   | variable | the code signing account name                                 |
| `AZURE_TRUSTED_SIGNING_PROFILE`   | variable | the certificate profile name                                  |
| `AZURE_TRUSTED_SIGNING_PUBLISHER` | variable | the certificate's subject common name (the updater checks it) |

With either, the build sets `forceCodeSigning`, so a signing failure fails the release instead of
shipping unsigned. The publisher name ends up in `app-update.yml`; electron-updater checks each
downloaded installer's Authenticode signature against it.

## Auto-update

`apps/desktop/src/main/updates.ts` runs electron-updater in the main process, in its own session
that may only reach GitHub over https. Updates download in the background; the window then shows
"Querybara x.y.z is ready" with Restart now, Release notes and Later. Help → Check for Updates (the
app menu on macOS) checks at once; the About box (Help → About, or the header's About button)
holds the channel, "Check for updates automatically" and the status. Automatic checks run 30 s
after start-up and every 4 hours. Development runs and the e2e tests (unpackaged) and test
builds (no feed) never check or prompt.

What verifies an update: the SHA-512 of every download, from the release's metadata, on every
platform; on Windows the Authenticode publisher of the installer; on macOS Squirrel.Mac's check
that the new app satisfies the running app's code signature. Linux packages carry no signature
electron-updater could check, so they rely on the metadata's hash over https from GitHub.

The updater stays off, and the About box says why, when: it is a development run; an
administrator's policy turns it off; the build is a test build (no feed); a Windows build has no
code-signing publisher; or the installation is one it cannot replace. It replaces NSIS installs,
macOS app bundles and AppImages (also when the app quits), and deb and rpm installs (only on
"Restart now", because they ask for the administrator password through the desktop's graphical
sudo prompt). MSI installs, the Windows zip and unpacked folders are updated by installing the
new version.

### Staged rollout

A release's update metadata can carry `stagingPercentage`: each install keeps a random id in its
user data directory (`.updaterId`) and takes the update only when the id falls within the
percentage, so the same machines stay in as it grows. Set it when building with the manual
run's `rollout` input or the repository variable `QUERYBARA_ROLLOUT_PERCENT` (default 100, which
omits the field). To change it on a published release:

```sh
tag=v1.4.0
mkdir rollout && cd rollout
gh release download "$tag" -R vksargsyan/querybara -p 'latest*.yml'
pnpm --filter @querybara/desktop rollout 50 "$PWD"                     # 100 = everyone, 0 = halt
gh release upload "$tag" -R vksargsyan/querybara --clobber latest*.yml
```

Setting 0 halts a rollout that went wrong; installs that already updated keep the new version.
`SHA256SUMS.txt` covers the installers only, so it stays valid.

### Managed fleets: the policy switch

Administrators turn updates off (and can pin the channel) machine-wide. Any source turning
updates off wins; a pinned channel greys out the user's choice. Every source can only be written
by an administrator, except the environment variable, which can only turn updates off.

| Platform       | Where                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows        | `HKLM\SOFTWARE\Policies\Querybara`: `DisableUpdates` (REG_DWORD, 1 = off), `UpdateChannel` (REG_SZ, `stable`/`beta`), e.g. from Group Policy or Intune                                       |
| macOS          | a configuration profile for the preference domain `com.querybara.desktop` (`/Library/Managed Preferences/com.querybara.desktop.plist`): `DisableUpdates` (boolean), `UpdateChannel` (string) |
| macOS, Linux   | a JSON file: `/Library/Application Support/Querybara/policy.json`, `/etc/querybara/policy.json`                                                                                              |
| Every platform | the environment variable `QUERYBARA_DISABLE_UPDATES=1` (a system-wide variable for a fleet)                                                                                                  |

Windows has no policy file: standard users may create folders under `%ProgramData%`, so a file
there would let any user switch updates off for everyone on the machine.

The JSON file:

```json
{ "disableUpdates": true, "updateChannel": "stable" }
```

A policy file that exists but cannot be read as a policy turns updates off. MSI deployments are
not updated by the app in any case; the switch also covers NSIS installs and the other
platforms.

```bat
reg add HKLM\SOFTWARE\Policies\Querybara /v DisableUpdates /t REG_DWORD /d 1 /f
```

## SBOM and licence notices

- **Licence report and check**: the renderer build (`scripts/third-party.ts`, a Vite plugin)
  records every npm package whose code ends up in `out/` (main, preload, renderer, workers),
  plus Electron and Tailwind's compiled CSS, and writes `out/renderer/third-party.json` and
  `THIRD_PARTY_NOTICES.txt` with each package's licence and NOTICE texts. The About box's
  "Third-party licences" tab lists them; Chromium's and Node.js's licences ship next to the
  executable (`LICENSES.chromium.html`). **Every build fails** (`electron-vite build`, so CI,
  the e2e tests and packaging) when a shipped package is AGPL, GPL, LGPL or SSPL only, or when
  its licence is unknown: none declared, `UNLICENSED`, or `SEE LICENSE IN <file>`. For an unknown
  one, read the package's licence and record it under `reviewed` in
  `apps/desktop/electron.vite.config.ts` (`'name@version': 'MIT'`).
- **SBOM**: `pnpm --filter @querybara/desktop sbom` (after a build) writes a CycloneDX 1.6 JSON
  bill of materials of the desktop app from `pnpm-lock.yaml`: every package in the app's
  dependency closure with its version, purl, integrity hash, licence and dependency graph.
  Packages the app ships are `required`, build tools `excluded`, first-party workspace packages
  are listed too. `SOURCE_DATE_EPOCH` fixes its timestamp. The `linux` job generates it on every
  run; a release attaches it as `querybara-<version>.cdx.json`, next to the notices.

## Icons

Every icon comes from `apps/desktop/build/icon.svg` (the capybara, ADR 0033):
`pnpm --filter @querybara/desktop icons` renders `icon.ico` (16–256 px), `icons/<n>x<n>.png`
(Linux, and the window icon) and `icon.png`, the artwork free-standing; and for macOS the
artwork on a cream tile: `icon.icns` (macOS 15 and earlier, with Apple's margin) and the Icon
Composer package `icon.icon`, which it compiles into `Assets.car` (macOS 26 and later) when Xcode
26 or later is installed. The outputs are committed, except `Assets.car`: actool needs macOS 26
to compile it, so the workflow's `mac-icon` job compiles it on `macos-26` for the macOS packaging
job, and a local macOS package needs `pnpm --filter @querybara/desktop icons` run on macOS 26 with
Xcode 26 beforehand. A unit test fails when the committed icons no longer match
the SVG.

## Local builds

```sh
pnpm --filter @querybara/desktop package                     # test build for this OS, in apps/desktop/dist
cd apps/desktop && pnpm exec electron-builder --config electron-builder.adhoc.yml --linux AppImage deb rpm --x64
QUERYBARA_PACKAGED_APP=$PWD/dist/linux-unpacked/querybara xvfb-run -a pnpm exec playwright test -c e2e/packaged.config.ts
```

The rpm target needs `rpmbuild` (`apt install rpm`). An AppImage runs without FUSE with
`APPIMAGE_EXTRACT_AND_RUN=1`. A deb can be tried without installing it: `dpkg-deb -x` it into a
folder and point `QUERYBARA_PACKAGED_APP` at `opt/Querybara/querybara` inside.
