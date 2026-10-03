import { useEffect, useRef, type MutableRefObject } from 'react';

import { createEditor, EDITOR_FONT, languageFor, monaco } from '../../lib/monaco';
import { bindModel, registerSqlLanguage, unbindModel } from '../../lib/sql-language';
import { useWorkspace } from '../../state/workspace';
import { useBuilder, useBuilderSelector } from './parts';

/**
 * The live SQL of a query builder (spec §8: two-way sync with SQL): Monaco with the dialect's
 * highlighting. The builder's edits replace the text (undoably); the user's edits go back to the
 * builder a moment after typing stops, which reads them or turns read-only. The part the builder
 * cannot show, or a syntax problem, is marked in the text; so is a run error. The model is bound
 * to the panel's query tab, so autocomplete works as in a SQL tab.
 */

registerSqlLanguage();

const PARSE_DELAY_MS = 250;

export function SqlPane(props: {
  readonly panelId: string;
  readonly theme: 'dark' | 'light';
  readonly fontSize: number;
  readonly onRun: () => void;
  /** Set to a function that hands pending edits to the builder at once (before a run). */
  readonly flushRef: MutableRefObject<(() => void) | undefined>;
}) {
  const builder = useBuilder();
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const sql = useBuilderSelector((state) => state.sql);
  const sync = useBuilderSelector((state) => state.sync);
  const marker = useWorkspace((state) => state.tabs[props.panelId]?.errorMarker);
  const run = useRef(props.onRun);
  run.current = props.onRun;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const model = monaco.editor.createModel(builder.state.sql, languageFor(builder.target.dialect));
    const editor = createEditor(element, {
      ...EDITOR_FONT,
      model,
      theme: props.theme === 'dark' ? 'querybara-dark' : 'querybara-light',
      automaticLayout: true,
      fontSize: props.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      tabSize: 2,
      wordWrap: 'on',
      ariaLabel: 'Query builder SQL',
      wordBasedSuggestions: 'off',
    });
    editorRef.current = editor;
    bindModel(model, props.panelId);
    let applying = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = builder.store.subscribe((state, previous) => {
      // The builder's edits, and SQL it was opened with; the pane's own edits already match.
      if (state.sql === previous.sql || model.getValue() === state.sql) return;
      clearTimeout(timer);
      applying = true;
      editor.pushUndoStop();
      editor.executeEdits('querybara.builder', [
        { range: model.getFullModelRange(), text: state.sql },
      ]);
      editor.pushUndoStop();
      applying = false;
    });
    const changes = model.onDidChangeContent(() => {
      if (applying) return;
      clearTimeout(timer);
      timer = setTimeout(() => builder.setSql(model.getValue()), PARSE_DELAY_MS);
    });
    const flush = (): void => {
      clearTimeout(timer);
      builder.setSql(model.getValue());
    };
    props.flushRef.current = flush;
    editor.addAction({
      id: 'querybara.builder.run',
      label: 'Run Query',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => run.current(),
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
      changes.dispose();
      props.flushRef.current = undefined;
      unbindModel(model);
      editorRef.current = undefined;
      editor.dispose();
      model.dispose();
    };
    // One editor per panel; theme and font follow below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [builder]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'querybara-dark' : 'querybara-light');
  }, [props.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: props.fontSize });
  }, [props.fontSize]);

  // Marks what the builder cannot show, a parse problem, or the last run's error.
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    const markers: monaco.editor.IMarkerData[] = [];
    const clamp = (offset: number): number => Math.max(0, Math.min(offset, model.getValueLength()));
    const mark = (
      start: number,
      end: number,
      message: string,
      severity: monaco.MarkerSeverity,
    ): void => {
      const from = model.getPositionAt(clamp(start));
      const to = model.getPositionAt(clamp(Math.max(end, start + 1)));
      markers.push({
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
        message,
        severity,
      });
    };
    if (sync.status !== 'synced' && model.getValue() === sql) {
      mark(
        sync.start,
        sync.end,
        sync.message,
        sync.status === 'unsupported' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
      );
    }
    if (marker) mark(marker.start, marker.end, marker.message, monaco.MarkerSeverity.Error);
    monaco.editor.setModelMarkers(model, 'querybara-builder', markers);
  }, [sync, marker, sql]);

  return <div ref={container} className="h-full w-full" data-testid="builder-sql" />;
}
