import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

import { buildContentSecurityPolicy } from './src/shared/csp';

const root = import.meta.dirname;

/**
 * Three builds (spec §19): main + connection host (Node, CommonJS), the sandboxed preload (one
 * CommonJS file) and the React renderer. Every dependency is bundled, so the packaged app
 * carries only `out/` and no node_modules (ADR 0004).
 */

/** The React Refresh preamble the dev server inlines into index.html, allowed by hash. */
const devScriptHashes = [
  `sha256-${createHash('sha256').update(react.preambleCode.replace('__BASE__', '/')).digest('base64')}`,
];

/** Writes the CSP meta tag into index.html: the strict policy in builds, plus HMR in dev. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'joinery:csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, context) {
        const address = context.server?.resolvedUrls?.local[0];
        const policy =
          context.server === undefined
            ? buildContentSecurityPolicy()
            : buildContentSecurityPolicy({
                devServerOrigin: address ?? 'http://localhost:5173',
                scriptHashes: devScriptHashes,
              });
        if (!html.includes('%JOINERY_CSP%')) throw new Error('index.html lost its CSP meta tag');
        return html.replace('%JOINERY_CSP%', policy);
      },
    },
  };
}

const nodeOutput = {
  format: 'cjs',
  entryFileNames: '[name].cjs',
  chunkFileNames: 'chunks/[name]-[hash].cjs',
} as const;

export default defineConfig({
  main: {
    define: {
      __JOINERY_DEV_SCRIPT_HASHES__: JSON.stringify(devScriptHashes),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          'connection-host': resolve(root, 'src/connection-host/index.ts'),
        },
        output: nodeOutput,
        // Optional native or platform-specific modules that the bundled drivers never load here;
        // dt-sql-parser only serves editor diagnostics, which run in the renderer.
        external: ['pg-native', 'cloudflare:sockets', 'dt-sql-parser', /^dt-sql-parser\//],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { ...nodeOutput, inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [react(), tailwindcss(), contentSecurityPolicy()],
    build: {
      rollupOptions: {
        input: resolve(root, 'src/renderer/index.html'),
      },
      // Less code to parse at start-up (spec §18: usable window in under 2.5 s).
      minify: 'esbuild',
      chunkSizeWarningLimit: 8_000,
    },
    worker: { format: 'es' },
  },
});
