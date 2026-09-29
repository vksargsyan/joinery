import type { SqlDialect } from '@joinery/core';
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/mysql/register';
import 'monaco-editor/languages/definitions/pgsql/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

/**
 * Monaco, loaded from the app bundle (never a CDN; the CSP allows no remote origin). Only the
 * editor core worker is needed: SQL highlighting is a Monarch tokenizer on the main thread.
 */

globalThis.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme('joinery-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#101216', 'editorGutter.background': '#101216' },
});
monaco.editor.defineTheme('joinery-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: { 'editor.background': '#ffffff' },
});

/** Monaco's SQL language for a dialect. */
export function languageFor(dialect: SqlDialect): string {
  return dialect === 'postgres' ? 'pgsql' : 'mysql';
}

export { monaco };
