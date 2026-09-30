import { cellDisplay } from '@joinery/search-tools';
import { useMemo, useState, type UIEvent } from 'react';

import { formatCount, formatDuration } from '../../lib/format';
import { monaco } from '../../lib/monaco';
import { ESQL_WELCOME, SQL_WELCOME, type SqlView } from '../../state/search/sql';
import { useSearchView } from '../../state/search/view';
import { useTheme } from '../theme';
import { Button, Icon, cx } from '../ui';
import { AggregationView, FlatTable } from './AggregationView';
import { JsonEditor } from './JsonEditor';
import { openSearchConsole } from './open';
import { NoticeBar } from './parts';

/**
 * The SQL and ES|QL editor (spec §11): SQL through the SQL API,
 * ES|QL where the cluster has it (both by capability flag), results that page with the server's
 * cursor as they scroll, and Translate to DSL, whose search runs here with its aggregations as
 * a tree and a flattened table, or opens in the console.
 */

const ESQL_LANGUAGE = 'joinery-esql';
let esqlRegistered = false;

/** A Monarch tokenizer for ES|QL: pipes, commands, functions, strings and numbers. */
function registerEsql(): void {
  if (esqlRegistered) return;
  esqlRegistered = true;
  monaco.languages.register({ id: ESQL_LANGUAGE });
  monaco.languages.setMonarchTokensProvider(ESQL_LANGUAGE, {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [
          /\b(FROM|ROW|SHOW|META|WHERE|EVAL|STATS|BY|SORT|LIMIT|KEEP|DROP|RENAME|AS|DISSECT|GROK|ENRICH|ON|WITH|MV_EXPAND|LOOKUP|JOIN|ASC|DESC|NULLS|FIRST|LAST|AND|OR|NOT|IN|LIKE|RLIKE|IS|NULL|TRUE|FALSE|METADATA|INLINESTATS|FORK|COMPLETION|RERANK|SAMPLE|CHANGE_POINT)\b/,
          'keyword',
        ],
        [/\|/, 'delimiter'],
        [/"""/, 'string', '@triple'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/`[^`]*`/, 'identifier'],
        [/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/[a-z_][\w.]*(?=\s*\()/, 'type'],
      ],
      comment: [
        [/\*\//, 'comment', '@pop'],
        [/./, 'comment'],
      ],
      triple: [
        [/"""/, 'string', '@pop'],
        [/./, 'string'],
      ],
    },
  });
}

export function SqlPanel({ view }: { readonly view: SqlView }) {
  const theme = useTheme();
  const mode = useSearchView(view, (s) => s.mode);
  const running = useSearchView(view, (s) => s.running);
  const translating = useSearchView(view, (s) => s.translating);
  const translation = useSearchView(view, (s) => s.translation);
  const info = useSearchView(view, (s) => s.info);
  const [texts, setTexts] = useState({ sql: view.target.text ?? SQL_WELCOME, esql: ESQL_WELCOME });
  const [tab, setTab] = useState<'results' | 'dsl'>('results');
  const text = texts[mode];
  const supports = view.supports;
  registerEsql();

  const run = (): void => {
    setTab('results');
    void view.run(text);
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="search-sql">
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="SQL"
      >
        <div className="flex rounded border border-border" role="radiogroup" aria-label="Language">
          {(['sql', 'esql'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              disabled={!supports[option]}
              title={
                supports[option]
                  ? undefined
                  : option === 'sql'
                    ? 'This cluster has no SQL'
                    : 'This cluster has no ES|QL'
              }
              className={cx(
                'px-2 py-0.5 text-xs disabled:opacity-40',
                mode === option ? 'bg-accent text-accent-fg' : 'hover:bg-hover',
              )}
              onClick={() => view.setMode(option)}
            >
              {option === 'sql' ? 'SQL' : 'ES|QL'}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={run}
          disabled={running}
          title="Run (Ctrl/Cmd+Enter)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Run
        </Button>
        <Button
          size="sm"
          variant={running ? 'danger' : 'secondary'}
          onClick={() => void view.cancel()}
          disabled={!running}
        >
          <Icon name="stop" className="h-3.5 w-3.5" />
          Cancel
        </Button>
        {mode === 'sql' && (
          <Button
            size="sm"
            variant="ghost"
            disabled={translating || !supports.sql}
            onClick={() => {
              setTab('dsl');
              void view.translate(text);
            }}
          >
            Translate to DSL
          </Button>
        )}
        <span className="flex-1" />
        {info && <span className="text-[11px] text-muted">Elasticsearch {info.version}</span>}
      </div>
      <NoticeBar view={view} />
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="h-40 min-h-24 shrink-0 border-b border-border">
          <JsonEditor
            key={mode}
            value={text}
            onChange={(next) => setTexts((t) => ({ ...t, [mode]: next }))}
            theme={theme}
            onRun={run}
            ariaLabel={mode === 'sql' ? 'SQL query' : 'ES|QL query'}
            testId="sql-editor"
            language={mode === 'sql' ? 'pgsql' : ESQL_LANGUAGE}
          />
        </div>
        {mode === 'sql' && translation !== undefined && (
          <div
            className="flex gap-1 border-b border-border bg-panel px-2 pt-1"
            role="tablist"
            aria-label="Results"
          >
            {(['results', 'dsl'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={cx(
                  '-mb-px rounded-t border border-b-0 px-3 py-1 text-xs',
                  tab === id
                    ? 'border-border bg-bg'
                    : 'border-transparent text-muted hover:text-fg',
                )}
                onClick={() => setTab(id)}
              >
                {id === 'results' ? 'Results' : 'DSL'}
              </button>
            ))}
          </div>
        )}
        <div className="min-h-0 flex-1">
          {tab === 'dsl' && mode === 'sql' ? (
            <DslPane view={view} theme={theme} />
          ) : (
            <Results view={view} />
          )}
        </div>
      </div>
    </div>
  );
}

function Results({ view }: { readonly view: SqlView }) {
  const columns = useSearchView(view, (s) => s.columns);
  const rows = useSearchView(view, (s) => s.rows);
  const more = useSearchView(view, (s) => s.more);
  const loadingMore = useSearchView(view, (s) => s.loadingMore);
  const running = useSearchView(view, (s) => s.running);
  const error = useSearchView(view, (s) => s.error);
  const partial = useSearchView(view, (s) => s.partial);
  const duration = useSearchView(view, (s) => s.durationMs);
  const table = useMemo(
    () => ({
      columns: columns.map((c) => c.name),
      rows: rows.map((row) => row.map(cellDisplay)),
    }),
    [columns, rows],
  );
  const onScroll = (event: UIEvent<HTMLElement>): void => {
    const element = event.currentTarget;
    if (more && element.scrollTop + element.clientHeight >= element.scrollHeight - 200) {
      void view.loadMore();
    }
  };
  return (
    <div className="flex h-full flex-col">
      <div
        className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1 text-[11px] text-muted"
        aria-live="polite"
      >
        {running ? (
          <span>Running…</span>
        ) : (
          <>
            <span data-testid="sql-row-count">{formatCount(rows.length)} rows</span>
            {more && (
              <button
                type="button"
                className="text-accent hover:underline"
                onClick={() => void view.loadMore()}
              >
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
            {duration !== undefined && <span>· {formatDuration(duration)}</span>}
            {partial && <span className="text-warning">· partial results</span>}
            {columns.length > 0 && (
              <span className="truncate">
                · {columns.map((c) => `${c.name}: ${c.type}`).join(', ')}
              </span>
            )}
          </>
        )}
      </div>
      {error && (
        <p
          role="alert"
          className="border-b border-border px-3 py-1 text-xs text-danger"
          data-testid="sql-error"
        >
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto" onScroll={onScroll}>
        {columns.length > 0 && <FlatTable table={table} testId="sql-results" />}
      </div>
    </div>
  );
}

function DslPane(props: { readonly view: SqlView; readonly theme: 'dark' | 'light' }) {
  const { view } = props;
  const translation = useSearchView(view, (s) => s.translation);
  const translating = useSearchView(view, (s) => s.translating);
  const dslRun = useSearchView(view, (s) => s.dslRun);
  const [pane, setPane] = useState<'aggregations' | 'response'>('aggregations');
  if (translating) return <p className="p-3 text-xs text-muted">Translating…</p>;
  if (!translation)
    return <p className="p-3 text-xs text-muted">Translate a query to see its Query DSL.</p>;
  const consoleText = view.consoleText();
  return (
    <div className="flex h-full min-h-0">
      <section
        aria-label="Query DSL"
        className="flex min-w-0 flex-1 flex-col border-r border-border"
      >
        <div className="flex items-center gap-1.5 border-b border-border bg-panel px-2 py-1 text-xs">
          <span className="text-muted">
            {translation.dsl
              ? `Query DSL on ${translation.target ?? '?'}`
              : 'The server’s plan (no DSL in it)'}
          </span>
          <span className="flex-1" />
          <Button
            size="sm"
            variant="primary"
            disabled={!consoleText || dslRun?.running}
            onClick={() => void view.runDsl()}
          >
            Run DSL
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!consoleText}
            onClick={() =>
              consoleText &&
              openSearchConsole({
                profileId: view.profileId,
                title: `${translation.target ?? 'SQL'} console`,
                text: consoleText,
              })
            }
          >
            Open in console
          </Button>
        </div>
        <div className="min-h-0 flex-1" data-testid="sql-dsl">
          <JsonEditor
            value={translation.dsl ?? translation.raw}
            theme={props.theme}
            readOnly
            ariaLabel="Translated Query DSL"
          />
        </div>
      </section>
      <section aria-label="DSL results" className="flex min-w-0 flex-1 flex-col">
        {dslRun === undefined ? (
          <p className="p-3 text-xs text-muted">Run the DSL to see its hits and aggregations.</p>
        ) : dslRun.running ? (
          <p className="p-3 text-xs text-muted">Searching…</p>
        ) : (
          <>
            <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-1 text-xs">
              {dslRun.status !== undefined && (
                <span
                  className={cx(
                    'rounded px-1.5 font-semibold',
                    dslRun.status < 300 ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger',
                  )}
                >
                  {dslRun.status}
                </span>
              )}
              {dslRun.error && <span className="text-danger">{dslRun.error}</span>}
              <span className="flex-1" />
              {dslRun.aggregations && (
                <div
                  className="flex rounded border border-border"
                  role="radiogroup"
                  aria-label="DSL result view"
                >
                  {(['aggregations', 'response'] as const).map((option) => (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={pane === option}
                      className={cx(
                        'px-2 py-0.5',
                        pane === option ? 'bg-accent text-accent-fg' : 'hover:bg-hover',
                      )}
                      onClick={() => setPane(option)}
                    >
                      {option === 'aggregations' ? 'Aggregations' : 'Response'}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1">
              {dslRun.aggregations && pane === 'aggregations' ? (
                <AggregationView aggregations={dslRun.aggregations} />
              ) : (
                <JsonEditor
                  value={dslRun.body ?? ''}
                  theme={props.theme}
                  readOnly
                  ariaLabel="DSL response"
                />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
