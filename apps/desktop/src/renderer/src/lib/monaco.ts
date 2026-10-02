import type { SqlDialect } from '@joinery/core';
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
import 'monaco-editor/languages/definitions/mysql/register';
import 'monaco-editor/languages/definitions/pgsql/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

import { BISQUE, CODE_FONT, TENMOKU, withAlpha, type KilnPalette } from './kiln';

/**
 * Monaco, loaded from the app bundle (never a CDN; the CSP allows no remote origin). Only the
 * editor core worker is needed: SQL highlighting is a Monarch tokenizer on the main thread.
 */

globalThis.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

/**
 * The Kiln themes (Tenmoku, Bisque): the editor chrome from the Workbench map and the token
 * colours from the Syntax map. Structure is rust (keywords), calls are cobalt (built-in
 * functions), literals celadon (strings) and lilac (numbers, true/false/null), inputs peach
 * (object keys, query parameters), machinery teal (regex, escapes), comments in the cursive
 * italic, operators and punctuation `punct`, identifiers `fg`.
 */
function kilnTheme(p: KilnPalette, base: 'vs' | 'vs-dark'): monaco.editor.IStandaloneThemeData {
  const hex = (colour: string): string => colour.replace('#', '');
  const selection = base === 'vs-dark' ? 0.26 : 0.24;
  return {
    base,
    inherit: true,
    rules: [
      { token: '', foreground: hex(p.fg) },
      { token: 'comment', foreground: hex(p.comment), fontStyle: 'italic' },
      { token: 'keyword', foreground: hex(p.rust) },
      { token: 'operator', foreground: hex(p.punct) },
      { token: 'delimiter', foreground: hex(p.punct) },
      { token: 'string', foreground: hex(p.celadon) },
      { token: 'string.escape', foreground: hex(p.teal) },
      { token: 'string.link', foreground: hex(p.cobalt) },
      { token: 'regexp', foreground: hex(p.teal) },
      { token: 'number', foreground: hex(p.lilac) },
      { token: 'predefined', foreground: hex(p.cobalt) },
      { token: 'type', foreground: hex(p.peach) },
      { token: 'type.identifier', foreground: hex(p.ochre) },
      { token: 'variable', foreground: hex(p.peach) },
      { token: 'identifier', foreground: hex(p.fg) },
      { token: 'invalid', foreground: hex(p.red), fontStyle: 'underline' },
      // The base themes colour these by language; the more specific name wins, so repeat them.
      { token: 'keyword.sql', foreground: hex(p.rust) },
      { token: 'operator.sql', foreground: hex(p.punct) },
      { token: 'string.sql', foreground: hex(p.celadon) },
      { token: 'predefined.sql', foreground: hex(p.cobalt) },
      { token: 'number.sql', foreground: hex(p.lilac) },
      { token: 'comment.sql', foreground: hex(p.comment), fontStyle: 'italic' },
      { token: 'identifier.sql', foreground: hex(p.fg) },
      { token: 'delimiter.sql', foreground: hex(p.punct) },
      { token: 'string.key.json', foreground: hex(p.peach) },
      { token: 'string.value.json', foreground: hex(p.celadon) },
      { token: 'number.json', foreground: hex(p.lilac) },
      { token: 'keyword.json', foreground: hex(p.lilac) },
      { token: 'delimiter.bracket.json', foreground: hex(p.punct) },
    ],
    colors: {
      focusBorder: p.focusBorder,
      'editor.background': p.bg,
      'editor.foreground': p.fg,
      'editorGutter.background': p.bg,
      'editorLineNumber.foreground': p.faint,
      'editorLineNumber.activeForeground': p.rust,
      'editorCursor.foreground': p.rust,
      'editor.lineHighlightBackground': p.lineHighlight,
      'editor.lineHighlightBorder': '#00000000',
      'editor.selectionBackground': withAlpha(p.rust, selection),
      'editor.inactiveSelectionBackground': withAlpha(p.rust, 0.12),
      'editor.selectionHighlightBackground': withAlpha(p.cobalt, 0.14),
      'editor.selectionHighlightBorder': withAlpha(p.cobalt, 0.3),
      'editor.wordHighlightBackground': withAlpha(p.cobalt, 0.12),
      'editor.findMatchBackground': p.findMatch,
      'editor.findMatchBorder': p.ochre,
      'editor.findMatchHighlightBackground': withAlpha(p.ochre, 0.18),
      'editorBracketMatch.background': withAlpha(p.rust, 0.14),
      'editorBracketMatch.border': withAlpha(p.rust, 0.55),
      'editorIndentGuide.background1': p.border,
      'editorIndentGuide.activeBackground1': p.borderStrong,
      'editorWhitespace.foreground': withAlpha(p.faint, 0.45),
      'editorError.foreground': p.red,
      'editorWarning.foreground': p.ochre,
      'editorInfo.foreground': p.cobalt,
      'editorOverviewRuler.border': p.border,
      'editorWidget.background': p.bgRaised,
      'editorWidget.border': p.border,
      'editorHoverWidget.background': p.bgRaised,
      'editorHoverWidget.border': p.border,
      'editorSuggestWidget.background': p.bgRaised,
      'editorSuggestWidget.border': p.border,
      'editorSuggestWidget.foreground': p.fg,
      'editorSuggestWidget.selectedBackground': p.listActive,
      'editorSuggestWidget.highlightForeground': p.rust,
      'editorSuggestWidget.focusHighlightForeground': p.rust,
      'widget.shadow': p.shadowWidget,
      'input.background': p.bgDeep,
      'input.border': p.border,
      'list.hoverBackground': p.listHover,
      'list.activeSelectionBackground': p.listActive,
      'list.activeSelectionForeground': p.fg,
      'list.highlightForeground': p.rust,
      'scrollbarSlider.background': p.scrollbar,
      'scrollbarSlider.hoverBackground': p.scrollbarHover,
      'scrollbarSlider.activeBackground': p.scrollbarActive,
    },
  };
}

monaco.editor.defineTheme('joinery-dark', kilnTheme(TENMOKU, 'vs-dark'));
monaco.editor.defineTheme('joinery-light', kilnTheme(BISQUE, 'vs'));

/**
 * Kiln's code setting for every editor: Rec Mono Duotone (the cursive italic marks comments)
 * at a 1.65 line height with 0.2px tracking, a 2px rust cursor that fades and glides.
 */
export const EDITOR_FONT: monaco.editor.IEditorOptions = {
  fontFamily: CODE_FONT,
  lineHeight: 1.65,
  letterSpacing: 0.2,
  fontLigatures: false,
  cursorWidth: 2,
  cursorBlinking: 'phase',
  cursorSmoothCaretAnimation: 'on',
};

/**
 * An editor whose overflowing widgets (suggestions, hovers, parameter hints) render in a layer
 * of their own on the document body. Monaco places them `position: fixed` at window coordinates,
 * but a dock panel lives in dockview's render overlay, whose paint containment and GPU transform
 * make it the containing block for fixed descendants: the list landed offset by the panel's
 * position from the window's corner, and was clipped to the panel. An editor in a dialog keeps
 * Monaco's own layer, so a click on a suggestion stays inside the dialog and does not dismiss it.
 */
export function createEditor(
  element: HTMLElement,
  options: monaco.editor.IStandaloneEditorConstructionOptions,
): monaco.editor.IStandaloneCodeEditor {
  if (element.closest('[role="dialog"], [role="alertdialog"]')) {
    return monaco.editor.create(element, { ...options, fixedOverflowWidgets: true });
  }
  const layer = document.createElement('div');
  // `monaco-editor` scopes the widgets' styles and the theme's colour variables.
  layer.className = 'monaco-editor joinery-editor-overflow';
  document.body.append(layer);
  const editor = monaco.editor.create(element, {
    ...options,
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode: layer,
  });
  editor.onDidDispose(() => layer.remove());
  return editor;
}

/** Monaco's SQL language for a dialect. */
export function languageFor(dialect: SqlDialect): string {
  return dialect === 'postgres' ? 'pgsql' : 'mysql';
}

export { monaco };
