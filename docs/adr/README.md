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
