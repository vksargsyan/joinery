# 0005. Autocomplete on Querybara's lexer, not the parser's suggestion API

- Status: Accepted
- Date: 2026-09-29

## Context

Spec §6 asks for context-aware autocomplete in the SQL editor (keywords, schemas, tables, columns
with alias resolution, join conditions from foreign keys, functions with signatures, snippets),
computed in the editor's Web Worker. ADR 0003 chose dt-sql-parser for inline diagnostics and
noted that autocomplete could build on its caret-suggestion API later.

While the user types, the statement at the cursor is almost always incomplete. dt-sql-parser has
known grammar gaps (ADR 0003 masks several), loads 300+ KB of grammar per dialect, and its
suggestion API answers "what kind of token may come next" but not which relations are in scope
or which aliases they carry.

## Decision

`complete()` and `signatureHelp()` in `@querybara/sql-tools` work only on Querybara's own lexer,
splitter and `statementAt`: they classify the cursor position from tokens, build the scope
(FROM/JOIN relations, aliases, CTEs, subquery columns) themselves, and look names up in a
`Catalog` built from schema snapshots (`buildCatalog`). They never load dt-sql-parser; a test
fails if a completion module imports it or the diagnostics module.

## Consequences

- Completion works on unfinished SQL and costs 0.1 to 12 ms on a 10,000-table catalog, with no
  grammar to load before the first suggestion.
- Context rules live in our code: new syntax needs a rule and a test here, not a grammar update.
- dt-sql-parser stays behind `diagnose()` only, so ADR 0003's replacement path is unchanged.
