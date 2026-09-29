import { createRequire } from 'node:module';

import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// React lint rules for the desktop renderer; the plugin is a dependency of apps/desktop.
const reactHooks = createRequire(new URL('./apps/desktop/package.json', import.meta.url))(
  'eslint-plugin-react-hooks',
);

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.turbo/**', '**/coverage/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Spec §19: domain packages never import Electron, so the CLI and tests can use them directly.
    files: ['packages/**/*.ts', 'packages/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'electron', message: 'Packages must not import Electron (spec §19).' }],
        },
      ],
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.tsx', 'apps/desktop/src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // The sandboxed preload runs in a browser context with a small Node-like `process`.
    files: ['apps/desktop/src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
);
