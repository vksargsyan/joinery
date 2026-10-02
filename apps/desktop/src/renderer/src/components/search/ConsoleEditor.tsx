import { parseConsole, requestAt, type ConsoleCompletionOptions } from '@joinery/search-tools';
import { useEffect, useRef } from 'react';

import { createEditor, EDITOR_FONT, monaco } from '../../lib/monaco';
import {
  CONSOLE_LANGUAGE,
  bindConsoleModel,
  registerConsoleLanguage,
  unbindConsoleModel,
} from './language';

/**
 * The console's Monaco editor (spec §11): console syntax highlighting and autocomplete, the
 * request at the cursor highlighted, syntax issues and the server's error position marked, and
 * Ctrl/Cmd+Enter to send the request at the cursor (or the selected ones). The text is
 * uncontrolled after mount: the editor owns it, and the panel reads it when it runs.
 */
export function ConsoleEditor(props: {
  readonly initialText: string;
  readonly theme: 'dark' | 'light';
  readonly completion: () => ConsoleCompletionOptions;
  /** Sends the request at the cursor, or the ones in the selection: [start, end) offsets. */
  readonly onRun: (text: string, start: number, end: number) => void;
  /** A server-reported error to mark: its offset and message. */
  readonly errorMarker?: { readonly offset: number; readonly message: string } | undefined;
  /** Called with the editor once it exists (the panel's buttons use it). */
  readonly onEditor?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    registerConsoleLanguage();
    const model = monaco.editor.createModel(latest.current.initialText, CONSOLE_LANGUAGE);
    bindConsoleModel(model, () => latest.current.completion());
    const editor = createEditor(element, {
      ...EDITOR_FONT,
      model,
      theme: latest.current.theme === 'dark' ? 'joinery-dark' : 'joinery-light',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      tabSize: 2,
      insertSpaces: true,
      ariaLabel: 'Console requests',
      wordBasedSuggestions: 'off',
      quickSuggestions: { other: true, strings: true, comments: false },
      suggestOnTriggerCharacters: true,
      folding: true,
      glyphMargin: false,
    });
    editorRef.current = editor;
    const run = (): void => {
      const selection = editor.getSelection();
      if (!selection) return;
      const start = model.getOffsetAt(selection.getStartPosition());
      const end = model.getOffsetAt(selection.getEndPosition());
      latest.current.onRun(model.getValue(), start, end);
    };
    editor.addAction({
      id: 'joinery.search.run',
      label: 'Send request',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run,
    });

    // Syntax issues as markers, and the request at the cursor highlighted.
    const decorations = editor.createDecorationsCollection();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (): void => {
      const text = model.getValue();
      const parse = parseConsole(text);
      monaco.editor.setModelMarkers(
        model,
        'joinery-console',
        parse.issues.map((issue) => {
          const start = model.getPositionAt(issue.start);
          const end = model.getPositionAt(Math.max(issue.end, issue.start + 1));
          return {
            severity: monaco.MarkerSeverity.Error,
            message: issue.message,
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          };
        }),
      );
      const position = editor.getPosition();
      const current = position ? requestAt(parse.requests, model.getOffsetAt(position)) : undefined;
      if (!current) {
        decorations.clear();
        return;
      }
      const start = model.getPositionAt(current.start);
      const end = model.getPositionAt(current.end);
      decorations.set([
        {
          range: new monaco.Range(start.lineNumber, 1, end.lineNumber, 1),
          options: {
            isWholeLine: true,
            className: 'bg-accent/10',
            linesDecorationsClassName: 'border-l-2 border-accent',
          },
        },
      ]);
    };
    const schedule = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const contentSubscription = model.onDidChangeContent(schedule);
    const cursorSubscription = editor.onDidChangeCursorPosition(schedule);
    refresh();
    latest.current.onEditor?.(editor);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      contentSubscription.dispose();
      cursorSubscription.dispose();
      unbindConsoleModel(model);
      editor.dispose();
      model.dispose();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'joinery-dark' : 'joinery-light');
  }, [props.theme]);

  const marker = props.errorMarker;
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (!marker) {
      monaco.editor.setModelMarkers(model, 'joinery-console-server', []);
      return;
    }
    const start = model.getPositionAt(marker.offset);
    const end = model.getPositionAt(Math.min(marker.offset + 1, model.getValueLength()));
    monaco.editor.setModelMarkers(model, 'joinery-console-server', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: marker.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: Math.max(end.column, start.column + 1),
      },
    ]);
  }, [marker]);

  return <div ref={container} data-testid="search-console-editor" className="h-full min-h-0" />;
}

/** A read-only Monaco view of a response body, highlighted like the console. */
export function ResponseViewer(props: { readonly text: string; readonly theme: 'dark' | 'light' }) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const initial = useRef(props);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    registerConsoleLanguage();
    const model = monaco.editor.createModel(initial.current.text, CONSOLE_LANGUAGE);
    const editor = monaco.editor.create(element, {
      ...EDITOR_FONT,
      model,
      readOnly: true,
      theme: initial.current.theme === 'dark' ? 'joinery-dark' : 'joinery-light',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      folding: true,
      ariaLabel: 'Response',
      wordWrap: 'on',
    });
    editorRef.current = editor;
    return () => {
      editor.dispose();
      model.dispose();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== props.text) model.setValue(props.text);
  }, [props.text]);

  return <div ref={container} data-testid="search-response-editor" className="h-full min-h-0" />;
}
