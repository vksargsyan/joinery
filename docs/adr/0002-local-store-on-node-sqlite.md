# 0002. Local store on `node:sqlite` behind a small driver interface

- Status: Accepted
- Date: 2026-09-29

## Context

The spec (§19) names better-sqlite3 for the local store: fast, embedded and synchronous. The
store is opened by the Electron main process and by joinery-cli (headless jobs), and its tests
run under plain Node.js in Vitest.

better-sqlite3 is a native module. Its binary is built for one ABI at a time, so the same
`node_modules` cannot serve Electron's main process and Node.js tests without rebuilding
between them, and every release target needs a prebuilt binary (spec §20).

Node.js ships `node:sqlite` (`DatabaseSync`), also embedded and synchronous, with a
near-identical `prepare / run / get / all / exec` API. Electron's bundled Node.js includes it.

## Decision

`@joinery/storage` talks to SQLite through a small `SqliteDatabase` interface, implemented on
`node:sqlite`. Nothing outside the storage package touches the SQLite API.

## Consequences

- No native module in the app for the local store: no ABI rebuilds, no per-target prebuilds.
- `node:sqlite` still prints an ExperimentalWarning on Node.js 22; the API has been stable in
  practice since 22.13. Revisit if it changes incompatibly.
- Switching to better-sqlite3 later means one new implementation of `SqliteDatabase`.
