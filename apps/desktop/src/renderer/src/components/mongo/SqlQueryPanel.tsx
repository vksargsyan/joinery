import { useState } from 'react';

import { formatCount } from '../../lib/format';
import { useEditorAutosave } from '../../state/autosave';
import type { CodeExportRequest } from '../../state/mongo/code-export';
import { useConnections } from '../../state/connections';
import { cachedProfile } from '../../state/data';
import { useResults } from '../../state/mongo/results';
import {
  SQL_EXAMPLE,
  exportTargetOf,
  pipelineTextOf,
  useSqlQuery,
  type SqlQuery,
} from '../../state/mongo/sql-query';
import { usePanels } from '../../state/panels';
import { useTheme } from '../theme';
import { Button, EnvironmentBadge, Icon, Select, cx } from '../ui';
import { CodeExportDialog } from './CodeExportDialog';
import { openMongoCollection, openMongoTool } from './open';
import { NoticeBanner, Segmented } from './parts';
import { ResultViews } from './ResultViews';
import { ShellEditor } from './ShellEditor';

/**
 * A SQL tab on a MongoDB database (spec §9, "Query tools"): the SELECT on the left, its find()
 * or aggregate() on the right as it is typed, and the documents below in the tree, table and
 * JSON views. The translation opens in the collection view or the aggregation editor, and
 * exports as driver code.
 */

const SUPPORTED =
  'SELECT with WHERE, [INNER | LEFT] JOIN … ON, GROUP BY, HAVING, ORDER BY, LIMIT and OFFSET, DISTINCT, and COUNT, SUM, AVG, MIN and MAX.';

export function SqlQueryPanel({ query }: { readonly query: SqlQuery }) {
  const theme = useTheme();
  const text = useSqlQuery(query, (s) => s.text);
  const database = useSqlQuery(query, (s) => s.database);
  const databases = useSqlQuery(query, (s) => s.databases);
  const translation = useSqlQuery(query, (s) => s.translation);
  const issue = useSqlQuery(query, (s) => s.issue);
  const running = useSqlQuery(query, (s) => s.running);
  const ran = useSqlQuery(query, (s) => s.ran);
  const durationMs = useSqlQuery(query, (s) => s.durationMs);
  const notice = useSqlQuery(query, (s) => s.notice);
  const mode = useResults(query.results, (s) => s.mode);
  const count = useResults(query.results, (s) => s.documents.length);
  const hasMore = useResults(query.results, (s) => s.hasMore);
  const connection = useConnections((s) => s.byProfile[query.target.profileId]);
  const profile = cachedProfile(query.target.profileId);
  const title = usePanels((s) => s.panels[query.id]?.title ?? '');
  const [exporting, setExporting] = useState<CodeExportRequest | undefined>();
  useEditorAutosave(query.id, {
    kind: 'mongo-sql',
    profileId: query.target.profileId,
    database,
    title,
    text,
    cursor: null,
  });

  const openElsewhere = async (): Promise<void> => {
    const current = query.current();
    if (current?.kind === 'aggregate') {
      openMongoTool(
        {
          tool: 'aggregation',
          target: {
            profileId: query.target.profileId,
            db: database,
            collection: current.collection,
            text: pipelineTextOf(current)!,
          },
        },
        { replace: true },
      );
      return;
    }
    const destination = await query.collectionDestination();
    if (destination) openMongoCollection(destination.target, destination.fields);
  };
  const exportCode = (): void => {
    const current = query.current();
    if (current) setExporting({ target: exportTargetOf(current), database });
    else query.note({ kind: 'error', text: 'Write a SELECT that translates first.' });
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="mongo-sql">
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="SQL"
      >
        <Button
          size="sm"
          variant="primary"
          onClick={() => void query.run()}
          disabled={running}
          title="Run the query (Ctrl/Cmd+Enter)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Run
        </Button>
        <Button
          size="sm"
          variant={running ? 'danger' : 'secondary'}
          onClick={() => void query.cancel()}
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
            value={database}
            aria-label="Database"
            data-testid="mongo-sql-database"
            onChange={(event) => query.setDatabase(event.target.value)}
          >
            {databases.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </Select>
        </label>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          disabled={translation === undefined}
          onClick={() => void openElsewhere()}
          title={
            translation?.kind === 'aggregate'
              ? 'Open the pipeline in the aggregation editor'
              : 'Open the query in the collection view'
          }
        >
          {translation?.kind === 'aggregate'
            ? 'Open in aggregation editor'
            : 'Open in collection view'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={translation === undefined}
          onClick={exportCode}
          title="Export the query as Node.js, Python, Java, C#, Go or PHP code"
        >
          Export code…
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-muted">SELECT only: nothing here writes</span>
      </div>
      <NoticeBanner notice={notice} onDismiss={() => query.note(undefined)} />
      <div className="flex h-52 shrink-0 border-b border-border">
        <section className="flex min-w-0 flex-1 flex-col" aria-label="SQL">
          <PaneHeader label="SQL" />
          <div className="min-h-0 flex-1">
            <ShellEditor
              value={text}
              onChange={(next) => query.setText(next)}
              language="mysql"
              wrap
              theme={theme}
              issue={issue}
              onRun={() => void query.run()}
              ariaLabel="SQL query"
              testId="mongo-sql-editor"
            />
          </div>
        </section>
        <section
          className="flex w-[44%] min-w-0 flex-col border-l border-border"
          aria-label="MongoDB query"
        >
          <PaneHeader
            label="MongoDB"
            badge={
              translation
                ? translation.kind === 'find'
                  ? 'find()'
                  : `aggregate() · ${translation.pipeline.length} ${translation.pipeline.length === 1 ? 'stage' : 'stages'}`
                : undefined
            }
          />
          <div className="min-h-0 flex-1" data-testid="mongo-sql-translation">
            {translation ? (
              <ShellEditor
                value={translation.text}
                onChange={() => undefined}
                readOnly
                wrap
                theme={theme}
                ariaLabel="Translated MongoDB query"
                testId="mongo-sql-mql"
              />
            ) : issue ? (
              <div
                className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs"
                role="alert"
                data-testid="mongo-sql-issue"
              >
                <span
                  className={cx(
                    'w-fit rounded px-1.5 py-0.5 text-[11px] font-medium',
                    issue.unsupported ? 'bg-warning/15 text-warning' : 'bg-danger/15 text-danger',
                  )}
                >
                  {issue.unsupported ? 'Not supported' : 'Does not translate'}
                </span>
                <p className={issue.unsupported ? 'text-fg' : 'text-danger'}>{issue.message}</p>
                {issue.hint && <p className="text-muted">{issue.hint}</p>}
                {issue.unsupported && <p className="text-muted">Supported: {SUPPORTED}</p>}
              </div>
            ) : (
              <div className="flex h-full flex-col gap-2 overflow-auto p-3 text-xs text-muted">
                <p>
                  Write a SELECT and its find() or aggregate() appears here as you type. For
                  example:
                </p>
                <p className="font-mono text-fg">{SQL_EXAMPLE}</p>
                <p>Supported: {SUPPORTED}</p>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1">
        <span className="text-xs font-medium text-muted">Results</span>
        <Segmented
          label="View"
          value={mode}
          options={[
            { value: 'table', label: 'Table' },
            { value: 'tree', label: 'Tree' },
            { value: 'json', label: 'JSON' },
          ]}
          onChange={(next) => query.results.setMode(next)}
        />
        <span className="flex-1" />
        {ran && durationMs !== undefined && (
          <span className="text-[11px] text-muted" data-testid="mongo-sql-ran">
            {ran.kind === 'find' ? 'find()' : 'aggregate()'} on {ran.collection} · {durationMs} ms
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {ran ? (
          <ResultViews results={query.results} />
        ) : (
          <p className="p-4 text-sm text-muted">Run the query to see its documents here.</p>
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
        <span data-testid="mongo-sql-count">
          · {formatCount(count)} {count === 1 ? 'document' : 'documents'}
          {hasMore ? ' (more on scroll)' : ''}
        </span>
        <span className="flex-1" />
        <span>
          {connection?.status === 'ready' ? 'Connected' : (connection?.status ?? 'Not connected')}
        </span>
      </footer>
      <CodeExportDialog request={exporting} onClose={() => setExporting(undefined)} />
    </div>
  );
}

function PaneHeader(props: { readonly label: string; readonly badge?: string | undefined }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-panel px-2">
      <span className="text-[11px] font-medium tracking-wide text-muted uppercase">
        {props.label}
      </span>
      {props.badge && (
        <span className="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[11px] text-accent">
          {props.badge}
        </span>
      )}
    </div>
  );
}
