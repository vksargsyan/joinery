# 0024. Elasticsearch query builder: a Query DSL model in search-tools, the query bar's second editor

- Status: Accepted
- Date: 2026-09-30

## Context

The documents view (ADR 0017) searched with a query bar: a Query DSL clause or a Lucene query
string, and a sort as JSON. Writing a bool query by hand means remembering where `filter` goes,
that a `term` on a text field rarely matches, that a field inside a `nested` mapping needs a
nested query around it, and how `minimum_should_match` changes a `should` list. Aggregations
could not be run from the view at all: the driver returned them with the first page and the
view dropped them.

The collection view's builder for MongoDB (spec §9) and the SQL query builder (ADR 0014) set
the pattern: a pure model, a writer and a reader, and the builder as a second editor of the
same text, not a second query.

## Decision

_*A pure Query DSL model in `@joinery/search-tools`, built into the query bar's texts and read
back from them; clauses the model does not break down are kept as JSON inside it.*_

- **The model** (`query-builder.ts`), plain data:
  - The query is a bool group with `must`, `filter`, `should` and `must_not` lists and
    `minimum_should_match`. An item is a condition, a group of its own, a nested group (a
    group with a nested field's path, written as a `nested` query around it), or a clause kept
    as its JSON.
  - A condition is a field, an operator and what it takes: match (any word, every word,
    phrase, phrase prefix), query_string (on one field, or on every field for Lucene text),
    term, terms, range (each bound inclusive or not), exists, prefix, wildcard, regexp, fuzzy
    and geo_distance. Operators are offered by the mapped type.
  - The sort is a list of fields with an order and where missing values go, or keys as JSON.
    Aggregations are terms, date and numeric histograms and the usual metrics, each with a name,
    a field and its settings, with sub-aggregations under a bucket aggregation, or an
    aggregation as JSON.
  - Fields come from the index mapping (`dslFields`): the kind of each type, the nested fields
    above it, and a text field's keyword multi-field, which sorting and aggregating use.
- **`buildDsl`** writes the query, sort and aggregations as one-line JSON, or returns what to
  fix per item. Values are typed by the mapping and copied as written, so
  `12345678901234567890` on a long is never rounded; double quotes make a string (`"42"` on a
  number field). A group with a single `must` clause is written as that clause, and an empty
  query as no query. A condition on a field inside a nested mapping, outside a nested group on
  it, builds with a warning, since it matches no document.
- **`readDsl`** reads the texts back. Lucene text becomes a query_string condition; a bool,
  a nested query and each clause the model has are broken down; anything else (a
  function_score, a range with a format, a term with a boost, a filters aggregation) is kept as
  its JSON in place, so every valid query opens in the builder. Only text that is not valid
  JSON is refused, naming the part. Two fast-check properties hold: building what was read from
  built text gives the same text, and one read and build of any query text is stable.

**The builder in the documents view** (`state/search/query-builder.ts`,
`components/search/QueryBuilder.tsx`): the query bar has a Text and a Builder mode. The builder
writes every complete change to the bar's query, sort and aggregation texts, and reads every
change of them from elsewhere, the way the MongoDB builder does. While a change is incomplete,
the bar keeps the last complete query and Search asks for the fix. On the left is the mapping's
field list; on the right, tabs for the query (the four sections, each a drop target), the sort,
the aggregations and the request as a console request (copy, or open in a console). A field is
dragged into a section, the sort or the aggregations, or added from its + menu; clauses are
dragged between sections and groups, or moved from their menu. A field inside a nested mapping
goes into a nested group on it.

**Aggregations run from the documents view.** The query bar gains an aggregations text in Text
mode too. The search sends it; the first page's results show in an Aggregations tab beside the
documents, with the tree and table views the console and SQL editor use.

## Consequences

- The model covers the everyday queries. Scoring functions, scripts, span and geo shape
  queries, and aggregation settings beyond the common ones (ordering, ranges, filters) stay
  JSON inside the builder, editable in place and kept exactly.
- Values are typed by the mapping of the view's target. For an alias or pattern whose indices
  map a field differently, the first index's mapping decides; the server's error shows if a
  value does not fit another.
- When the builder rewrites the text, equivalent forms are normalised: `{"term": {"a":
{"value": 1}}}` becomes `{"term": {"a": 1}}`, and a bool with one `must` becomes that clause.
  The text is rewritten only when the builder changes something.
