import { defineConfig } from 'tsup';

/**
 * joinery-cli ships as one ESM file (ADR 0001: internal packages are source-only, so the CLI
 * bundles them). The database drivers stay external runtime dependencies. dt-sql-parser is
 * reached only through `diagnose()`, which the CLI never calls; it stays external so the bundle
 * neither carries nor loads it.
 */
export default defineConfig({
  entry: { joinery: 'src/bin.ts' },
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
  external: ['pg', 'pg-cursor', 'mysql2', /^dt-sql-parser(\/.*)?$/],
  noExternal: [/^@joinery\//, 'commander', 'zod', 'sql-formatter'],
});
