# 0001. pnpm + Turborepo monorepo with source-only internal packages

- Status: Accepted
- Date: 2026-09-29

## Context

The spec (§19) lays out a pnpm workspace with Turborepo: `apps/desktop`, `apps/cli`,
`apps/cloud` and domain packages under `packages/`. Domain packages must run unchanged in the
Electron utility processes, in querybara-cli and in tests, and must never import Electron.

## Decision

- Internal packages (`@querybara/*`) are **source-only**: `exports` points at `src/index.ts`. They
  are compiled by whoever consumes them — Vite/electron-vite for the desktop app, the CLI's
  bundler, and Vitest in tests. There is no per-package build step or `dist/` to keep in sync.
- TypeScript runs in `noEmit` mode per package (`pnpm typecheck`), with one strict base config
  (`tsconfig.base.json`, including `noUncheckedIndexedAccess`).
- Shared dependency versions live in the pnpm catalog in `pnpm-workspace.yaml`.
- One flat ESLint config at the root. It forbids `any`, and forbids importing `electron`
  anywhere under `packages/`.
- Per-engine drivers live under `packages/drivers/<engine>`, with the shared SQL base adapter in
  `packages/drivers/sql-base`.

## Consequences

- Imports are extensionless and resolved with `moduleResolution: "Bundler"`; Node cannot run
  the packages directly without a bundler or a TS loader. The CLI therefore ships as a bundle.
- Turborepo caches `typecheck` and `test` per package; `test:integration` is never cached.
