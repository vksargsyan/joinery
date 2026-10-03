# 0003. dt-sql-parser for inline syntax errors, behind one function

- Status: Accepted
- Date: 2026-09-29

## Context

The spec (§6) asks for inline syntax errors from the dialect parser, "dt-sql-parser or
node-sql-parser, chosen in the phase 0 spike", running in the editor's language Web Worker.
Later work wants autocomplete from the same parser. We need MySQL, MariaDB and PostgreSQL.

The spike installed both with plain npm outside the workspace and ran them over a corpus of
everyday statements (valid: 50 MySQL, 55 MariaDB, 51 PostgreSQL, from CTEs, window functions,
JSON operators and upserts to routines, dollar quoting, COPY, MERGE and session commands) and
20 broken statements with a known error position. Node.js 22, one run on the dev container.

|                                                   | dt-sql-parser 4.5.1                                                               | node-sql-parser 5.4.0                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Licence                                           | MIT                                                                               | Apache-2.0                                                                  |
| Maintenance                                       | DTStack; 4.5.1 on 2026-08-25, monthly betas                                       | last release 2026-01-12                                                     |
| Technology                                        | ANTLR4 (antlr4ng) + antlr4-c3                                                     | PEG.js                                                                      |
| Dialects                                          | MySQL, PostgreSQL (no MariaDB)                                                    | MySQL, MariaDB, PostgreSQL                                                  |
| Installed size                                    | 20 MB + antlr4ng 1.2 MB + antlr4-c3 0.1 MB                                        | 89 MB (all dialects, UMD, maps)                                             |
| Worker bundle, minified (gzip)                    | MySQL 2.05 MB (359 KB), PostgreSQL 1.93 MB (309 KB)                               | all three 0.87 MB (189 KB)                                                  |
| Web Worker                                        | yes: bundles for the browser with no Node built-ins                               | yes                                                                         |
| False positives, MySQL                            | 1 / 50 (`?` placeholder)                                                          | 10 / 50                                                                     |
| False positives, MariaDB                          | 7 / 55 (placeholder, 6 MariaDB-only features)                                     | 14 / 55                                                                     |
| False positives, PostgreSQL                       | 1 / 51 (`U&'...'`)                                                                | 21 / 51 (MERGE, DELETE USING, DO, COPY, SAVEPOINT, EXPLAIN (...), ILIKE...) |
| Broken statements detected                        | 20 / 20                                                                           | 20 / 20                                                                     |
| Of 20 errors: at the exact token / within 5 chars | 16 / 19                                                                           | 13 / 17                                                                     |
| Messages                                          | `'FORM' is not valid at this position, expecting an existing column or a keyword` | `Expected "#", "--", "/*", "UPDATE", or [ \t\n\r] but "M" found.`           |
| Autocomplete                                      | caret suggestions (keywords, table/column/function contexts), entity collection   | none (AST, table and column lists)                                          |
| Parse, 93 KB INSERT (cold / warm)                 | MySQL 162 / 81 ms, PostgreSQL 325 / 96 ms                                         | 180 / 131 ms, 215 / 167 ms                                                  |
| Parse, 16 KB SELECT, 400 columns, 30 joins        | MySQL 281 / 32 ms, PostgreSQL 641 / 52 ms                                         | 34 / 31 ms, 48 / 48 ms                                                      |
| Small statements                                  | ~1.2 ms each (MySQL)                                                              | similar                                                                     |

Probing dt-sql-parser further found more grammar gaps: MySQL `MATCH ... AGAINST`,
`FOR UPDATE NOWAIT`, `CAST(x AS DOUBLE)`; PostgreSQL `= ANY (...)` / `ALL` / `SOME`,
`IS [NOT] TRUE|FALSE|UNKNOWN`, and `E'...'` followed by more tokens. Its package ships ESM
with extensionless directory imports and no `"type": "module"`, so plain Node.js cannot import
it; Vite, esbuild and Vitest can. Under Vitest, loading one grammar takes about 2.5 s.

## Decision

Use **dt-sql-parser** for diagnostics, behind a single function in `@querybara/sql-tools`:
`diagnose(text, dialect): Promise<SqlDiagnostic[]>` (message, start/end offsets). Nothing
else in the codebase imports the parser.

- The script is split with Querybara's own splitter (DELIMITER, dollar quotes, BEGIN ATOMIC)
  and each statement is parsed on its own; only its first error is reported.
- The grammar for the dialect is loaded lazily with a dynamic import of its own entry point
  (`dt-sql-parser/dist/parser/mysql` or `.../postgresql`), then warmed with one parse.
- Known grammar gaps are masked before parsing with same-length rewrites, so offsets map back
  1:1: placeholders become `0`, `U&` prefixes and `E'...'` contents are blanked,
  `IS [NOT] TRUE` becomes `IS [NOT] NULL`, `op ANY (` becomes `IN (`, `MATCH ... AGAINST (...)`
  becomes `0`, `NOWAIT` is blanked, `AS DOUBLE|FLOAT|REAL` becomes `AS CHAR`.
- MariaDB uses the MySQL grammar. Statements using MariaDB-only syntax (sequences,
  RETURNING, system versioning, `IF [NOT] EXISTS` clauses, `CREATE OR REPLACE` other than
  views, `ANALYZE <statement>`, `VALUES` statements, WAIT/NOWAIT, packages...) get no
  diagnostics rather than false errors.
- Statements over 200,000 characters (bulk INSERT dumps) are not parsed.

With these in place the corpus gives no false positives for PostgreSQL (0 / 55); MySQL and
MariaDB flag only a procedure written without DELIMITER (1 / 54, 1 / 55), which the mysql
client would also split and reject.

## Consequences

- The language worker carries about 310-360 KB gzip per grammar, loaded on first use.
  Packages that import `@querybara/sql-tools` but never call `diagnose` (connection host, CLI)
  never load the parser, which also sidesteps its Node.js import problem.
- The first parse in a worker costs 0.2-0.6 s; the warm-up parse moves it to load time.
- The adapter calls dt-sql-parser's internal `parseWithCache` to skip `validate()`'s fallback,
  which re-splits input on every `;` and reports bogus errors for routine bodies; it falls back
  to `validate()` if the internal disappears. ANTLR's console listener is silenced while
  parsing. Both are pinned down by the diagnostics tests; re-run them on every upgrade.
- New grammar gaps are handled by adding a masking rule plus a test, or reported upstream.
- Autocomplete can build on dt-sql-parser's suggestion and entity APIs later.
- Replacing the parser means rewriting `packages/sql-tools/src/diagnostics.ts` only.
