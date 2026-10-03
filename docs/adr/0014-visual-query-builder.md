# 0014. Visual query builder: a query model on Querybara's lexer, run through the query tab path

- Status: Accepted
- Date: 2026-09-30

## Context

Spec §8 asks for a visual query builder for MySQL, MariaDB and PostgreSQL: tables dragged onto a
canvas, joins drawn from foreign keys and editable (inner, left, right, full), columns,
criteria, grouping, HAVING, sort and limit in side panels, and two-way sync with SQL: "the
builder writes SQL, and SQL it can parse opens back in the builder. Unsupported constructs open
read-only with a note." The three visual tools share one canvas stack, React Flow with elkjs
auto-layout, and the per-connection metadata cache (§5).

Two-way sync needs a parser that reads what the generator writes, for every dialect, and says
precisely what it cannot read. ADR 0003 put dt-sql-parser behind `diagnose()` only; ADR 0005
built autocomplete on Querybara's own lexer instead of the parser's APIs. Both parsers were
measured there: dt-sql-parser has no MariaDB grammar and grammar gaps masked by rewrites, costs
300+ KB of grammar per dialect and 0.2-0.6 s to warm up, and gives a parse tree of the whole
language that we would have to walk and reject most of; node-sql-parser rejected 10-21 of ~50
everyday statements per dialect.

## Decision

**A pure query model in `@querybara/sql-tools`** (`src/query-model/`): plain, JSON-safe data
(`QueryModel`: tables with aliases; joins between two tables with a type and column
comparisons ANDed; the select list of columns, `t.*`, aggregates and expressions with aliases;
WHERE and HAVING as trees of AND/OR groups, optionally negated, of typed conditions (=, <>, <,
<=, >, >=, [NOT] LIKE, [NOT] ILIKE on PostgreSQL, [NOT] IN, [NOT] BETWEEN, IS [NOT] NULL) or
conditions written as SQL; GROUP BY; ORDER BY with NULLS FIRST/LAST on PostgreSQL; LIMIT and
OFFSET; DISTINCT).

- `generateQuery(model, dialect)` writes formatted SQL and returns issues instead of throwing.
  Every name goes through `quoteIdent`/`quoteQualified`, every string through `quoteString`;
  numbers and placeholders (`:name`, `$1`, `?` on MySQL/MariaDB) are written only after a check
  and are quoted as strings otherwise. Hand-written expressions and conditions are the user's
  SQL: `checkFragment` requires one complete expression (no `;`, no comments, balanced brackets,
  no comma outside brackets, no subquery or window), and they are wrapped in parentheses unless
  simple, so they cannot change the structure around them. Incomplete conditions and joins are
  left out with an error; FULL JOIN, ILIKE and NULLS FIRST on MySQL/MariaDB are written and
  flagged as errors.
- Tables are written in model order; each is joined to the tables before it by every join that
  reaches it (a LEFT join whose other table comes later becomes RIGHT, conditions are written
  earlier table first), or CROSS JOINed when none does. That canonical form is what the parser
  produces, so `generate(parse(generate(m))) === generate(m)` for every model; fast-check
  checks it for random models in all three dialects (names with quotes and backticks, strings
  with backslashes and NUL-free Unicode, nested and negated groups, every operator and join
  type).
- `parseQuery(sql, dialect, { columnsOf })` is a recursive-descent reader over `significantTokens`
  from Querybara's lexer (ADR 0005's approach, no new dependency). It returns `ok` with a model,
  `invalid` (unfinished or broken SQL, with its offsets), or `unsupported` naming the construct:
  another statement or several, WITH, UNION / INTERSECT / EXCEPT, subqueries, window functions,
  DISTINCT ON, ROLLUP / CUBE / GROUPING SETS, locking clauses, SELECT INTO, USING and NATURAL
  joins, LATERAL, functions and parentheses in FROM, three-part names, index hints, FETCH
  FIRST, join conditions other than column comparisons, FULL JOIN on MySQL/MariaDB. Expressions
  it does not break down (functions, arithmetic, CASE) stay as written in raw expressions, and
  predicates it does not model (a boolean column, IS DISTINCT FROM, `= ANY (...)`, LIKE ...
  ESCAPE) become conditions written as SQL, so ordinary queries still open in the builder.
  PostgreSQL folds unquoted names to lower case; reserved words and parameterless functions
  (CURRENT_DATE, USER on PostgreSQL) never become columns. With `columnsOf` (the metadata
  cache) an unqualified column attaches to the one table that has it; ORDER BY names a select
  alias first.

**The builder in the desktop app** (`state/query-builder/`, `components/query-builder/`): a
`QueryBuilder` view model per panel holds the model, canvas positions, the SQL pane's text and
whether they agree. A builder edit regenerates the SQL; an edit of the SQL is parsed back after
a short pause, and the model follows (tables matched by schema, name and alias keep their ids
and places) or the builder turns read-only with the note naming the construct, keeping its last
model and a way back. The catalog is one database's snapshot from the metadata cache
(`loadSnapshot`), reloaded when the structure changes; adding a table proposes INNER joins from
foreign keys in both directions. The canvas is `@xyflow/react` 12 (a box per table with a tick
box and handles per column, an edge per join; dragging from a column to a column joins them)
with `elkjs` 0.12's layered layout, loaded on the first auto-layout (it would add 1.4 MB to the
start-up bundle); everything the canvas does is also a labelled control in the side panels.

**Run goes through the query tab path.** Each builder panel owns a query tab of the same id that
is never shown as an editor; its editor handle reads the builder's SQL. Run is `runQuery`:
the safety checks and write confirmations, parameters, streaming into the result grid with
Fetch more, cancel, history, and the tab's own session, now opened on the builder's database
(`QueryTab.database`, passed to `openSession`). The results are the query tab's `Results`. The
SQL pane is bound to that tab, so autocomplete works there too.

## Consequences

- No parser dependency and no grammar to load: parsing a builder-sized query takes well under
  a millisecond on every keystroke pause, and the rules for what the builder shows live in one
  file with a test per construct.
- The builder shows a subset of SELECT by design; everything else still runs from the builder
  and opens in the editor. Widening the subset (subqueries as raw FROM items, USING joins) means
  a model change plus parser and generator rules, kept honest by the round-trip property.
- SQL typed by hand is kept as typed until the builder changes the query; then the builder's
  canonical SQL replaces it (comments and formatting are not preserved).
- MySQL/MariaDB tables are qualified with their database, so the SQL also runs from a SQL tab
  on another default database; PostgreSQL ones with their schema.
- elkjs is EPL-2.0 (dual-licensed with GPL-3.0-or-later; we use it under EPL-2.0) and runs in
  the page without a worker, which the CSP allows (no eval).
- `QueryTab.database` also lets "Open in editor" open a SQL tab on the builder's database.
