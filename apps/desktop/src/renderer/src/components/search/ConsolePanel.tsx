import { useRef, useState } from 'react';

import { formatDuration } from '../../lib/format';
import type { monaco } from '../../lib/monaco';
import { useConnections } from '../../state/connections';
import { cachedProfile } from '../../state/data';
import { WELCOME, useSearchConsole, type SearchConsole } from '../../state/search/console';
import { autoIndent, statusText, type ConsoleResponseView } from '../../state/search/console-flow';
import { useTheme } from '../theme';
import { Button, EnvironmentBadge, Icon, cx } from '../ui';
import { AggregationView } from './AggregationView';
import { ConsoleEditor, ResponseViewer } from './ConsoleEditor';

/**
 * The Elasticsearch console (spec §11): Kibana Dev Tools syntax on the left, the
 * responses on the right. Ctrl/Cmd+Enter (or Send) sends the request at the cursor, or every
 * request the selection touches; Auto-indent re-indents their bodies; History lists what ran
 * here, a click puts it back into the editor.
 */
export function ConsolePanel({ console }: { readonly console: SearchConsole }) {
  const theme = useTheme();
  const running = useSearchConsole(console, (s) => s.running);
  const responses = useSearchConsole(console, (s) => s.responses);
  const marker = useSearchConsole(console, (s) => s.errorMarker);
  const historyOpen = useSearchConsole(console, (s) => s.historyOpen);
  const history = useSearchConsole(console, (s) => s.history);
  const policy = useSearchConsole(console, (s) => s.policy);
  const serverVersion = useSearchConsole(console, (s) => s.serverVersion);
  const connection = useConnections((s) => s.byProfile[console.target.profileId]);
  const profile = cachedProfile(console.target.profileId);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [pane, setPane] = useState<'json' | 'aggregations'>('json');
  const shown = responses[selected ?? responses.length - 1];

  const send = (): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!editor || !model || !selection) return;
    setSelected(undefined);
    void console.run(
      model.getValue(),
      model.getOffsetAt(selection.getStartPosition()),
      model.getOffsetAt(selection.getEndPosition()),
    );
  };

  const indent = (): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    if (!editor || !model || !selection) return;
    let next: string;
    try {
      next = autoIndent(
        model.getValue(),
        model.getOffsetAt(selection.getStartPosition()),
        model.getOffsetAt(selection.getEndPosition()),
      );
    } catch {
      return;
    }
    if (next === model.getValue()) return;
    editor.pushUndoStop();
    editor.executeEdits('joinery.search.indent', [
      { range: model.getFullModelRange(), text: next },
    ]);
    editor.pushUndoStop();
  };

  const insert = (text: string): void => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    const end = model.getPositionAt(model.getValueLength());
    const prefix = model.getValueLength() === 0 || model.getValue().endsWith('\n\n') ? '' : '\n\n';
    editor.executeEdits('joinery.search.history', [
      {
        range: {
          startLineNumber: end.lineNumber,
          startColumn: end.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text: `${prefix}${text}\n`,
      },
    ]);
    const start = model.getPositionAt(model.getValueLength() - text.length - 1);
    editor.setPosition(start);
    editor.revealPositionInCenter(start);
    editor.focus();
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-console">
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Console"
      >
        <Button
          size="sm"
          variant="primary"
          onClick={send}
          disabled={running}
          title="Send the request at the cursor (Ctrl/Cmd+Enter)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Send
        </Button>
        <Button
          size="sm"
          variant={running ? 'danger' : 'secondary'}
          onClick={() => void console.cancel()}
          disabled={!running}
        >
          <Icon name="stop" className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button size="sm" variant="ghost" onClick={indent} title="Re-indent the request bodies">
          <Icon name="format" className="h-3.5 w-3.5" />
          Auto-indent
        </Button>
        <Button
          size="sm"
          variant={historyOpen ? 'secondary' : 'ghost'}
          aria-pressed={historyOpen}
          onClick={() => console.setHistoryOpen(!historyOpen)}
        >
          <Icon name="history" className="h-3.5 w-3.5" />
          History
        </Button>
        <span className="flex-1" />
        {policy?.readOnly && (
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">Read-only</span>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        {historyOpen && (
          <aside
            aria-label="Console history"
            className="flex w-56 shrink-0 flex-col border-r border-border bg-panel"
          >
            <p className="border-b border-border px-2 py-1 text-[11px] text-muted">
              Click to put a request back in the editor
            </p>
            <ol className="min-h-0 flex-1 overflow-auto" data-testid="search-console-history">
              {history.length === 0 && (
                <li className="p-2 text-xs text-muted">Requests you send show here.</li>
              )}
              {history.map((entry) => (
                <li key={entry}>
                  <button
                    type="button"
                    className="block w-full truncate border-b border-border px-2 py-1 text-left font-mono text-[11px] hover:bg-hover"
                    title={entry}
                    onClick={() => insert(entry)}
                  >
                    {entry.split('\n')[0]}
                  </button>
                </li>
              ))}
            </ol>
          </aside>
        )}
        <div className="min-w-0 flex-1 border-r border-border">
          <ConsoleEditor
            initialText={console.target.text ?? WELCOME}
            theme={theme}
            errorMarker={marker}
            completion={() => ({ indices: console.state.names })}
            onRun={(text, start, end) => {
              setSelected(undefined);
              void console.run(text, start, end);
            }}
            onEditor={(editor) => {
              editorRef.current = editor;
            }}
          />
        </div>
        <section aria-label="Responses" className="flex min-w-0 flex-1 flex-col">
          {responses.length > 1 && (
            <div
              className="flex flex-wrap gap-1 border-b border-border bg-panel px-1 py-1"
              role="tablist"
            >
              {responses.map((response, index) => (
                <button
                  key={`${index}-${response.label}`}
                  type="button"
                  role="tab"
                  aria-selected={response === shown}
                  className={cx(
                    'rounded px-2 py-0.5 font-mono text-[11px]',
                    response === shown ? 'bg-bg text-fg' : 'text-muted hover:bg-hover',
                  )}
                  onClick={() => setSelected(index)}
                >
                  {response.label}
                </button>
              ))}
            </div>
          )}
          {shown ? (
            <ResponseHeader response={shown} running={running} />
          ) : (
            <p className="border-b border-border bg-panel px-3 py-1.5 text-xs text-muted">
              {running ? 'Sending…' : 'Send a request to see its response here.'}
            </p>
          )}
          {shown?.aggregations !== undefined && (
            <div
              className="flex gap-1 border-b border-border bg-panel px-2 pt-1"
              role="tablist"
              aria-label="Response view"
            >
              {(['json', 'aggregations'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={pane === id}
                  className={cx(
                    '-mb-px rounded-t border border-b-0 px-3 py-0.5 text-xs',
                    pane === id
                      ? 'border-border bg-bg'
                      : 'border-transparent text-muted hover:text-fg',
                  )}
                  onClick={() => setPane(id)}
                >
                  {id === 'json' ? 'Response' : 'Aggregations'}
                </button>
              ))}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {shown?.aggregations !== undefined && pane === 'aggregations' ? (
              <AggregationView aggregations={shown.aggregations} />
            ) : (
              <ResponseViewer text={shown?.body ?? ''} theme={theme} />
            )}
          </div>
        </section>
      </div>
      <footer className="flex items-center gap-2 border-t border-border bg-panel px-3 py-0.5 text-[11px] text-muted">
        {profile && (
          <span className="flex items-center gap-1.5">
            <EnvironmentBadge environment={profile.presentation.environment} />
            {profile.name}
          </span>
        )}
        {serverVersion && <span>· Elasticsearch {serverVersion}</span>}
        <span className="flex-1" />
        <span>
          {connection?.status === 'ready' ? 'Connected' : (connection?.status ?? 'Not connected')}
        </span>
      </footer>
    </div>
  );
}

function ResponseHeader(props: {
  readonly response: ConsoleResponseView;
  readonly running: boolean;
}) {
  const { response } = props;
  const status = response.status;
  return (
    <div className="border-b border-border bg-panel px-3 py-1.5 text-xs" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-muted">{response.label}</span>
        {status !== undefined ? (
          <span
            data-testid="search-response-status"
            className={cx(
              'rounded px-1.5 py-0.5 font-semibold',
              status < 300 && 'bg-success/15 text-success',
              status >= 300 && status < 500 && 'bg-warning/15 text-warning',
              status >= 500 && 'bg-danger/15 text-danger',
            )}
          >
            {statusText(status)}
          </span>
        ) : (
          <span
            data-testid="search-response-status"
            className="rounded bg-danger/15 px-1.5 py-0.5 font-semibold text-danger"
          >
            Not sent
          </span>
        )}
        {status !== undefined && (
          <span className="text-muted">{formatDuration(response.durationMs)}</span>
        )}
        {response.summary && (
          <span data-testid="search-response-summary" className="text-fg">
            {response.summary}
          </span>
        )}
        {response.truncated && <span className="text-warning">The response was cut</span>}
        {props.running && <span className="text-muted">Sending…</span>}
      </div>
      {response.error && (
        <p
          role="alert"
          data-testid="search-response-error"
          className="mt-0.5 whitespace-pre-wrap text-danger"
        >
          {response.error}
        </p>
      )}
      {response.warnings.map((warning) => (
        <p key={warning} className="mt-0.5 text-warning">
          {warning}
        </p>
      ))}
    </div>
  );
}
