import { useState } from 'react';

import { formatCount } from '../../lib/format';
import { useEditorAutosave } from '../../state/autosave';
import { useConnections } from '../../state/connections';
import { cachedProfile } from '../../state/data';
import { useConsoleState, type MongoConsole } from '../../state/mongo/console';
import { useResults, type ResultMode } from '../../state/mongo/results';
import { usePanels } from '../../state/panels';
import { useTheme } from '../theme';
import { Button, EnvironmentBadge, Icon, Select, cx } from '../ui';
import { ResultViews } from './ResultViews';
import { ShellEditor } from './ShellEditor';

/**
 * The MongoDB command console (spec §9): a command document runs against the chosen database
 * and its documents show in the tree, table and JSON views, with the run's messages beside them.
 * Runs go to the query history like a SQL tab's.
 */

const EXAMPLE = `{ find: "orders", filter: { total: { $gt: 100 } }, sort: { total: -1 }, limit: 20 }`;

export function ConsolePanel({ shell }: { readonly shell: MongoConsole }) {
  const theme = useTheme();
  const running = useConsoleState(shell, (s) => s.running);
  const database = useConsoleState(shell, (s) => s.database);
  const databases = useConsoleState(shell, (s) => s.databases);
  const pane = useConsoleState(shell, (s) => s.pane);
  const marker = useConsoleState(shell, (s) => s.errorMarker);
  const readOnly = useConsoleState(shell, (s) => s.readOnlyProfile);
  const messages = useConsoleState(shell, (s) => s.messages);
  const mode = useResults(shell.results, (s) => s.mode);
  const count = useResults(shell.results, (s) => s.documents.length);
  const hasMore = useResults(shell.results, (s) => s.hasMore);
  const connection = useConnections((s) => s.byProfile[shell.target.profileId]);
  const profile = cachedProfile(shell.target.profileId);
  const [text, setText] = useState(shell.target.text ?? '');
  const title = usePanels((s) => s.panels[shell.id]?.title ?? '');
  useEditorAutosave(shell.id, {
    kind: 'mongo-console',
    profileId: shell.target.profileId,
    database: database ?? null,
    title,
    text,
    cursor: null,
  });
  const errors = messages.filter((m) => m.kind === 'error').length;

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="mongo-console">
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Console"
      >
        <Button
          size="sm"
          variant="primary"
          onClick={() => void shell.run(text)}
          disabled={running}
          title="Run the command (Ctrl/Cmd+Enter)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Run
        </Button>
        <Button
          size="sm"
          variant={running ? 'danger' : 'secondary'}
          onClick={() => void shell.cancel()}
          disabled={!running}
        >
          <Icon name="stop" className="h-3.5 w-3.5" />
          Cancel
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Database
          <Select
            className="h-7 w-44 text-xs"
            value={database ?? ''}
            aria-label="Database"
            data-testid="mongo-console-database"
            onChange={(event) => void shell.useDatabase(event.target.value)}
          >
            {database === undefined && <option value="">(default)</option>}
            {[...new Set([...(database ? [database] : []), ...databases])].map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <span className="flex-1" />
        {readOnly && (
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">Read-only</span>
        )}
      </div>
      <div className="h-40 shrink-0 border-b border-border">
        <ShellEditor
          value={text}
          onChange={setText}
          theme={theme}
          issue={marker}
          onRun={() => void shell.run(text)}
          ariaLabel="Command"
          testId="mongo-console-editor"
        />
      </div>
      <p className="border-b border-border bg-panel px-2 py-1 text-[11px] text-muted">
        A command document, e.g. <span className="font-mono">{EXAMPLE}</span>
      </p>
      <div className="flex items-center gap-1 border-b border-border bg-panel px-1" role="tablist">
        {(['results', 'messages'] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="tab"
            aria-selected={pane === option}
            className={cx(
              'rounded-t px-2.5 py-1 text-xs',
              pane === option ? 'bg-bg text-fg' : 'text-muted hover:bg-hover',
            )}
            onClick={() => shell.setPane(option)}
          >
            {option === 'results' ? 'Results' : 'Messages'}
            {option === 'messages' && errors > 0 && (
              <span className="ml-1 rounded bg-danger/20 px-1 text-danger">{errors}</span>
            )}
          </button>
        ))}
        {pane === 'results' && (
          <div
            className="ml-2 flex rounded border border-border"
            role="radiogroup"
            aria-label="View"
          >
            {(['tree', 'table', 'json'] as ResultMode[]).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                className={cx(
                  'px-2 py-0.5 text-xs',
                  mode === option ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-hover',
                )}
                onClick={() => shell.results.setMode(option)}
              >
                {option === 'tree' ? 'Tree' : option === 'table' ? 'Table' : 'JSON'}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {pane === 'results' ? (
          <ResultViews results={shell.results} />
        ) : (
          <ol
            className="h-full overflow-auto font-mono text-xs"
            data-testid="mongo-console-messages"
            aria-live="polite"
          >
            {messages.length === 0 && (
              <li className="p-3 text-muted">Run a command to see its messages here.</li>
            )}
            {messages.map((message) => (
              <li
                key={message.id}
                className={cx(
                  'border-b border-border px-3 py-1.5',
                  message.kind === 'error' && 'text-danger',
                  message.kind === 'warning' && 'text-warning',
                  message.kind === 'info' && 'text-muted',
                )}
              >
                <span className="mr-2 text-muted">{new Date(message.at).toLocaleTimeString()}</span>
                <span className="whitespace-pre-wrap">{message.text}</span>
                {message.detail && (
                  <p className="mt-0.5 whitespace-pre-wrap text-muted">{message.detail}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
      <footer className="flex items-center gap-2 border-t border-border bg-panel px-3 py-0.5 text-[11px] text-muted">
        {profile && (
          <span className="flex items-center gap-1.5">
            <EnvironmentBadge environment={profile.presentation.environment} />
            {profile.name}
          </span>
        )}
        {connection?.info && <span>· MongoDB {connection.info.serverVersion}</span>}
        <span data-testid="mongo-console-count">
          · {formatCount(count)} {count === 1 ? 'document' : 'documents'}
          {hasMore ? ' (more on scroll)' : ''}
        </span>
        <span className="flex-1" />
        <span>
          {connection?.status === 'ready' ? 'Connected' : (connection?.status ?? 'Not connected')}
        </span>
      </footer>
    </div>
  );
}
