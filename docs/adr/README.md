# Architecture decision records

One record per major choice (spec §19). Number them in order; never rewrite an accepted record,
supersede it with a new one.

| ADR                                              | Decision                                                             | Status                     |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------------------- |
| [0001](0001-monorepo-and-source-packages.md)     | pnpm + Turborepo monorepo with source-only internal packages         | Accepted                   |
| [0002](0002-local-store-on-node-sqlite.md)       | Local store on `node:sqlite` behind a small driver interface         | Accepted                   |
| [0003](0003-sql-parser.md)                       | dt-sql-parser for inline syntax errors, behind one function          | Accepted                   |
| [0004](0004-desktop-ports-and-protocol.md)       | Desktop wiring: MessagePorts into the page, app:// scheme            | Accepted                   |
| [0005](0005-autocomplete-on-the-lexer.md)        | Autocomplete on Querybara's lexer, not the parser's suggestion API   | Accepted                   |
| [0006](0006-job-runner-process.md)               | Long jobs in a job runner process; host keys checked in main         | Accepted                   |
| [0007](0007-nosql-engine-services.md)            | MongoDB and Redis: engine services beside the Session contract       | Accepted                   |
| [0008](0008-multi-node-tunnels.md)               | Tunnels reach every node of a replica set, Sentinel or Cluster       | Accepted                   |
| [0009](0009-sync-in-the-app.md)                  | Structure and data sync in the app: runner jobs, results in main     | Accepted                   |
| [0010](0010-search-engines.md)                   | Elasticsearch: one driver on our own HTTP client                     | Accepted                   |
| [0011](0011-server-tools.md)                     | Server tools: neutral vocabulary, statements built in the host       | Accepted                   |
| [0012](0012-excel-xml-zip-formats.md)            | Excel, XML and ZIP written on node:zlib, without a library           | Accepted                   |
| [0013](0013-packaging-and-updates.md)            | Packaging, auto-update and licence audit on electron-builder         | Accepted                   |
| [0014](0014-visual-query-builder.md)             | Query builder: a query model on our lexer, run as a query tab        | Accepted                   |
| [0015](0015-er-diagram-viewer.md)                | ER diagrams: a model from the cache, one router, model exports       | Accepted                   |
| [0016](0016-er-model-editing.md)                 | ER model editing: an edited snapshot, applied as a compare           | Accepted                   |
| [0017](0017-search-module.md)                    | Search module: documents, SQL, index and cluster administration      | Accepted                   |
| [0018](0018-saved-er-models.md)                  | Saved ER models: drafts in the store, model files as documents       | Accepted                   |
| [0019](0019-scheduler.md)                        | Scheduler: jobs run from main while Querybara is open                | Accepted                   |
| [0020](0020-parquet.md)                          | Parquet on hyparquet and hyparquet-writer, streamed by row group     | Accepted                   |
| [0021](0021-confirm-closing-with-schedules.md)   | Closing with schedules on asks first, instead of a tray              | Accepted                   |
| [0022](0022-rdb-dump-analysis.md)                | Redis dump analysis: a streaming RDB reader in the job runner        | Accepted                   |
| [0023](0023-redis-search-indexes.md)             | Redis search indexes: FT.* services read by redis-tools              | Accepted                   |
| [0024](0024-elasticsearch-query-builder.md)      | Elasticsearch query builder: a Query DSL model, read back from text  | Accepted                   |
| [0025](0025-kiln-design-system.md)               | The Kiln design system: tokens, controls, editor and grid themes     | Accepted                   |
| [0026](0026-window-chrome-and-engine-icons.md)   | The window's chrome as VS Code draws it; an icon per database engine | Accepted                   |
| [0027](0027-connection-sidebar-interactions.md)  | The connection side bar as Navicat's: double-click, search, filter   | Accepted                   |
| [0028](0028-connection-dialog-steps-and-tabs.md) | The connection dialog in two steps and tabs; TLS off by default      | Accepted                   |
| [0029](0029-objects-view.md)                     | The Objects view as Navicat's; a click on a table opens it           | Accepted                   |
| [0030](0030-table-pages-and-pointer-menus.md)    | Table data in pages as Navicat's; menus open at the pointer          | Accepted                   |
| [0031](0031-command-palette-and-keybindings.md)  | A command palette, Go to Object and key bindings as VS Code's        | Accepted                   |
| [0032](0032-app-icon.md)                         | The app icon: a joined cylinder; Icon Composer for macOS 26          | Superseded in part by 0033 |
| [0033](0033-querybara-name-and-icon.md)          | The name Querybara, and a capybara icon on a cream tile              | Accepted                   |
