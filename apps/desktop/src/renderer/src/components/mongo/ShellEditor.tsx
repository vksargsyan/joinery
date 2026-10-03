import 'monaco-editor/languages/definitions/javascript/register';
import { useEffect, useRef } from 'react';

import { createEditor, EDITOR_FONT, monaco } from '../../lib/monaco';

/**
 * A Monaco editor for mongosh text (documents, command documents, find() text, updates), with
 * JavaScript highlighting, a marker at the parser's error position and Ctrl/Cmd+Enter to run.
 * The text is controlled: `value` updates the model only when it differs, so typing keeps the
 * cursor and the undo history. `language` puts other text in it (SQL, exported code); the
 * caller registers that language with Monaco.
 */
export function ShellEditor(props: {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly theme: 'dark' | 'light';
  /** Monaco's language id; default `javascript`. */
  readonly language?: string;
  /** An error to mark: its 0-based offset (to `end`, exclusive, when given) and message. */
  readonly issue?:
    { readonly offset: number; readonly end?: number; readonly message: string } | undefined;
  readonly onRun?: () => void;
  readonly readOnly?: boolean;
  /** Wraps long lines instead of scrolling sideways. */
  readonly wrap?: boolean;
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
    const model = monaco.editor.createModel(
      latest.current.value,
      latest.current.language ?? 'javascript',
    );
    const editor = createEditor(element, {
      ...EDITOR_FONT,
      model,
      theme: latest.current.theme === 'dark' ? 'querybara-dark' : 'querybara-light',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      tabSize: 2,
      readOnly: latest.current.readOnly ?? false,
      wordWrap: latest.current.wrap ? 'on' : 'off',
      ariaLabel: latest.current.ariaLabel,
      wordBasedSuggestions: 'off',
      quickSuggestions: false,
    });
    editorRef.current = editor;
    const subscription = model.onDidChangeContent(() => latest.current.onChange(model.getValue()));
    editor.addAction({
      id: 'querybara.mongo.run',
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
      // A read-only editor refuses edits, and has no undo history to keep.
      if (latest.current.readOnly) {
        model.setValue(props.value);
        return;
      }
      editorRef.current!.pushUndoStop();
      editorRef.current!.executeEdits('querybara.set', [
        { range: model.getFullModelRange(), text: props.value },
      ]);
      editorRef.current!.pushUndoStop();
    }
  }, [props.value]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'querybara-dark' : 'querybara-light');
  }, [props.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly: props.readOnly ?? false });
  }, [props.readOnly]);

  const language = props.language ?? 'javascript';
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getLanguageId() !== language)
      monaco.editor.setModelLanguage(model, language);
  }, [language]);

  const issue = props.issue;
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (!issue) {
      monaco.editor.setModelMarkers(model, 'querybara-mongo', []);
      return;
    }
    const start = model.getPositionAt(issue.offset);
    const end = model.getPositionAt(
      Math.min(Math.max(issue.end ?? 0, issue.offset + 1), model.getValueLength()),
    );
    monaco.editor.setModelMarkers(model, 'querybara-mongo', [
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
