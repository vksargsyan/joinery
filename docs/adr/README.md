# Architecture decision records

One record per major choice (spec §19). Number them in order; never rewrite an accepted record,
supersede it with a new one.

| ADR                                          | Decision                                                     | Status   |
| -------------------------------------------- | ------------------------------------------------------------ | -------- |
| [0001](0001-monorepo-and-source-packages.md) | pnpm + Turborepo monorepo with source-only internal packages | Accepted |
| [0002](0002-local-store-on-node-sqlite.md)   | Local store on `node:sqlite` behind a small driver interface | Accepted |
