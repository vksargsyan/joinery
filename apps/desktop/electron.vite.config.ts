import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

import { thirdPartyNotices } from './scripts/third-party';
import { buildContentSecurityPolicy } from './src/shared/csp';

const root = import.meta.dirname;

/**
 * Three builds (spec §19): main + connection host + job runner (Node, CommonJS), the sandboxed
 * preload (one CommonJS file) and the React renderer. Every dependency is bundled, so the
 * packaged app carries only `out/` and no node_modules (ADR 0004).
 */

/** The React Refresh preamble the dev server inlines into index.html, allowed by hash. */
const devScriptHashes = [
  `sha256-${createHash('sha256').update(react.preambleCode.replace('__BASE__', '/')).digest('base64')}`,
];

/** Writes the CSP meta tag into index.html: the strict policy in builds, plus HMR in dev. */
function contentSecurityPolicy(): Plugin {
  return {
    name: 'querybara:csp',
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
        if (!html.includes('%QUERYBARA_CSP%')) throw new Error('index.html lost its CSP meta tag');
        return html.replace('%QUERYBARA_CSP%', policy);
      },
    },
  };
}

/**
 * Records the npm packages each build ships; the renderer build writes the licence report and
 * fails on a copyleft or unknown licence. The Electron runtime and Tailwind (whose preflight is
 * compiled into the CSS) are not modules of any bundle, so they are named here. `reviewed` holds
 * the licence a person read for a shipped package that declares none (`name@version` → SPDX).
 */
const notices = thirdPartyNotices({
  root,
  productName: 'Querybara',
  extra: [
    { name: 'electron', shippedIn: 'runtime' },
    { name: 'tailwindcss', shippedIn: 'renderer' },
  ],
  reviewed: {},
  // The Kiln code faces: Rec Mono Duotone and Linear, from Arrow Type's Recursive 1.085.
  assets: [
    {
      name: 'Rec Mono (Recursive)',
      version: '1.085',
      licence: 'OFL-1.1',
      homepage: 'https://github.com/arrowtype/recursive',
      licenceFile: 'src/renderer/src/assets/fonts/OFL.txt',
      shippedIn: 'renderer',
    },
  ],
});

/** The MongoDB driver's optional peer dependencies (lib/deps.js), none of which the app ships. */
export const MONGODB_OPTIONAL_PEERS = [
  'kerberos',
  'snappy',
  '@mongodb-js/zstd',
  'gcp-metadata',
  'mongodb-client-encryption',
  '@aws-sdk/credential-providers',
];

const nodeOutput = {
  format: 'cjs',
  entryFileNames: '[name].cjs',
  chunkFileNames: 'chunks/[name]-[hash].cjs',
} as const;

export default defineConfig({
  main: {
    plugins: [notices.collect('main')],
    define: {
      __QUERYBARA_DEV_SCRIPT_HASHES__: JSON.stringify(devScriptHashes),
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, 'src/main/index.ts'),
          'connection-host': resolve(root, 'src/connection-host/index.ts'),
          'job-runner': resolve(root, 'src/job-runner/index.ts'),
        },
        output: nodeOutput,
        // Optional native or platform-specific modules that the bundled drivers never load here;
        // dt-sql-parser only serves editor diagnostics, which run in the renderer. ssh2 tries its
        // optional native helpers (cpu-features, sshcrypto.node) and falls back to plain JS.
        // The MongoDB driver requires its optional peers inside try/catch and reports a missing
        // one when it is needed; bundled instead, Vite stubs them with a module that throws as
        // the driver's chunk loads in a development build (`pnpm dev`).
        external: [
          'pg-native',
          'cloudflare:sockets',
          'dt-sql-parser',
          /^dt-sql-parser\//,
          'cpu-features',
          /\.node$/,
          ...MONGODB_OPTIONAL_PEERS,
        ],
      },
    },
  },
  preload: {
    plugins: [notices.collect('preload')],
    build: {
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        output: { ...nodeOutput, inlineDynamicImports: true },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    plugins: [
      react(),
      tailwindcss(),
      contentSecurityPolicy(),
      notices.collect('renderer'),
      notices.emit(),
    ],
    build: {
      rollupOptions: {
        input: resolve(root, 'src/renderer/index.html'),
      },
      // Less code to parse at start-up (spec §18: usable window in under 2.5 s).
      minify: 'esbuild',
      chunkSizeWarningLimit: 8_000,
    },
    worker: { format: 'es', plugins: () => [notices.collect('renderer')] },
  },
});
