import { DropdownMenu } from 'radix-ui';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { formatCount } from '../../lib/format';
import type { CodeExportRequest } from '../../state/mongo/code-export';
import {
  useCollectionState,
  type CollectionView,
  type ViewTab,
} from '../../state/mongo/collection-view';
import { QUERY_FIELDS, type QueryField } from '../../state/mongo/query-bar';
import { useQueryBuilder, type QueryEditorMode } from '../../state/mongo/query-builder';
import { useResults } from '../../state/mongo/results';
import { useTheme } from '../theme';
import { Button, Icon, cx } from '../ui';
import { MenuItem } from '../MenuItem';
import { Pager } from '../Pager';
import { ViewModeSwitch, type ViewModeOption } from '../ViewModeSwitch';
import { DOCUMENT_PAGE_SIZES, queryTotal } from '../../state/mongo/pages';
import { CodeExportDialog } from './CodeExportDialog';
import { BulkDialog, DocumentEditorDialog } from './DocumentDialogs';
import { ExplainView } from './ExplainView';
import { openMongoSql, openMongoTool } from './open';
import { Segmented } from './parts';
import { QueryBuilderPanel } from './QueryBuilderPanel';
import { ResultViews } from './ResultViews';
import { ShellEditor } from './ShellEditor';

/**
 * A collection view (spec §9, "Browsing and editing"): the query bar (fields or the visual
 * builder, and the find() text, kept in step), the documents as a tree, a table or JSON, explain,
 * the document editor, and bulk update and delete by the current filter. A footer shows how many
 * documents are loaded, the collection's estimated size and the exact count on demand.
 */
export function CollectionPanel({ view }: { readonly view: CollectionView }) {
  const theme = useTheme();
  const tab = useCollectionState(view, (s) => s.tab);
  const notice = useCollectionState(view, (s) => s.notice);
  const readOnlyProfile = useCollectionState(view, (s) => s.readOnlyProfile);
  const production = useCollectionState(view, (s) => s.production);
  const active = useCollectionState(view, (s) => s.active);
  const explain = useCollectionState(view, (s) => s.explain);
  const running = useCollectionState(view, (s) => s.running);
  const writable = view.target.kind !== 'view' && !readOnlyProfile;
  const editable = writable && active?.projection === undefined;
  const { db, collection } = view.target;
  const [exporting, setExporting] = useState<CodeExportRequest | undefined>();

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-collection-panel"
      aria-label={`${db}.${collection} documents`}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Collection"
      >
        <Button
          size="sm"
          variant="primary"
          onClick={() => void view.run()}
          disabled={running}
          title="Run the query (Ctrl/Cmd+Enter)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Run
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void view.reset()} title="Clear the query">
          <Icon name="restore" className="h-3.5 w-3.5" />
          Reset
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.explain('executionStats')}
          title="Run the query and show its plan with execution statistics"
        >
          <Icon name="gauge" className="h-3.5 w-3.5" />
          Explain
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.explain('queryPlanner')}
          title="Show the chosen plan without running the query"
        >
          <Icon name="diagram" className="h-3.5 w-3.5" />
          Plan only
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setExporting(view.exportRequest())}
          title="Export the query as Node.js, Python, Java, C#, Go or PHP code"
        >
          <Icon name="export" className="h-3.5 w-3.5" />
          Export code…
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!writable}
          onClick={() => view.openEditor('insert')}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Insert
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!writable}
          onClick={() => view.openBulk('update')}
        >
          <Icon name="edit" className="h-3.5 w-3.5" />
          Bulk update…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          disabled={!writable}
          onClick={() => view.openBulk('delete')}
        >
          <Icon name="trash" className="h-3.5 w-3.5" />
          Bulk delete…
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <CollectionTools view={view} />
        <span className="flex-1" />
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
          {view.target.kind === 'view'
            ? ' (view)'
            : view.target.kind === 'time-series'
              ? ' (time series)'
              : ''}
        </span>
      </div>
      <QueryBar view={view} theme={theme} />
      {readOnlyProfile && (
        <Banner kind="info">
          This connection is read-only: documents can be viewed and copied, not changed.
        </Banner>
      )}
      {!readOnlyProfile && view.target.kind === 'view' && (
        <Banner kind="info">A view is read-only: its documents come from a pipeline.</Banner>
      )}
      {production && writable && (
        <Banner kind="warning">Production connection: every change asks before it runs.</Banner>
      )}
      {writable && active?.projection !== undefined && (
        <Banner kind="info">
          Read with a projection: clear it to edit or clone whole documents.
        </Banner>
      )}
      {notice && (
        <Banner
          kind={notice.kind === 'error' ? 'error' : 'info'}
          testId="mongo-notice"
          onDismiss={() => view.dismissNotice()}
        >
          {notice.text}
        </Banner>
      )}
      <div className="min-h-0 flex-1">
        {tab === 'explain' ? (
          <ExplainView explain={explain} />
        ) : (
          <ResultViews
            results={view.results}
            {...(writable
              ? {
                  actions: {
                    ...(editable
                      ? {
                          edit: (index: number) => view.openEditor('edit', index),
                          clone: (index: number) => view.openEditor('clone', index),
                        }
                      : {}),
                    remove: (index: number) => void view.deleteDocument(index),
                  },
                }
              : {})}
          />
        )}
      </div>
      <Footer view={view} />
      <DocumentEditorDialog view={view} theme={theme} />
      <BulkDialog view={view} theme={theme} />
      <CodeExportDialog request={exporting} onClose={() => setExporting(undefined)} />
    </div>
  );
}

/**
 * The collection's tools under one menu: aggregation (from the current filter), SQL, indexes,
 * schema analysis, options and the change stream, each with its glyph and what it does.
 */
function CollectionTools({ view }: { readonly view: CollectionView }) {
  const { profileId, db, collection, kind } = view.target;
  const target = { profileId, db, collection };
  const filter = useCollectionState(view, (s) => s.fields.filter);
  const item = (label: string, hint: string) => (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      <span className="text-[11px] text-faint">{hint}</span>
    </span>
  );
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" title="Aggregation, SQL, indexes, schema, options, watch">
          <Icon name="wrench" className="h-3.5 w-3.5" />
          Tools
          <Icon name="chevron-down" className="h-3 w-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          aria-label="Collection tools"
          className="z-50 min-w-64 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          <MenuItem
            icon="filter"
            onSelect={() =>
              openMongoTool({
                tool: 'aggregation',
                target: {
                  ...target,
                  ...(filter.trim() !== '' ? { text: `[{ $match: ${filter.trim()} }]` } : {}),
                },
              })
            }
          >
            {item('Aggregate', 'A pipeline, starting from the current filter')}
          </MenuItem>
          <MenuItem icon="query" onSelect={() => openMongoSql({ profileId, db, collection })}>
            {item('SQL', 'Query the collection with SQL in a new tab')}
          </MenuItem>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {kind !== 'view' && (
            <MenuItem icon="key" onSelect={() => openMongoTool({ tool: 'indexes', target })}>
              {item('Indexes', 'Create, hide and drop indexes')}
            </MenuItem>
          )}
          <MenuItem
            icon="chart"
            onSelect={() => openMongoTool({ tool: 'schema', target: { ...target, kind } })}
          >
            {item('Schema', 'The fields, their types and how often they occur')}
          </MenuItem>
          <MenuItem icon="design" onSelect={() => openMongoTool({ tool: 'options', target })}>
            {item('Options', 'Validation, collation and the collection’s settings')}
          </MenuItem>
          {kind !== 'view' && (
            <MenuItem
              icon="pulse"
              onSelect={() =>
                openMongoTool({
                  tool: 'changes',
                  target: { profileId, scope: { kind: 'collection', ns: { db, collection } } },
                })
              }
            >
              {item('Watch', 'Follow inserts, updates and deletes as they happen')}
            </MenuItem>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const LABELS: Readonly<Record<QueryField, string>> = {
  filter: 'Filter',
  projection: 'Projection',
  sort: 'Sort',
  skip: 'Skip',
  limit: 'Limit',
};

const PLACEHOLDERS: Readonly<Record<QueryField, string>> = {
  filter: "{ status: 'shipped', total: { $gt: 100 } }",
  projection: '{ name: 1, total: 1 }',
  sort: '{ total: -1 }',
  skip: '0',
  limit: '0',
};

const EDITOR_MODES: readonly { readonly value: QueryEditorMode; readonly label: string }[] = [
  { value: 'fields', label: 'Fields' },
  { value: 'builder', label: 'Builder' },
];

function QueryBar(props: { readonly view: CollectionView; readonly theme: 'dark' | 'light' }) {
  const { view } = props;
  const mode = useQueryBuilder(view.builder, (s) => s.mode);
  const fields = useCollectionState(view, (s) => s.fields);
  const issues = useCollectionState(view, (s) => s.issues);
  const findText = useCollectionState(view, (s) => s.findText);
  const findIssue = useCollectionState(view, (s) => s.findIssue);
  const inputs = useRef<Partial<Record<QueryField, HTMLInputElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void view.run();
    }
  };
  /** Puts the caret where the parser stopped. */
  const reveal = (field: QueryField, offset: number): void => {
    const input = inputs.current[field];
    input?.focus();
    input?.setSelectionRange(offset, offset + 1);
  };
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-border bg-panel px-2 py-1.5"
      data-testid="mongo-query-bar"
    >
      <div className="flex items-center gap-2">
        <Segmented
          label="Query editor"
          value={mode}
          options={EDITOR_MODES}
          onChange={(next) => view.builder.setMode(next)}
        />
        <span className="text-[11px] text-muted">
          {mode === 'builder'
            ? 'Drag fields into the filter, projection or sort, or use a field’s + menu'
            : 'Filter, projection and sort in mongosh syntax'}
        </span>
      </div>
      {mode === 'builder' && <QueryBuilderPanel view={view} />}
      <div
        className={cx(
          'grid grid-cols-[3fr_2fr_2fr_5rem_5rem] gap-1.5',
          mode === 'builder' && 'hidden',
        )}
      >
        {QUERY_FIELDS.map((field) => {
          const issue = issues[field];
          const id = `${view.id}-${field}`;
          return (
            <div key={field} className="flex min-w-0 flex-col gap-0.5">
              <label htmlFor={id} className="text-[11px] font-medium text-muted">
                {LABELS[field]}
              </label>
              <input
                id={id}
                ref={(element) => {
                  inputs.current[field] = element;
                }}
                value={fields[field]}
                placeholder={PLACEHOLDERS[field]}
                spellCheck={false}
                aria-invalid={issue !== undefined}
                data-testid={`mongo-${field}`}
                className={cx(
                  'h-7 w-full rounded border border-border bg-panel-2 px-2 font-mono text-xs text-fg',
                  'placeholder:text-muted/60 focus:border-accent focus:outline-none',
                  'aria-[invalid=true]:border-danger',
                )}
                onChange={(event) => view.setField(field, event.target.value)}
                onKeyDown={onKeyDown}
              />
              {issue && (
                <button
                  type="button"
                  role="alert"
                  data-testid={`mongo-${field}-issue`}
                  className="truncate text-left text-[11px] text-danger hover:underline"
                  title={issue.message}
                  onClick={() => reveal(field, issue.offset)}
                >
                  {issue.message} (column {issue.column})
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-medium text-muted">find() — edit it here too</span>
        <div className="h-[46px] rounded border border-border">
          <ShellEditor
            value={findText}
            onChange={(text) => view.setFindText(text)}
            theme={props.theme}
            issue={findIssue}
            onRun={() => void view.run()}
            ariaLabel="find() text"
            testId="mongo-find-text"
          />
        </div>
        {findIssue && (
          <p role="alert" className="text-[11px] text-danger" data-testid="mongo-find-issue">
            {findIssue.message} (line {findIssue.line}, column {findIssue.column})
          </p>
        )}
      </div>
    </div>
  );
}

const VIEW_TABS: readonly ViewModeOption<ViewTab>[] = [
  { value: 'tree', label: 'Tree', icon: 'view-tree' },
  { value: 'table', label: 'Table', icon: 'view-grid' },
  { value: 'json', label: 'JSON', icon: 'view-json' },
  { value: 'explain', label: 'Explain', icon: 'gauge' },
];

function Footer({ view }: { readonly view: CollectionView }) {
  const tab = useCollectionState(view, (s) => s.tab);
  const loaded = useResults(view.results, (s) => s.documents.length);
  const loading = useResults(view.results, (s) => s.loading);
  const estimate = useCollectionState(view, (s) => s.estimate);
  const exactCount = useCollectionState(view, (s) => s.exactCount);
  const counting = useCollectionState(view, (s) => s.counting);
  const durationMs = useCollectionState(view, (s) => s.durationMs);
  const filtered = useCollectionState(
    view,
    (s) => s.active !== undefined && Object.keys(s.active.filter).length > 0,
  );
  const page = useCollectionState(view, (s) => s.page);
  const pageSize = useCollectionState(view, (s) => s.pageSize);
  const hasNext = useCollectionState(view, (s) => s.hasNext);
  const running = useCollectionState(view, (s) => s.running);
  const active = useCollectionState(view, (s) => s.active);
  // The first page holds every document: the total is known without counting.
  const complete = page === 1 && !hasNext && !loading;
  // Documents the query returns, within its own skip and limit, once counted.
  const total =
    exactCount !== undefined && active !== undefined
      ? queryTotal(exactCount, active)
      : complete && !filtered
        ? loaded
        : undefined;
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-panel px-2 py-1 text-xs">
      <span data-testid="mongo-loaded" aria-live="polite">
        {formatCount(loaded)} {loaded === 1 ? 'document' : 'documents'} loaded
      </span>
      {loading && <span className="text-muted">· loading…</span>}

      <span className="text-muted" data-testid="mongo-total">
        ·{' '}
        {exactCount !== undefined
          ? `${formatCount(exactCount)} ${filtered ? 'matching' : 'in total'}`
          : complete && !filtered
            ? `${formatCount(loaded)} in total`
            : estimate === undefined
              ? 'estimating…'
              : estimate === null
                ? 'size unknown'
                : `≈ ${formatCount(estimate)} in the collection`}
      </span>
      {counting ? (
        <Button size="sm" variant="ghost" onClick={() => view.cancelCount()}>
          Counting… Cancel
        </Button>
      ) : (
        exactCount === undefined &&
        !(complete && !filtered) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void view.countExactly()}
            data-testid="mongo-count"
          >
            {filtered ? 'Count matches' : 'Count exactly'}
          </Button>
        )
      )}
      <span className="flex-1" />
      {durationMs !== undefined && (
        <span className="text-muted">first page in {durationMs} ms</span>
      )}
      <Pager
        page={page}
        pageSize={pageSize}
        pageSizes={DOCUMENT_PAGE_SIZES}
        hasNext={hasNext}
        total={total}
        busy={running || loading || counting}
        noun="documents"
        testId="mongo"
        onMove={(move) => void view.goToPage(move)}
        onPageSize={(size) => void view.setPageSize(size)}
      />
      <ViewModeSwitch options={VIEW_TABS} value={tab} onChange={(next) => view.setTab(next)} />
    </footer>
  );
}

function Banner(props: {
  readonly kind: 'info' | 'warning' | 'error';
  readonly children: ReactNode;
  readonly testId?: string;
  readonly onDismiss?: () => void;
}) {
  return (
    <div
      role={props.kind === 'error' ? 'alert' : 'status'}
      data-testid={props.testId}
      className={cx(
        'flex items-center gap-2 border-b px-3 py-1 text-xs',
        props.kind === 'error' && 'border-danger/40 bg-danger/10 text-danger',
        props.kind === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
        props.kind === 'info' && 'border-border bg-panel-2 text-fg',
      )}
    >
      {props.kind !== 'info' && <Icon name="warning" className="h-3.5 w-3.5" />}
      <span className="flex flex-1 flex-wrap items-center gap-2">{props.children}</span>
      {props.onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          className="rounded p-0.5 hover:bg-hover"
          onClick={props.onDismiss}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
