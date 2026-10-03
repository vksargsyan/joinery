import { defineConfig } from 'tsup';

/**
 * querybara-cli ships as one ESM file (ADR 0001: internal packages are source-only, so the CLI
 * bundles them). The database drivers stay external runtime dependencies (mongodb with the bson
 * package it shares with mongo-tools, so both use one copy), and so do ssh2 (it is
 * CommonJS and optionally loads the native cpu-features and its own crypto binding) and socks.
 * dt-sql-parser is reached only through `diagnose()`, which the CLI never calls; it stays
 * external so the bundle neither carries nor loads it.
 */
export default defineConfig({
  entry: { querybara: 'src/bin.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  // node:sqlite exists only under the node: prefix.
  removeNodeProtocol: false,
  external: [
    'pg',
    'pg-cursor',
    'mysql2',
    'ssh2',
    'socks',
    'mongodb',
    'bson',
    'ioredis',
    /^dt-sql-parser(\/.*)?$/,
  ],
  noExternal: [/^@querybara\//, 'commander', 'zod', 'sql-formatter'],
});
