# 0017. Elasticsearch and OpenSearch: documents, queries and administration

- Status: Accepted
- Date: 2026-09-30

## Context

ADR 0010 gave the search engines a driver, a console and an explorer. Spec §11 asks for the
rest of the module: a document grid that pages past 10,000 hits and edits documents safely,
bulk actions, SQL (with "Translate to DSL") and ES|QL, aggregation results as a tree and a
table, index operations (open, close, refresh, flush, force merge, clone, shrink, delete),
index creation, a mapping editor that knows existing field mappings cannot change, reindex with
live progress, cluster health, nodes, shard allocation and disk watermarks, aliases, index and
component templates, ILM or ISM policies, ingest pipelines with a simulate panel, and
snapshots. The same code has to serve Elasticsearch 7.17 to 9.x and OpenSearch 2.x and 3.x,
which differ in SQL (an API or a plugin), lifecycle (ILM or ISM), point in time and cloning.

## Decision

**Services grow on the session, grouped; wire types and reply readers stay pure.**
`SearchSession` gains SQL (`sql`, a paged async iterable closing the server's cursor when the
reader stops; `translateSql`; `esql`), index administration (`resizeIndex`, `startReindex`),
tasks (`getTask`, `listTasks`, `cancelTask`), allocation (`shards`, `allocationExplain`,
`diskAllocation`), named resources (`listResources`, `putResource`, `deleteResource`),
`simulatePipeline` and snapshots. Every reply is read by `@joinery/search-tools`
(`parseTableReply`, `parseTaskReply`, `parseAllocationExplain`, `parseDiskAllocation`,
`parseResources`, `parseSnapshots`, `parseSimulation`), so the tests feed them recorded
replies and the renderer can use them too. The connection host contract adds matching
namespaces (`sql`, `esql`, `indexAdmin`, `tasks`, `allocation`, `resources`, `pipelines`,
`snapshots`) beside the existing ones, additively.

**One "named resource" service instead of one per kind.** Index, component and legacy
templates, lifecycle policies, ingest pipelines and snapshot repositories are all JSON objects
under a name with list, PUT and DELETE. `SearchResourceKind` picks the path (`resourcePath`:
ILM's `/_ilm/policy` or ISM's `/_plugins/_ism/policies` by the `lifecycle` flag); the list
returns each resource's body as the JSON its PUT takes, read-only members removed, so the
editor saves what it shows. ISM updates carry `if_seq_no`/`if_primary_term`, which ISM
requires.

**Features follow capability flags.** SQL is offered where `sql` is set (the SQL API or the
OpenSearch plugin), ES|QL where `esql` is, the lifecycle tab as ILM or ISM, composable
templates from `composableTemplates`, cloning from a new `cloneIndex` flag; deep paging uses a
point in time where `pointInTime` is set and a scroll otherwise. No panel reads a version
string.

**Documents stay text end to end.** The grid flattens each `_source` into dotted columns with
`flattenSource`, whose cells are the server's token text, so `12345678901234567890` and `1.10`
show and save unchanged; arrays stay one cell, as the engines treat them as multi-valued. Mapped
fields come first, so empty columns show too. Pages come from the driver's stream (a point in
time with search_after, or a scroll), pulled as the grid scrolls; the grid never asks for
from/size. An edit writes over the version it read (`if_seq_no`/`if_primary_term`); a conflict
brings the stored version (the driver's CONFLICT detail) and offers reload or, after a
confirmation, overwrite. Bulk deletes and "set field" go through `_bulk` with each action at
the version read, and the per-item outcome is shown.

**Mapping changes are planned, not attempted.** `planMappingChange` compares the proposed
mapping with the current one: added fields and multi-fields and a short list of updatable
parameters apply in place with `PUT /<index>/_mapping`; a changed type or other parameter, or a
field left out, needs a new index. `reindexPlan` then builds the steps (create the index with
the copyable settings of the old one and the new mapping, `_reindex` with
`wait_for_completion=false`, refresh, move the aliases in one `_aliases` call, or delete the old
index and give its name to the new one as an alias), shows them as console text, and runs them
with one confirmation. The reindex is a server task followed through the Tasks API with
cancel; a failed or cancelled copy stops before the aliases move.

**Blocking operations count as destructive.** The classifier now marks index blocks (the
`_block` API, or settings that turn a block on), `remove_index` alias actions, snapshot
repository cleanup and snapshot and repository deletes; the host classifies alias updates, SQL
statements (OpenSearch's plugin runs DELETE), resource deletes and restores the same way, and a
resize that blocks its source's writes needs `confirmed` on every profile. Reads (searches, SQL
SELECT, ES|QL, allocation explanations, pipeline simulations) always run, also on read-only
profiles.

**Snapshots use whatever repository the cluster allows.** The panel registers `fs` (under
`path.repo`) or read-only `url` repositories and lists, creates, restores (with a rename
pattern and a preview of the new names) and deletes snapshots; the integration and end-to-end
tests skip snapshots when the server has no `path.repo`.

## Consequences

- Each panel is a class over a `SearchView` base (its own session, the write rules, the
  cluster's flags, a notice line), and its flows are tested against a fake host; the pure
  planners and readers are tested with recorded replies.
- The named-resource service keeps the contract small, at the price of one generic editor for
  templates, policies and pipelines rather than a form per kind.
- OpenSearch's SQL explain has no stable DSL shape across engines (legacy, new, Calcite):
  "Translate to DSL" shows the DSL when it can find it and the plan otherwise.
- The disk watermarks are read in the settings' nested form, which includes the node's own
  `elasticsearch.yml`; headroom caps (8.5+) are shown beside the percentages.
