import type { SqlDialect } from '@joinery/core';
import { formatSql } from '@joinery/sql-tools';
import { useEffect, useRef } from 'react';

import { syntaxDiagnostics } from '../lib/diagnostics';
import { languageFor, monaco } from '../lib/monaco';
import { runQuery } from '../state/runner';
import { runtimeOf, useWorkspace } from '../state/workspace';

/**
 * The SQL editor of a query tab (spec §6): Monaco with the dialect's highlighting.
 * Ctrl/Cmd+Enter runs the selection, or the statement at the cursor; Ctrl/Cmd+Shift+Enter runs
 * everything; Shift+Alt+F formats. Models outlive the editor view, so undo history survives the
 * dock re-mounting a panel.
 */

const models = new Map<string, monaco.editor.ITextModel>();

function modelFor(tabId: string, text: string, dialect: SqlDialect): monaco.editor.ITextModel {
  let model = models.get(tabId);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(text, languageFor(dialect));
    models.set(tabId, model);
  }
  return model;
}

/** Frees a closed tab's text model. */
export function disposeModel(tabId: string): void {
  models.get(tabId)?.dispose();
  models.delete(tabId);
}

function formatEditor(editor: monaco.editor.IStandaloneCodeEditor, dialect: SqlDialect): void {
  const model = editor.getModel();
  if (!model) return;
  const formatted = formatSql(model.getValue(), dialect);
  if (formatted === model.getValue()) return;
  editor.pushUndoStop();
  editor.executeEdits('joinery.format', [{ range: model.getFullModelRange(), text: formatted }]);
  editor.pushUndoStop();
}

export function QueryEditor(props: {
  readonly tabId: string;
  readonly dialect: SqlDialect;
  readonly theme: 'dark' | 'light';
  readonly fontSize: number;
  readonly minimap: boolean;
  readonly onReady?: () => void;
}) {
  const { tabId, dialect, onReady } = props;
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const initialText = useWorkspace((state) => state.tabs[tabId]?.initialText ?? '');
  const marker = useWorkspace((state) => state.tabs[tabId]?.errorMarker);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const model = modelFor(tabId, initialText, dialect);
    const editor = monaco.editor.create(element, {
      model,
      theme: props.theme === 'dark' ? 'joinery-dark' : 'joinery-light',
      automaticLayout: true,
      fontSize: props.fontSize,
      minimap: { enabled: props.minimap },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      renderLineHighlight: 'line',
      tabSize: 2,
      ariaLabel: 'SQL editor',
    });
    editorRef.current = editor;
    const selection = (): { start: number; end: number } | undefined => {
      const range = editor.getSelection();
      if (!range || range.isEmpty()) return undefined;
      return {
        start: model.getOffsetAt(range.getStartPosition()),
        end: model.getOffsetAt(range.getEndPosition()),
      };
    };
    runtimeOf(tabId).editor = {
      getText: () => model.getValue(),
      cursorOffset: () => {
        const position = editor.getPosition();
        return position ? model.getOffsetAt(position) : 0;
      },
      selection,
      setText: (text) => {
        editor.pushUndoStop();
        editor.executeEdits('joinery.set', [{ range: model.getFullModelRange(), text }]);
        editor.pushUndoStop();
      },
      focus: () => editor.focus(),
      format: () => formatEditor(editor, dialect),
    };
    editor.addAction({
      id: 'joinery.run',
      label: 'Run Selection or Statement at Cursor',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => void runQuery(tabId, selection() ? 'selection' : 'statement'),
    });
    editor.addAction({
      id: 'joinery.runAll',
      label: 'Run All',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
      run: () => void runQuery(tabId, 'all'),
    });
    editor.addAction({
      id: 'joinery.format',
      label: 'Format SQL',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      run: () => formatEditor(editor, dialect),
    });
    // Inline syntax errors from the language worker, a moment after typing stops.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = 0;
    const check = (): void => {
      const request = ++latest;
      const version = model.getVersionId();
      void syntaxDiagnostics(model.getValue(), dialect).then((diagnostics) => {
        if (request !== latest || model.isDisposed() || model.getVersionId() !== version) return;
        monaco.editor.setModelMarkers(
          model,
          'joinery-syntax',
          diagnostics.map((diagnostic) => {
            const start = model.getPositionAt(diagnostic.start);
            const end = model.getPositionAt(diagnostic.end);
            return {
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column,
              message: diagnostic.message,
              severity: monaco.MarkerSeverity.Error,
              source: 'syntax',
            };
          }),
        );
      });
    };
    const changes = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(check, 500);
    });
    check();
    editor.focus();
    onReady?.();
    return () => {
      clearTimeout(timer);
      changes.dispose();
      runtimeOf(tabId).editor = undefined;
      editorRef.current = undefined;
      editor.dispose();
    };
    // The editor is created once per tab; option changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'joinery-dark' : 'joinery-light');
  }, [props.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({
      fontSize: props.fontSize,
      minimap: { enabled: props.minimap },
    });
  }, [props.fontSize, props.minimap]);

  // Errors with a position are marked in the editor (spec §6).
  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    if (!marker) {
      monaco.editor.setModelMarkers(model, 'joinery', []);
      return;
    }
    const clamp = (offset: number): number => Math.max(0, Math.min(offset, model.getValueLength()));
    const start = model.getPositionAt(clamp(marker.start));
    let startColumn = start.column;
    let endLineNumber = start.lineNumber;
    let endColumn = start.column + 1;
    if (marker.end - marker.start <= 1) {
      // A point position (from the server) marks the whole word there.
      const word = model.getWordAtPosition(start);
      if (word) {
        startColumn = word.startColumn;
        endColumn = word.endColumn;
      }
    } else {
      const end = model.getPositionAt(clamp(marker.end));
      endLineNumber = end.lineNumber;
      endColumn = end.column;
    }
    monaco.editor.setModelMarkers(model, 'joinery', [
      {
        startLineNumber: start.lineNumber,
        startColumn,
        endLineNumber,
        endColumn,
        message: marker.message,
        severity: monaco.MarkerSeverity.Error,
      },
    ]);
    editor.revealLineInCenterIfOutsideViewport(start.lineNumber);
  }, [marker]);

  return <div ref={container} className="h-full w-full" data-testid="sql-editor" />;
}
