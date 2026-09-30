import { JoineryError } from '@joinery/core';
import {
  commandLine,
  definitionOf,
  displayBytes,
  searchCreateArgs,
  utf8Bytes,
  VECTOR_DATA_TYPES,
  VECTOR_DISTANCES,
  type SearchFieldType,
  type SearchIndexInfo,
  type SearchKeyType,
} from '@joinery/redis-tools';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { destructive, WRITE } from '../../../../shared/redis-safety';
import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import {
  openRedisPanel,
  panelLane,
  redisWrite,
  type RedisPanelTarget,
} from '../../state/redis/panels';
import {
  createPreview,
  definitionOfDraft,
  emptyDraft,
  mergeSuggestions,
  newField,
  querySnippet,
  resultColumns,
  sortableFields,
  splitPrefixes,
  type FieldDraft,
  type IndexDraft,
} from '../../state/redis/search';
import { formatBytes } from '../../state/redis/value-model';
import { Button, Icon, Input, Modal, Select, cx } from '../ui';
import { EmptyState, NodeSelect, Notice, Separator, Toolbar, useConnectionFacts } from './common';

/**
 * Search indexes (RediSearch, the Redis Query Engine): the indexes on the connection, one
 * index's documents queried (with sort, paging, scores and FT.EXPLAIN), its schema with the
 * FT.CREATE that rebuilds it, and its figures; a new index written field by field or
 * suggested from sample keys; an index dropped, with or without its documents.
 */

interface ToolProps {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
}

type Tab = 'query' | 'schema' | 'details';

const TYPE_TONES: Readonly<Record<string, string>> = {
  TEXT: 'bg-accent/15 text-accent',
  TAG: 'bg-success/15 text-success',
  NUMERIC: 'bg-warning/15 text-warning',
  GEO: 'bg-env-staging/15 text-env-staging',
  GEOSHAPE: 'bg-env-staging/15 text-env-staging',
  VECTOR: 'bg-env-dev/15 text-env-dev',
};

function FieldType({ type }: { readonly type: string }) {
  return (
    <span
      className={cx(
        'inline-block min-w-15 rounded px-1 text-center text-[10px] font-semibold tracking-wide',
        TYPE_TONES[type] ?? 'bg-panel-2 text-muted',
      )}
    >
      {type}
    </span>
  );
}

function Chip({ children }: { readonly children: ReactNode }) {
  return (
    <span className="rounded bg-panel-2 px-1.5 py-px font-mono text-[10px] text-muted">
      {children}
    </span>
  );
}

export function SearchPanel({ panelId, target }: ToolProps) {
  const { facts } = useConnectionFacts(target.profileId);
  const [node, setNode] = useState<string>();
  const [indexes, setIndexes] = useState<readonly string[]>();
  const [selected, setSelected] = useState<string>();
  const [info, setInfo] = useState<SearchIndexInfo>();
  const [error, setError] = useState<string>();
  const [unsupported, setUnsupported] = useState<string>();
  const [creating, setCreating] = useState<IndexDraft>();
  const [tab, setTab] = useState<Tab>('query');
  const nodeOption = node !== undefined ? { node } : {};

  const loadList = async (): Promise<void> => {
    setError(undefined);
    try {
      const list = await panelLane(panelId).run((host, sessionId) =>
        host.redis.search.list({ sessionId, ...nodeOption }),
      );
      setIndexes(list);
      setUnsupported(undefined);
      setSelected((current) =>
        current !== undefined && list.includes(current) ? current : list[0],
      );
    } catch (e) {
      if (e instanceof JoineryError && e.code === 'NOT_SUPPORTED') {
        setUnsupported(e.message);
        setIndexes([]);
      } else setError(errorMessage(e));
    }
  };

  const loadInfo = async (index: string): Promise<void> => {
    try {
      const loaded = await panelLane(panelId).run((host, sessionId) =>
        host.redis.search.info({ sessionId, index, ...nodeOption }),
      );
      setInfo(loaded);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void loadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node]);

  useEffect(() => {
    setInfo(undefined);
    if (selected !== undefined) void loadInfo(selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, node]);

  // A new index over existing keys indexes in the background: follow it.
  useEffect(() => {
    if (!info?.indexing || selected === undefined) return;
    const timer = setTimeout(() => void loadInfo(selected), 1000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info]);

  const drop = async (deleteDocuments: boolean): Promise<void> => {
    if (!info) return;
    const done = await redisWrite({
      profileId: target.profileId,
      operation: destructive(
        deleteDocuments
          ? `drops the index ${info.name} and deletes the ${formatCount(info.documents ?? 0)} documents it indexes`
          : `drops the index ${info.name}; its documents stay`,
      ),
      title: deleteDocuments ? 'Drop the index and its documents?' : 'Drop the index?',
      commands: [
        [
          utf8Bytes('FT.DROPINDEX'),
          utf8Bytes(info.name),
          ...(deleteDocuments ? [utf8Bytes('DD')] : []),
        ],
      ],
      confirmLabel: 'Drop',
      // Resolves true once done: redisWrite resolves undefined when the user declines.
      run: async (confirmed) => {
        await panelLane(panelId).run((host, sessionId) =>
          host.redis.search.drop({
            sessionId,
            index: info.name,
            deleteDocuments,
            confirmed,
            ...nodeOption,
          }),
        );
        return true;
      },
    }).catch((e: unknown) => {
      setError(errorMessage(e));
      return undefined;
    });
    if (done === undefined) return;
    setSelected(undefined);
    await loadList();
  };

  return (
    <div className="flex h-full flex-col bg-bg" data-testid="redis-search">
      <Toolbar label="Search indexes">
        <span className="px-1 text-xs font-semibold text-fg">Search indexes</span>
        <NodeSelect facts={facts} value={node} onChange={setNode} />
        <Separator />
        <Button size="sm" variant="ghost" onClick={() => void loadList()}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={unsupported !== undefined}
          onClick={() => setCreating(emptyDraft())}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          New index…
        </Button>
      </Toolbar>
      {error && (
        <Notice kind="error" onClose={() => setError(undefined)}>
          {error}
        </Notice>
      )}
      {unsupported ? (
        <Unsupported message={unsupported} />
      ) : indexes === undefined ? (
        <EmptyState>Reading the indexes…</EmptyState>
      ) : indexes.length === 0 ? (
        <NoIndexes onCreate={() => setCreating(emptyDraft())} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <ul
            aria-label="Indexes"
            className="w-60 shrink-0 overflow-auto border-r border-border bg-panel py-1"
          >
            {indexes.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className={cx(
                    'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-hover',
                    name === selected && 'bg-accent/10 shadow-[inset_2px_0_0_var(--accent)]',
                  )}
                  onClick={() => setSelected(name)}
                  data-testid="search-index"
                  aria-current={name === selected}
                >
                  <span className="w-full truncate font-mono text-[13px] text-fg">{name}</span>
                  {name === selected && info && (
                    <span className="text-[11px] text-muted">
                      {info.keyType} · {formatCount(info.documents ?? 0)} docs
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex min-w-0 flex-1 flex-col">
            {info && selected === info.name ? (
              <>
                <IndexHeader
                  info={info}
                  tab={tab}
                  onTab={setTab}
                  onDrop={(dd) => void drop(dd)}
                  onDuplicate={() => setCreating(draftFromInfo(info))}
                />
                <div className="min-h-0 flex-1 overflow-auto">
                  {tab === 'query' && (
                    <QueryTab
                      key={info.name}
                      panelId={panelId}
                      target={target}
                      info={info}
                      node={node}
                    />
                  )}
                  {tab === 'schema' && <SchemaTab info={info} />}
                  {tab === 'details' && <DetailsTab info={info} />}
                </div>
              </>
            ) : (
              <EmptyState>Reading the index…</EmptyState>
            )}
          </div>
        </div>
      )}
      {creating && (
        <CreateIndexDialog
          panelId={panelId}
          target={target}
          node={node}
          initial={creating}
          onClose={() => setCreating(undefined)}
          onCreated={async (name) => {
            setCreating(undefined);
            await loadList();
            setSelected(name);
            setTab('query');
          }}
        />
      )}
    </div>
  );
}

function draftFromInfo(info: SearchIndexInfo): IndexDraft {
  const definition = definitionOf(info);
  return {
    name: `${info.name}_copy`,
    keyType: definition.keyType,
    prefixes: definition.prefixes.join(' '),
    filter: definition.filter ?? '',
    fields: definition.fields.map((field) =>
      newField({
        identifier: field.identifier,
        attribute: field.attribute ?? '',
        type: field.type,
        sortable: field.sortable === true,
        noStem: field.noStem === true,
        weight: String(field.weight ?? 1),
        separator: field.separator ?? ',',
        caseSensitive: field.caseSensitive === true,
        ...(field.vector
          ? {
              algorithm: field.vector.algorithm,
              dim: String(field.vector.dim),
              distance: field.vector.distance,
              dataType: field.vector.dataType,
            }
          : {}),
      }),
    ),
  };
}

function Unsupported({ message }: { readonly message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-panel-2 text-muted">
          <Icon name="warning" className="h-6 w-6" />
        </span>
        <h2 className="mt-3 text-sm font-semibold text-fg">No search module here</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {message}. Redis 8 and Redis Stack include the Redis Query Engine; Valkey loads
          valkey-search.
        </p>
      </div>
    </div>
  );
}

function NoIndexes({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-md text-center">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/12 text-accent">
          <Icon name="database" className="h-6 w-6" />
        </span>
        <h2 className="mt-3 text-sm font-semibold text-fg">No search indexes yet</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          An index covers the hashes or JSON documents under a key prefix, so you can query them by
          text, tags, numbers, places and vectors. Joinery can suggest its fields from your keys.
        </p>
        <Button variant="primary" className="mt-4" onClick={onCreate}>
          <Icon name="plus" className="h-3.5 w-3.5" />
          New index…
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

function IndexHeader(props: {
  readonly info: SearchIndexInfo;
  readonly tab: Tab;
  readonly onTab: (tab: Tab) => void;
  readonly onDrop: (deleteDocuments: boolean) => void;
  readonly onDuplicate: () => void;
}) {
  const { info } = props;
  const [menu, setMenu] = useState(false);
  const percent = Math.round((info.percentIndexed ?? 1) * 100);
  return (
    <header className="border-b border-border bg-panel px-4 pt-3" data-testid="search-header">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold text-fg">{info.name}</h2>
        <Chip>{info.keyType}</Chip>
        {info.prefixes.map((prefix) => (
          <Chip key={prefix}>{prefix === '' ? '(every key)' : `${prefix}*`}</Chip>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={props.onDuplicate}>
            Duplicate…
          </Button>
          <span className="relative">
            <Button size="sm" variant="ghost" onClick={() => setMenu(!menu)} aria-expanded={menu}>
              Drop…
            </Button>
            {menu && (
              <span
                role="menu"
                className="absolute top-8 right-0 z-10 flex w-64 flex-col rounded-md border border-border bg-raised p-1 shadow-widget"
                onMouseLeave={() => setMenu(false)}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="rounded px-2 py-1.5 text-left text-xs hover:bg-hover"
                  onClick={() => {
                    setMenu(false);
                    props.onDrop(false);
                  }}
                >
                  Drop the index
                  <span className="block text-[11px] text-muted">The documents stay</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="rounded px-2 py-1.5 text-left text-xs text-danger hover:bg-danger/10"
                  onClick={() => {
                    setMenu(false);
                    props.onDrop(true);
                  }}
                >
                  Drop the index and its documents
                  <span className="block text-[11px] text-muted">FT.DROPINDEX … DD</span>
                </button>
              </span>
            )}
          </span>
        </span>
      </div>
      <p className="mt-1 text-xs text-muted tabular-nums" data-testid="search-figures">
        {formatCount(info.documents ?? 0)} documents · {formatCount(info.terms ?? 0)} terms ·{' '}
        {formatBytes(info.memoryBytes)} of index
        {info.filter !== null && (
          <>
            {' '}
            · filter <span className="font-mono text-fg">{info.filter}</span>
          </>
        )}
      </p>
      {info.indexing && (
        <div className="mt-2 flex items-center gap-2 text-xs text-muted">
          <div className="h-1.5 w-48 overflow-hidden rounded-full bg-panel-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
          </div>
          Indexing existing keys… {percent}%
        </div>
      )}
      {info.failures > 0 && (
        <p className="mt-2 text-xs text-warning">
          {formatCount(info.failures)} document{info.failures === 1 ? '' : 's'} failed to index
          {info.lastError !== null && (
            <>
              : {info.lastError}
              {info.lastErrorKey !== null && (
                <>
                  {' '}
                  (<span className="font-mono">{info.lastErrorKey}</span>)
                </>
              )}
            </>
          )}
        </p>
      )}
      <nav className="mt-2 flex gap-4 text-xs" aria-label="Index views">
        {(['query', 'schema', 'details'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={cx(
              'border-b-2 pb-2 capitalize',
              props.tab === tab
                ? 'border-accent font-medium text-fg'
                : 'border-transparent text-muted hover:text-fg',
            )}
            onClick={() => props.onTab(tab)}
            aria-pressed={props.tab === tab}
          >
            {tab === 'query'
              ? 'Query'
              : tab === 'schema'
                ? `Schema (${info.fields.length})`
                : 'Details'}
          </button>
        ))}
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------------------------------------

interface QueryState {
  readonly text: string;
  readonly sortBy: string;
  readonly descending: boolean;
  readonly limit: number;
  readonly dialect: number;
  readonly withScores: boolean;
  readonly verbatim: boolean;
  readonly noContent: boolean;
}

const PAGE_SIZES = [10, 25, 50, 100];

function QueryTab(props: {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
  readonly info: SearchIndexInfo;
  readonly node: string | undefined;
}) {
  const { info } = props;
  const [query, setQuery] = useState<QueryState>({
    text: '*',
    sortBy: '',
    descending: false,
    limit: 10,
    dialect: 2,
    withScores: false,
    verbatim: false,
    noContent: false,
  });
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState<{
    readonly total: number;
    readonly documents: readonly {
      readonly key: Uint8Array;
      readonly score: number | null;
      readonly fields: readonly (readonly [string, Uint8Array])[];
    }[];
    readonly durationMs: number;
    readonly offset: number;
  }>();
  const [explain, setExplain] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const sortable = useMemo(() => sortableFields(info), [info]);
  const nodeOption = props.node !== undefined ? { node: props.node } : {};

  const run = async (at = 0): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setExplain(undefined);
    try {
      const found = await panelLane(props.panelId).run((host, sessionId) =>
        host.redis.search.query({
          sessionId,
          index: info.name,
          query: query.text.trim() || '*',
          offset: at,
          limit: query.limit,
          dialect: query.dialect,
          ...(query.sortBy !== ''
            ? { sortBy: query.sortBy, sortDescending: query.descending }
            : {}),
          ...(query.withScores ? { withScores: true } : {}),
          ...(query.verbatim ? { verbatim: true } : {}),
          ...(query.noContent ? { noContent: true } : {}),
          ...nodeOption,
        }),
      );
      setResult({ ...found, offset: at });
      setOffset(at);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const explainQuery = async (): Promise<void> => {
    setError(undefined);
    try {
      const text = await panelLane(props.panelId).run((host, sessionId) =>
        host.redis.search.explain({
          sessionId,
          index: info.name,
          query: query.text.trim() || '*',
          dialect: query.dialect,
          ...nodeOption,
        }),
      );
      setExplain(text.trim());
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    void run(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const insert = (snippet: string): void => {
    const current = query.text.trim();
    const text = current === '' || current === '*' ? snippet : `${current} ${snippet}`;
    setQuery({ ...query, text });
    input.current?.focus();
  };

  const columns = result ? resultColumns(result.documents, info) : [];
  const set = (patch: Partial<QueryState>): void => setQuery({ ...query, ...patch });

  return (
    <div className="flex flex-col gap-3 p-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(0);
        }}
      >
        <div className="flex items-start gap-2">
          <textarea
            ref={input}
            aria-label="Query"
            rows={2}
            spellCheck={false}
            value={query.text}
            onChange={(event) => set({ text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void run(0);
              }
            }}
            className="min-h-14 flex-1 resize-y rounded border border-border bg-panel-2 px-2 py-1.5 font-mono text-[13px] text-fg focus:border-accent focus:outline-none"
            data-testid="search-query"
          />
          <div className="flex flex-col gap-1.5">
            <Button type="submit" variant="primary" disabled={busy}>
              <Icon name="play" className="h-3.5 w-3.5" />
              Search
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => void explainQuery()}>
              Explain
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            Sort by
            <span className="w-32">
              <Select
                aria-label="Sort by"
                className="h-7 text-xs"
                value={query.sortBy}
                onChange={(event) => set({ sortBy: event.target.value })}
              >
                <option value="">Relevance</option>
                {sortable.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
            </span>
          </label>
          {query.sortBy !== '' && (
            <button
              type="button"
              className="rounded border border-border px-1.5 py-0.5 text-fg hover:bg-hover"
              onClick={() => set({ descending: !query.descending })}
            >
              {query.descending ? '↓ Descending' : '↑ Ascending'}
            </button>
          )}
          <label className="flex items-center gap-1.5">
            Per page
            <span className="w-16">
              <Select
                aria-label="Per page"
                className="h-7 text-xs"
                value={query.limit}
                onChange={(event) => set({ limit: Number(event.target.value) })}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </Select>
            </span>
          </label>
          <label
            className="flex items-center gap-1.5"
            title="Query syntax version (2 for $params and vectors)"
          >
            Dialect
            <span className="w-14">
              <Select
                aria-label="Dialect"
                className="h-7 text-xs"
                value={query.dialect}
                onChange={(event) => set({ dialect: Number(event.target.value) })}
              >
                {[1, 2, 3, 4].map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </Select>
            </span>
          </label>
          {(
            [
              ['withScores', 'Scores'],
              ['verbatim', 'No stemming'],
              ['noContent', 'Keys only'],
            ] as const
          ).map(([name, label]) => (
            <label key={name} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={query[name]}
                onChange={(event) => set({ [name]: event.target.checked })}
                className="accent-[var(--accent)]"
              />
              {label}
            </label>
          ))}
        </div>
        {info.fields.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted">
            <span className="mr-1">Add</span>
            {info.fields.map((field) => (
              <button
                key={field.attribute}
                type="button"
                className="rounded border border-border px-1.5 py-0.5 font-mono hover:border-accent hover:text-fg"
                title={`Insert a ${field.type} clause`}
                onClick={() => insert(querySnippet(field.attribute, field.type))}
              >
                @{field.attribute}
              </button>
            ))}
          </div>
        )}
      </form>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-xs text-danger"
        >
          {error}
        </div>
      )}
      {explain !== undefined && (
        <section className="rounded-lg border border-border bg-panel">
          <header className="flex items-center justify-between border-b border-border px-3 py-1.5">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
              How the engine reads it
            </h3>
            <button
              type="button"
              className="text-xs text-muted hover:text-fg"
              onClick={() => setExplain(undefined)}
            >
              Close
            </button>
          </header>
          <pre className="overflow-auto p-3 font-mono text-xs text-fg" data-testid="search-explain">
            {explain}
          </pre>
        </section>
      )}

      {result && (
        <section className="rounded-lg border border-border bg-panel" data-testid="search-results">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
            <span className="font-medium text-fg" data-testid="search-total">
              {formatCount(result.total)} document{result.total === 1 ? '' : 's'} match
            </span>
            <span className="text-muted">
              {result.documents.length > 0 &&
                `· showing ${formatCount(result.offset + 1)}–${formatCount(result.offset + result.documents.length)}`}{' '}
              · {result.durationMs} ms
            </span>
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || offset === 0}
                onClick={() => void run(Math.max(0, offset - query.limit))}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || offset + query.limit >= result.total}
                onClick={() => void run(offset + query.limit)}
              >
                Next
              </Button>
            </span>
          </header>
          {result.documents.length === 0 ? (
            <p className="p-4 text-center text-xs text-muted">Nothing matches.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" aria-label="Documents">
                <thead className="text-left text-[11px] text-muted uppercase">
                  <tr className="border-b border-border">
                    <th className="px-3 py-1.5 font-semibold">Key</th>
                    {result.documents.some((d) => d.score !== null) && (
                      <th className="px-3 py-1.5 text-right font-semibold">Score</th>
                    )}
                    {columns.map((name) => (
                      <th key={name} className="px-3 py-1.5 font-semibold normal-case">
                        {name === '$' ? 'Document' : name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.documents.map((document, i) => {
                    const values = new Map(document.fields.map(([name, value]) => [name, value]));
                    return (
                      <tr
                        key={i}
                        className="border-b border-border/50 align-top last:border-0 hover:bg-hover"
                        data-testid="search-document"
                      >
                        <td className="px-3 py-1.5 whitespace-nowrap">
                          <button
                            type="button"
                            className="font-mono text-accent hover:underline"
                            title="Open the key"
                            onClick={() =>
                              openRedisPanel({
                                profileId: props.target.profileId,
                                profileName: props.target.profileName,
                                tool: 'value',
                                key: document.key,
                                ...(props.target.database !== undefined
                                  ? { database: props.target.database }
                                  : {}),
                              })
                            }
                          >
                            {displayBytes(document.key)}
                          </button>
                        </td>
                        {result.documents.some((d) => d.score !== null) && (
                          <td className="px-3 py-1.5 text-right text-muted tabular-nums">
                            {document.score === null ? '' : document.score.toFixed(3)}
                          </td>
                        )}
                        {columns.map((name) => {
                          const value = values.get(name);
                          const text = value === undefined ? '' : displayBytes(value);
                          return (
                            <td
                              key={name}
                              className={cx(
                                'max-w-80 truncate px-3 py-1.5',
                                name === '$' && 'font-mono text-[11px]',
                              )}
                              title={text.length > 60 ? text.slice(0, 2000) : undefined}
                            >
                              {value === undefined ? <span className="text-muted">—</span> : text}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <SyntaxHelp />
    </div>
  );
}

function SyntaxHelp() {
  const rows: readonly (readonly [string, string])[] = [
    ['dune', 'words in any TEXT field'],
    ['@title:dune', 'in one field; @title:(dune|emma) either'],
    ['@tags:{scifi | classic}', 'TAG values'],
    ['@year:[1900 2000]', 'a numeric range; (1900 excludes, +inf, -inf'],
    ['@loc:[13.4 52.5 10 km]', 'within a radius of a point'],
    ['-@tags:{romance}', 'not'],
    ['*=>[KNN 5 @emb $vec]', 'nearest vectors (dialect 2)'],
  ];
  return (
    <details className="rounded-lg border border-border bg-panel text-xs">
      <summary className="cursor-pointer px-3 py-1.5 text-muted hover:text-fg">
        Query syntax
      </summary>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-3 pb-3">
        {rows.map(([example, meaning]) => (
          <div key={example} className="contents">
            <dt className="font-mono text-fg">{example}</dt>
            <dd className="text-muted">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

// ---------------------------------------------------------------------------------------------

function SchemaTab({ info }: { readonly info: SearchIndexInfo }) {
  const [copied, setCopied] = useState(false);
  const create = commandLine('FT.CREATE', searchCreateArgs(definitionOf(info)));
  return (
    <div className="flex flex-col gap-3 p-4">
      <section className="rounded-lg border border-border bg-panel">
        <table className="w-full text-xs" aria-label="Fields">
          <thead className="text-left text-[11px] text-muted uppercase">
            <tr className="border-b border-border">
              <th className="px-3 py-1.5 font-semibold">Name</th>
              <th className="px-3 py-1.5 font-semibold">
                {info.keyType === 'JSON' ? 'Path' : 'Hash field'}
              </th>
              <th className="px-3 py-1.5 font-semibold">Type</th>
              <th className="px-3 py-1.5 font-semibold">Options</th>
            </tr>
          </thead>
          <tbody>
            {info.fields.map((field) => (
              <tr
                key={field.attribute}
                className="border-b border-border/50 last:border-0"
                data-testid="search-field"
              >
                <td className="px-3 py-1.5 font-mono text-fg">@{field.attribute}</td>
                <td className="px-3 py-1.5 font-mono text-muted">{field.identifier}</td>
                <td className="px-3 py-1.5">
                  <FieldType type={field.type} />
                </td>
                <td className="px-3 py-1.5">
                  <span className="flex flex-wrap gap-1">
                    {field.flags.map((flag) => (
                      <Chip key={flag}>{flag}</Chip>
                    ))}
                    {Object.entries(field.options)
                      .filter(([name, value]) => !(name === 'WEIGHT' && value === '1'))
                      .map(([name, value]) => (
                        <Chip key={name}>
                          {name.replace(/^index\./, '')} {value === '' ? '""' : value}
                        </Chip>
                      ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="rounded-lg border border-border bg-panel">
        <header className="flex items-center justify-between border-b border-border px-3 py-1.5">
          <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">
            The command that creates it
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              copyToClipboard(create);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            <Icon name={copied ? 'check' : 'copy'} className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </header>
        <pre
          className="overflow-auto p-3 font-mono text-xs whitespace-pre-wrap text-fg"
          data-testid="search-create-command"
        >
          {create}
        </pre>
      </section>
    </div>
  );
}

function DetailsTab({ info }: { readonly info: SearchIndexInfo }) {
  return (
    <div className="p-4">
      <section className="rounded-lg border border-border bg-panel">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 p-3 text-xs">
          {info.stats.map(([name, value]) => (
            <div key={name} className="contents">
              <dt className="font-mono text-muted">{name}</dt>
              <dd className="font-mono text-fg tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const FIELD_TYPES: readonly SearchFieldType[] = [
  'TEXT',
  'TAG',
  'NUMERIC',
  'GEO',
  'VECTOR',
  'GEOSHAPE',
];

function CreateIndexDialog(props: {
  readonly panelId: string;
  readonly target: RedisPanelTarget;
  readonly node: string | undefined;
  readonly initial: IndexDraft;
  readonly onClose: () => void;
  readonly onCreated: (name: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<IndexDraft>(props.initial);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const checked = definitionOfDraft(draft);
  const preview = createPreview(draft);
  const nodeOption = props.node !== undefined ? { node: props.node } : {};

  const update = (patch: Partial<IndexDraft>): void => {
    setDraft({ ...draft, ...patch });
    setError(undefined);
  };
  const updateField = (id: number, patch: Partial<FieldDraft>): void =>
    update({
      fields: draft.fields.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    });

  const suggest = async (): Promise<void> => {
    const prefix = splitPrefixes(draft.prefixes)[0] ?? '';
    setBusy('Reading sample keys…');
    setHint(undefined);
    try {
      const suggestions = await panelLane(props.panelId).run((host, sessionId) =>
        host.redis.search.suggest({
          sessionId,
          keyType: draft.keyType,
          prefix,
          sample: 50,
          ...nodeOption,
        }),
      );
      if (suggestions.length === 0) {
        setHint(
          `No ${draft.keyType === 'JSON' ? 'JSON documents' : 'hashes'} found under ${prefix === '' ? 'any prefix' : `${prefix}*`}`,
        );
      } else {
        update({ fields: mergeSuggestions(draft.fields, suggestions) });
        setHint(
          `Suggested from the keys under ${prefix === '' ? 'every prefix' : `${prefix}*`}; check each type`,
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  const create = async (): Promise<void> => {
    if (!('definition' in checked)) return;
    const definition = checked.definition;
    setBusy('Creating…');
    try {
      const done = await redisWrite({
        profileId: props.target.profileId,
        operation: WRITE,
        title: 'Create the search index?',
        commands: [['FT.CREATE', ...searchCreateArgs(definition)].map(utf8Bytes)],
        confirmLabel: 'Create',
        // Resolves true once done: redisWrite resolves undefined when the user declines.
        run: async (confirmed) => {
          await panelLane(props.panelId).run((host, sessionId) =>
            host.redis.search.create({ sessionId, definition, confirmed, ...nodeOption }),
          );
          return true;
        },
      });
      if (done === undefined) return;
      await props.onCreated(definition.name);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && busy === undefined && props.onClose()}
      title="New search index"
      width="w-[880px]"
      footer={
        <>
          {'problem' in checked && (
            <span className="mr-auto text-xs text-muted" data-testid="search-create-problem">
              {checked.problem}
            </span>
          )}
          <Button onClick={props.onClose} disabled={busy !== undefined}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy !== undefined || !('definition' in checked)}
            onClick={() => void create()}
            data-testid="search-create"
          >
            {busy === 'Creating…' ? 'Creating…' : 'Create index'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-[13px]" data-testid="search-create-dialog">
        <div className="grid grid-cols-[1fr_auto] gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Name</span>
            <Input
              aria-label="Index name"
              className="font-mono"
              value={draft.name}
              placeholder="idx_products"
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Indexes</span>
            <div
              role="radiogroup"
              aria-label="Key type"
              className="flex overflow-hidden rounded border border-border"
            >
              {(['HASH', 'JSON'] as SearchKeyType[]).map((type) => (
                <button
                  key={type}
                  type="button"
                  role="radio"
                  aria-checked={draft.keyType === type}
                  className={cx(
                    'h-8 px-3 text-xs',
                    draft.keyType === type
                      ? 'bg-accent text-white'
                      : 'bg-panel-2 text-muted hover:text-fg',
                  )}
                  onClick={() => update({ keyType: type })}
                >
                  {type === 'HASH' ? 'Hashes' : 'JSON documents'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Key prefixes</span>
            <Input
              aria-label="Key prefixes"
              className="font-mono"
              value={draft.prefixes}
              placeholder="product:  (empty: every key)"
              onChange={(event) => update({ prefixes: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-muted">Filter (optional)</span>
            <Input
              aria-label="Filter"
              className="font-mono"
              value={draft.filter}
              placeholder="@price > 0"
              onChange={(event) => update({ filter: event.target.value })}
            />
          </label>
        </div>

        <section aria-label="Fields" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-[11px] font-semibold tracking-wide text-muted uppercase">Fields</h3>
            <span className="ml-auto flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== undefined}
                onClick={() => void suggest()}
              >
                {busy === 'Reading sample keys…' ? busy : 'Suggest from keys'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  update({
                    fields: [
                      ...draft.fields,
                      newField(draft.keyType === 'JSON' ? { identifier: '$.' } : {}),
                    ],
                  })
                }
              >
                <Icon name="plus" className="h-3.5 w-3.5" />
                Add field
              </Button>
            </span>
          </div>
          {hint && <p className="text-xs text-muted">{hint}</p>}
          {draft.fields.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted">
              Add fields one by one, or let Joinery suggest them from the keys under the prefix.
            </p>
          ) : (
            <div className="max-h-80 overflow-auto rounded-md border border-border">
              <table className="w-full text-xs" aria-label="Index fields">
                <thead className="sticky top-0 bg-panel text-left text-[11px] text-muted uppercase">
                  <tr>
                    <th className="px-2 py-1.5 font-semibold">
                      {draft.keyType === 'JSON' ? 'Path' : 'Field'}
                    </th>
                    <th className="px-2 py-1.5 font-semibold">Query name</th>
                    <th className="px-2 py-1.5 font-semibold">Type</th>
                    <th className="px-2 py-1.5 font-semibold">Options</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.fields.map((field) => (
                    <FieldRow
                      key={field.id}
                      field={field}
                      json={draft.keyType === 'JSON'}
                      onChange={(patch) => updateField(field.id, patch)}
                      onRemove={() =>
                        update({ fields: draft.fields.filter((f) => f.id !== field.id) })
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
            Sends
          </h3>
          <pre
            className="max-h-28 overflow-auto rounded-md bg-panel-2 p-2 font-mono text-[11px] whitespace-pre-wrap text-fg"
            data-testid="search-create-preview"
          >
            {preview ?? '—'}
          </pre>
        </section>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

function FieldRow(props: {
  readonly field: FieldDraft;
  readonly json: boolean;
  readonly onChange: (patch: Partial<FieldDraft>) => void;
  readonly onRemove: () => void;
}) {
  const { field } = props;
  const small =
    'h-7 rounded border border-border bg-panel-2 px-1.5 text-xs text-fg focus:border-accent focus:outline-none';
  const check = (name: 'sortable' | 'noStem' | 'caseSensitive', label: string): ReactNode => (
    <label className="flex items-center gap-1 whitespace-nowrap">
      <input
        type="checkbox"
        checked={field[name]}
        onChange={(event) => props.onChange({ [name]: event.target.checked })}
        className="accent-[var(--accent)]"
      />
      {label}
    </label>
  );
  return (
    <tr className="border-t border-border/50 align-middle" data-testid="search-field-row">
      <td className="px-2 py-1">
        <input
          aria-label="Field"
          className={cx(small, 'w-44 font-mono')}
          value={field.identifier}
          onChange={(event) => props.onChange({ identifier: event.target.value })}
        />
        {field.example !== undefined && (
          <span
            className="mt-0.5 block max-w-44 truncate text-[10px] text-muted"
            title={field.example}
          >
            e.g. {field.example} · in {field.seen}
          </span>
        )}
      </td>
      <td className="px-2 py-1">
        <input
          aria-label="Query name"
          className={cx(small, 'w-32 font-mono')}
          value={field.attribute}
          placeholder={props.json ? 'required' : 'same'}
          onChange={(event) => props.onChange({ attribute: event.target.value })}
        />
      </td>
      <td className="px-2 py-1">
        <select
          aria-label="Type"
          className={cx(small, 'w-24')}
          value={field.type}
          onChange={(event) => props.onChange({ type: event.target.value as SearchFieldType })}
        >
          {FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </td>
      <td className="px-2 py-1">
        <span className="flex flex-wrap items-center gap-2 text-muted">
          {field.type === 'TEXT' && (
            <>
              <label className="flex items-center gap-1">
                Weight
                <input
                  aria-label="Weight"
                  className={cx(small, 'w-12')}
                  value={field.weight}
                  onChange={(event) => props.onChange({ weight: event.target.value })}
                />
              </label>
              {check('noStem', 'No stemming')}
            </>
          )}
          {field.type === 'TAG' && (
            <>
              <label className="flex items-center gap-1">
                Separator
                <input
                  aria-label="Separator"
                  className={cx(small, 'w-8 text-center font-mono')}
                  maxLength={1}
                  value={field.separator}
                  onChange={(event) => props.onChange({ separator: event.target.value })}
                />
              </label>
              {check('caseSensitive', 'Case-sensitive')}
            </>
          )}
          {field.type === 'VECTOR' && (
            <>
              <select
                aria-label="Algorithm"
                className={small}
                value={field.algorithm}
                onChange={(event) =>
                  props.onChange({ algorithm: event.target.value as FieldDraft['algorithm'] })
                }
              >
                <option value="HNSW">HNSW</option>
                <option value="FLAT">FLAT</option>
              </select>
              <input
                aria-label="Dimension"
                className={cx(small, 'w-16')}
                placeholder="dim"
                value={field.dim}
                onChange={(event) => props.onChange({ dim: event.target.value })}
              />
              <select
                aria-label="Distance"
                className={small}
                value={field.distance}
                onChange={(event) =>
                  props.onChange({ distance: event.target.value as FieldDraft['distance'] })
                }
              >
                {VECTOR_DISTANCES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <select
                aria-label="Element type"
                className={small}
                value={field.dataType}
                onChange={(event) =>
                  props.onChange({ dataType: event.target.value as FieldDraft['dataType'] })
                }
              >
                {VECTOR_DATA_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </>
          )}
          {field.type !== 'VECTOR' && field.type !== 'GEOSHAPE' && check('sortable', 'Sortable')}
        </span>
      </td>
      <td className="px-1 py-1 text-right">
        <button
          type="button"
          aria-label={`Remove ${field.identifier || 'field'}`}
          className="rounded p-1 text-muted hover:bg-hover hover:text-danger"
          onClick={props.onRemove}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      </td>
    </tr>
  );
}
