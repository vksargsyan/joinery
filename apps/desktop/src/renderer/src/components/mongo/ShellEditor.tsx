import 'monaco-editor/languages/definitions/javascript/register';
import { useEffect, useRef } from 'react';

import { monaco } from '../../lib/monaco';

/**
 * A Monaco editor for mongosh text (documents, command documents, find() text, updates), with
 * JavaScript highlighting, a marker at the parser's error position and Ctrl/Cmd+Enter to run.
 * The text is controlled: `value` updates the model only when it differs, so typing keeps the
 * cursor and the undo history.
 */
export function ShellEditor(props: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly theme: 'dark' | 'light';
  /** An error to mark: its 0-based offset and message. */
  readonly issue?: { readonly offset: number; readonly message: string } | undefined;
  readonly onRun?: () => void;
  readonly readOnly?: boolean;
  readonly ariaLabel: string;
  readonly testId?: string;
  readonly className?: string;
  /** Called with the editor once it exists (focus, selection...). */
  readonly onEditor?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const model = monaco.editor.createModel(latest.current.value, 'javascript');
    const editor = monaco.editor.create(element, {
      model,
      theme: latest.current.theme === 'dark' ? 'joinery-dark' : 'joinery-light',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 3,
      tabSize: 2,
      readOnly: latest.current.readOnly ?? false,
      ariaLabel: latest.current.ariaLabel,
      wordBasedSuggestions: 'off',
      quickSuggestions: false,
    });
    editorRef.current = editor;
    const subscription = model.onDidChangeContent(() => latest.current.onChange(model.getValue()));
    editor.addAction({
      id: 'joinery.mongo.run',
      label: 'Run',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => latest.current.onRun?.(),
    });
    latest.current.onEditor?.(editor);
    return () => {
      subscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== props.value) {
      editorRef.current!.pushUndoStop();
      editorRef.current!.executeEdits('joinery.set', [
        { range: model.getFullModelRange(), text: props.value },
      ]);
      editorRef.current!.pushUndoStop();
    }
  }, [props.value]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'joinery-dark' : 'joinery-light');
  }, [props.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly ?? false });
  }, [props.readOnly]);

  const issue = props.issue;
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (!issue) {
      monaco.editor.setModelMarkers(model, 'joinery-mongo', []);
      return;
    }
    const start = model.getPositionAt(issue.offset);
    const end = model.getPositionAt(Math.min(issue.offset + 1, model.getValueLength()));
    monaco.editor.setModelMarkers(model, 'joinery-mongo', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: Math.max(end.column, start.column + 1),
      },
    ]);
  }, [issue, props.value]);

  return (
    <div
      ref={container}
      data-testid={props.testId}
      className={props.className ?? 'h-full min-h-0'}
    />
  );
}
