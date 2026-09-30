# Architecture decision records

One record per major choice (spec §19). Number them in order; never rewrite an accepted record,
supersede it with a new one.

| ADR                                          | Decision                                                         | Status   |
| -------------------------------------------- | ---------------------------------------------------------------- | -------- |
| [0001](0001-monorepo-and-source-packages.md) | pnpm + Turborepo monorepo with source-only internal packages     | Accepted |
| [0002](0002-local-store-on-node-sqlite.md)   | Local store on `node:sqlite` behind a small driver interface     | Accepted |
| [0003](0003-sql-parser.md)                   | dt-sql-parser for inline syntax errors, behind one function      | Accepted |
| [0004](0004-desktop-ports-and-protocol.md)   | Desktop wiring: MessagePorts into the page, app:// scheme        | Accepted |
| [0005](0005-autocomplete-on-the-lexer.md)    | Autocomplete on Joinery's lexer, not the parser's suggestion API | Accepted |
| [0006](0006-job-runner-process.md)           | Long jobs in a job runner process; host keys checked in main     | Accepted |
| [0007](0007-nosql-engine-services.md)        | MongoDB and Redis: engine services beside the Session contract   | Accepted |
| [0008](0008-multi-node-tunnels.md)           | Tunnels reach every node of a replica set, Sentinel or Cluster   | Accepted |
| [0009](0009-sync-in-the-app.md)              | Structure and data sync in the app: runner jobs, results in main | Accepted |
| [0010](0010-search-engines.md)               | Elasticsearch: one driver on our own HTTP client                 | Accepted |
| [0011](0011-server-tools.md)                 | Server tools: neutral vocabulary, statements built in the host   | Accepted |
| [0012](0012-excel-xml-zip-formats.md)        | Excel, XML and ZIP written on node:zlib, without a library       | Accepted |
| [0013](0013-packaging-and-updates.md)        | Packaging, auto-update and licence audit on electron-builder     | Accepted |
| [0014](0014-visual-query-builder.md)         | Query builder: a query model on our lexer, run as a query tab    | Accepted |
| [0015](0015-er-diagram-viewer.md)            | ER diagrams: a model from the cache, one router, model exports   | Accepted |
| [0016](0016-er-model-editing.md)             | ER model editing: an edited snapshot, applied as a compare       | Accepted |
| [0017](0017-search-module.md)                | Search module: documents, SQL, index and cluster administration  | Accepted |
| [0018](0018-saved-er-models.md)              | Saved ER models: drafts in the store, model files as documents   | Accepted |
| [0019](0019-scheduler.md)                    | Scheduler: jobs run from main while Joinery is open              | Accepted |
| [0020](0020-parquet.md)                      | Parquet on hyparquet and hyparquet-writer, streamed by row group | Accepted |
