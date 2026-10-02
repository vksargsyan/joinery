import { useEffect, useRef } from 'react';

import { EDITOR_FONT, monaco } from '../../lib/monaco';
import { CONSOLE_LANGUAGE, registerConsoleLanguage } from './language';

/**
 * A Monaco editor for JSON text (documents, mappings, settings, templates, pipelines): the
 * console's highlighting, a marker at a syntax error, and Ctrl/Cmd+Enter to run. The text is
 * controlled: `value` updates the model only when it differs, so typing keeps the cursor and
 * the undo history. `language` switches to SQL or ES|QL for the SQL editor.
 */
export function JsonEditor(props: {
  readonly value: string;
  readonly onChange?: (text: string) => void;
  readonly theme: 'dark' | 'light';
  readonly issue?: { readonly offset: number; readonly message: string } | undefined;
  readonly onRun?: () => void;
  readonly readOnly?: boolean;
  readonly ariaLabel: string;
  readonly testId?: string;
  readonly className?: string;
  readonly language?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    registerConsoleLanguage();
    const model = monaco.editor.createModel(
      latest.current.value,
      latest.current.language ?? CONSOLE_LANGUAGE,
    );
    const editor = monaco.editor.create(element, {
      ...EDITOR_FONT,
      model,
      theme: latest.current.theme === 'dark' ? 'joinery-dark' : 'joinery-light',
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      lineNumbersMinChars: 3,
      tabSize: 2,
      insertSpaces: true,
      readOnly: latest.current.readOnly ?? false,
      ariaLabel: latest.current.ariaLabel,
      wordBasedSuggestions: 'off',
      quickSuggestions: false,
      folding: true,
      wordWrap: latest.current.readOnly ? 'on' : 'off',
    });
    editorRef.current = editor;
    const subscription = model.onDidChangeContent(() =>
      latest.current.onChange?.(model.getValue()),
    );
    editor.addAction({
      id: 'joinery.search.json.run',
      label: 'Run',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => latest.current.onRun?.(),
    });
    return () => {
      subscription.dispose();
      editor.dispose();
      model.dispose();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'joinery-dark' : 'joinery-light');
  }, [props.theme]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model && model.getValue() !== props.value) model.setValue(props.value);
  }, [props.value]);

  const issue = props.issue;
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (!issue) {
      monaco.editor.setModelMarkers(model, 'joinery-json', []);
      return;
    }
    const start = model.getPositionAt(issue.offset);
    const end = model.getPositionAt(Math.min(issue.offset + 1, model.getValueLength()));
    monaco.editor.setModelMarkers(model, 'joinery-json', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: Math.max(end.column, start.column + 1),
      },
    ]);
  }, [issue]);

  return (
    <div
      ref={container}
      data-testid={props.testId}
      className={props.className ?? 'h-full min-h-0'}
    />
  );
}
