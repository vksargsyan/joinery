import type { SqlDialect } from '@joinery/core';
import { formatSql } from '@joinery/sql-tools';
import { useEffect, useRef } from 'react';

import { syntaxDiagnostics } from '../lib/language';
import { createEditor, EDITOR_FONT, languageFor, monaco } from '../lib/monaco';
import { bindModel, registerSqlLanguage, unbindModel } from '../lib/sql-language';
import { noteEditor } from '../state/autosave';
import { explainQuery } from '../state/explain/run';
import { openMetadata, useMetadataStatus } from '../state/metadata';
import { openQueryBuilderFromTab } from '../state/query-builder/panels';
import { runQuery } from '../state/runner';
import { getTab, runtimeOf, useWorkspace } from '../state/workspace';

/**
 * The SQL editor of a query tab (spec §6): Monaco with the dialect's highlighting, and the
 * language worker's syntax errors, autocomplete and signature help for the tab's connection.
 * Ctrl/Cmd+Enter runs the selection, or the statement at the cursor; Ctrl/Cmd+Shift+Enter runs
 * everything; Ctrl/Cmd+E explains, Ctrl/Cmd+Shift+E explains with ANALYZE; Shift+Alt+F formats.
 * Models outlive the editor view, so undo history survives the dock re-mounting a panel. Every
 * change is handed to autosave, which reads the text when it writes.
 */

registerSqlLanguage();

const models = new Map<string, monaco.editor.ITextModel>();

function modelFor(tabId: string, text: string, dialect: SqlDialect): monaco.editor.ITextModel {
  let model = models.get(tabId);
  if (!model || model.isDisposed()) {
    model = monaco.editor.createModel(text, languageFor(dialect));
    models.set(tabId, model);
    bindModel(model, tabId);
  }
  return model;
}

/** Frees a closed tab's text model. */
export function disposeModel(tabId: string): void {
  const model = models.get(tabId);
  if (model) unbindModel(model);
  model?.dispose();
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
  const profileId = useWorkspace((state) => state.tabs[tabId]?.profileId);
  const loadingMetadata = useMetadataStatus((state) =>
    profileId === undefined ? false : state.byProfile[profileId]?.loading === true,
  );

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const model = modelFor(tabId, initialText, dialect);
    const editor = createEditor(element, {
      ...EDITOR_FONT,
      model,
      theme: props.theme === 'dark' ? 'joinery-dark' : 'joinery-light',
      automaticLayout: true,
      fontSize: props.fontSize,
      minimap: { enabled: props.minimap },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      tabSize: 2,
      ariaLabel: 'SQL editor',
      // Suggestions come from the language service; words from the text would only add noise.
      wordBasedSuggestions: 'off',
    });
    editorRef.current = editor;
    const cursor = getTab(tabId)?.initialCursor;
    if (cursor !== undefined && model.getVersionId() === 1) {
      editor.setPosition(model.getPositionAt(cursor));
      editor.revealPositionInCenterIfOutsideViewport(model.getPositionAt(cursor));
    }
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
      id: 'joinery.explain',
      label: 'Explain Selection or Statement at Cursor',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE],
      run: () => void explainQuery(tabId, { analyze: false }),
    });
    editor.addAction({
      id: 'joinery.explainAnalyze',
      label: 'Explain Analyze Selection or Statement at Cursor',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
      run: () => void explainQuery(tabId, { analyze: true }),
    });
    editor.addAction({
      id: 'joinery.queryBuilder',
      label: 'Open in Query Builder',
      contextMenuGroupId: 'navigation',
      run: () => void openQueryBuilderFromTab(tabId),
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
    const channel = model.uri.toString();
    const check = (): void => {
      const request = ++latest;
      const version = model.getVersionId();
      void syntaxDiagnostics(model.getValue(), dialect, channel).then((diagnostics) => {
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
    // Autosave (spec §18): the buffer is read when the batch is written, not per keystroke.
    const autosave = (): void =>
      noteEditor(tabId, () => {
        const tab = getTab(tabId);
        if (!tab || model.isDisposed()) return undefined;
        return {
          kind: 'sql',
          profileId: tab.profileId,
          database: null,
          title: tab.title,
          text: model.getValue(),
          cursor: runtimeOf(tabId).editor?.cursorOffset() ?? null,
        };
      });
    if (model.getValueLength() > 0) autosave();
    const changes = model.onDidChangeContent(() => {
      clearTimeout(timer);
      timer = setTimeout(check, 500);
      autosave();
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
    if (profileId !== undefined) openMetadata(profileId);
  }, [profileId]);

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

  return (
    <div className="relative h-full w-full">
      <div ref={container} className="h-full w-full" data-testid="sql-editor" />
      {loadingMetadata && (
        <div
          role="status"
          data-testid="metadata-loading"
          className="pointer-events-none absolute right-4 bottom-1 rounded bg-panel/80 px-1.5 text-[11px] text-muted"
        >
          Loading metadata…
        </div>
      )}
    </div>
  );
}
