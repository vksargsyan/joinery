import type { DataEditorRef, GridSelection } from '@glideapps/glide-data-grid';
import { allColumnsIdentity, type ChangePlan } from '@joinery/table-data';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { formatCount, formatRows } from '../../lib/format';
import { confirm } from '../../state/dialogs';
import { naturalLayout } from '../../state/grid-layout';
import {
  cellErrorKey,
  formatStat,
  selectionStats,
  type RowRef,
} from '../../state/table/grid-model';
import { PAGE_SIZES } from '../../state/table/paging';
import { getTableView, useTableState, type TableView, type ViewMode } from '../../state/table-view';
import { openTableData } from '../dock';
import { useTheme } from '../theme';
import { Button, Icon, cx, type IconName } from '../ui';
import { ViewModeSwitch, type ViewModeOption } from '../ViewModeSwitch';
import { ApplyDialog } from './ApplyDialog';
import { ColumnsPopover } from './ColumnMenus';
import { FilterBar } from './FilterBar';
import { FormView, JsonView } from './RecordViews';
import { EMPTY_SELECTION, TableGrid, selectedColumns, selectedRows, useChanges } from './TableGrid';
import { ViewPicker } from './ViewPicker';

/**
 * A table data view (spec §7): toolbar, filter bar, the rows as a grid, a form or JSON, and a
 * footer with the row count and the selection's figures. Staged edits, inserts and deletes wait
 * for Apply, which shows the SQL first.
 */
export function TableDataPanel(props: { readonly panelId: string }) {
  const view = getTableView(props.panelId);
  if (!view) return <p className="p-4 text-sm text-muted">This view was closed.</p>;
  return <TableDataView view={view} />;
}

/** Cells the footer adds up at most, so a huge selection stays responsive. */
const MAX_STAT_CELLS = 200_000;

function TableDataView({ view }: { readonly view: TableView }) {
  const theme = useTheme();
  const status = useTableState(view, (s) => s.status);
  const error = useTableState(view, (s) => s.error);
  const notice = useTableState(view, (s) => s.notice);
  const viewMode = useTableState(view, (s) => s.viewMode);
  const identity = useTableState(view, (s) => s.identity);
  const keyIdentity = useTableState(view, (s) => s.keyIdentity);
  const readOnlyProfile = useTableState(view, (s) => s.readOnlyProfile);
  const stale = useTableState(view, (s) => s.stale);
  const columns = useTableState(view, (s) => s.columns);
  const applying = useTableState(view, (s) => s.applying);
  const layout = useTableState(view, (s) => s.layout);
  const changes = useChanges(view);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const gridRef = useRef<DataEditorRef>(null);
  const [plan, setPlan] = useState<ChangePlan>();
  const counts = changes.counts;
  const pending = counts.edited + counts.inserted + counts.deleted;
  const editable = status === 'ready' && identity.kind !== 'none' && !readOnlyProfile;

  const selectedRefs = (): RowRef[] =>
    selectedRows(selection)
      .map((row) => view.rowAt(row))
      .filter((ref): ref is RowRef => ref !== undefined);

  /** `column` is a grid (display) position. */
  const openReferenced = (row: number, column: number): void => {
    const ref = view.rowAt(row);
    const index = view.modelColumn(column);
    const name = index === undefined ? undefined : columns[index]?.name;
    if (!ref || name === undefined) return;
    for (const fk of view.foreignKeysOf(name)) {
      const target = view.referencedRow(ref, fk);
      if (target) {
        openTableData(target.target, { filter: target.filter });
        return;
      }
    }
  };

  const startApply = (): void => {
    const planned = view.planApply();
    if ('error' in planned) view.store.setState({ notice: { kind: 'error', text: planned.error } });
    else setPlan(planned.plan);
  };

  const acceptAllColumns = async (): Promise<void> => {
    const s = view.state;
    if (!s.table || !s.dialect) return;
    const warning = allColumnsIdentity(s.table, { dialect: s.dialect }).warning ?? '';
    const ok = await confirm({
      title: 'Edit a table without a key?',
      message: warning,
      confirmLabel: 'Match on all columns',
      danger: true,
    });
    if (ok) await view.acceptAllColumns();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [data-testid="cell-editor"]')) return;
    const mod = event.ctrlKey || event.metaKey;
    if (!mod) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && !event.shiftKey) view.undo();
    else if ((key === 'z' && event.shiftKey) || key === 'y') view.redo();
    else return;
    event.preventDefault();
  };

  if (status === 'loading') {
    return (
      <p className="p-4 text-sm text-muted" data-testid="table-data-loading">
        Loading…
      </p>
    );
  }
  if (status === 'error') {
    return (
      <div className="p-4 text-sm" role="alert">
        <p className="text-danger">{error}</p>
        <Button className="mt-3" onClick={() => void view.init()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="table-data-panel"
      onKeyDown={onKeyDown}
      aria-label={`${view.target.schema}.${view.target.name} data`}
    >
      <div
        className="flex flex-wrap items-center gap-1.5 border-b border-border bg-panel px-2 py-1.5"
        role="toolbar"
        aria-label="Table data"
      >
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.refresh()}
          title="Read the rows again"
        >
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <ViewPicker view={view} />
        {viewMode === 'grid' && (
          <ColumnsPopover
            layout={layout}
            label={(key) => key}
            onChange={(next) => view.setLayout(next)}
            onReset={() => view.setLayout(naturalLayout(columns.map((c) => c.name)))}
          />
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!editable}
          onClick={() => {
            const row = view.addRow();
            if (row === undefined) return;
            if (viewMode === 'form') {
              view.setFormIndex(row);
              return;
            }
            // Select the new row's first writable (visible) cell and bring it into view.
            const col = Math.max(
              0,
              view.display.order.findIndex((i) => {
                const c = columns[i];
                return c !== undefined && c.readOnly === undefined && !c.autoIncrement;
              }),
            );
            setSelection({
              ...EMPTY_SELECTION,
              current: {
                cell: [col, row],
                range: { x: col, y: row, width: 1, height: 1 },
                rangeStack: [],
              },
            });
            requestAnimationFrame(() => {
              gridRef.current?.scrollTo(col, row);
              gridRef.current?.focus();
            });
          }}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add row
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!editable || selectedRows(selection).length === 0}
          onClick={() => view.duplicateRows(selectedRefs())}
        >
          Duplicate
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!editable || selectedRows(selection).length === 0}
          onClick={() => view.deleteRows(selectedRefs())}
        >
          Delete rows
        </Button>
        <span className="mx-1 h-5 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!view.changes.canUndo}
          onClick={() => view.undo()}
          title="Undo (Ctrl/Cmd+Z)"
        >
          Undo
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!view.changes.canRedo}
          onClick={() => view.redo()}
          title="Redo (Ctrl/Cmd+Shift+Z)"
        >
          Redo
        </Button>
        <Button size="sm" variant="ghost" disabled={pending === 0} onClick={() => view.discard()}>
          Discard
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={pending === 0 || applying}
          onClick={startApply}
        >
          Apply{pending > 0 ? ` (${pending})` : ''}
        </Button>
        <span className="flex-1" />
        {pending > 0 && (
          <span className="text-xs text-muted" data-testid="pending-changes">
            {[
              counts.edited > 0 ? `${counts.edited} edited` : '',
              counts.inserted > 0 ? `${counts.inserted} new` : '',
              counts.deleted > 0 ? `${counts.deleted} deleted` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
      </div>
      {readOnlyProfile && (
        <Banner kind="info">
          This connection is read-only: rows can be viewed and copied, not changed.
        </Banner>
      )}
      {!readOnlyProfile && keyIdentity.kind === 'none' && identity.kind === 'none' && (
        <Banner kind="warning" testId="keyless-banner">
          This table has no primary or unique key, so it is read-only.
          <Button size="sm" variant="ghost" onClick={() => void acceptAllColumns()}>
            Edit by matching all columns…
          </Button>
        </Banner>
      )}
      {identity.kind === 'all-columns' && (
        <Banner kind="warning">
          Rows are matched on every column. If several rows are identical, only one of them changes.
        </Banner>
      )}
      {stale && (
        <Banner kind="info">
          The table's structure changed.
          <Button size="sm" variant="ghost" onClick={() => void view.refresh()}>
            Refresh
          </Button>
        </Banner>
      )}
      {notice && (
        <Banner
          kind={notice.kind === 'error' ? 'error' : 'info'}
          testId="table-notice"
          onDismiss={() => view.dismissNotice()}
        >
          {notice.text}
        </Banner>
      )}
      <FilterBar view={view} />
      <div className="min-h-0 flex-1">
        {viewMode === 'grid' && (
          <TableGrid
            view={view}
            theme={theme}
            selection={selection}
            onSelectionChange={setSelection}
            onOpenReferenced={openReferenced}
            gridRef={gridRef}
          />
        )}
        {viewMode === 'form' && <FormView view={view} onOpenReferenced={openReferenced} />}
        {viewMode === 'json' && <JsonView view={view} />}
      </div>
      <Footer
        view={view}
        selection={selection}
        viewMode={viewMode}
        onViewMode={(mode) => {
          // The form opens on the first selected row.
          if (mode === 'form') {
            const first = selectedRows(selection)[0];
            if (first !== undefined) view.setFormIndex(first);
          }
          view.setViewMode(mode);
        }}
      />
      {plan && <ApplyDialog view={view} plan={plan} onClose={() => setPlan(undefined)} />}
    </div>
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

/**
 * Navicat's pager: first, previous, the page number (type one and press Enter), next, last, and
 * the rows per page under the gear. "Last" counts the rows first when the total is not known.
 */
function Pager(props: { readonly view: TableView; readonly total: number | undefined }) {
  const { view } = props;
  const paging = useTableState(view, (s) => s.paging);
  const counting = useTableState(view, (s) => s.counting);
  const [text, setText] = useState(String(paging.page));
  useEffect(() => setText(String(paging.page)), [paging.page]);
  const pages =
    props.total === undefined ? undefined : Math.max(1, Math.ceil(props.total / paging.pageSize));
  const busy = paging.loading || counting;
  const atStart = paging.page <= 1;
  const atEnd = pages !== undefined ? paging.page >= pages : !paging.hasNext;
  const go = (move: Parameters<TableView['goToPage']>[0]): void => void view.goToPage(move);
  const step = (
    icon: IconName,
    label: string,
    move: Parameters<TableView['goToPage']>[0],
    off: boolean,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={off || busy}
      onClick={() => go(move)}
      className="flex h-[20px] w-[22px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent"
    >
      <Icon name={icon} className="h-3.5 w-3.5" />
    </button>
  );
  const submit = (): void => {
    const page = Number(text);
    if (!Number.isInteger(page) || page < 1 || (pages !== undefined && page > pages)) {
      setText(String(paging.page));
      return;
    }
    if (page !== paging.page) go(page);
  };
  return (
    <nav aria-label="Pages" className="flex items-center gap-0.5" data-testid="table-pager">
      {step('page-first', 'First page', 'first', atStart)}
      {step('page-previous', 'Previous page', 'previous', atStart)}
      <input
        type="text"
        inputMode="numeric"
        aria-label="Page"
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^\d]/g, ''))}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit();
          if (event.key === 'Escape') setText(String(paging.page));
        }}
        onBlur={() => setText(String(paging.page))}
        className="mx-0.5 h-[20px] w-11 rounded-sm border border-border bg-deep px-1 text-center text-xs text-fg tabular-nums outline-none! focus:border-focus"
      />
      {pages !== undefined && (
        <span className="px-0.5 text-muted tabular-nums" data-testid="table-pages">
          of {formatCount(pages)}
        </span>
      )}
      {step('page-next', 'Next page', 'next', atEnd)}
      {step('page-last', 'Last page', 'last', atEnd)}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Page size"
            title={`${formatCount(paging.pageSize)} rows per page`}
            className="ml-0.5 flex h-[20px] w-[22px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg data-[state=open]:bg-pressed data-[state=open]:text-fg"
          >
            <Icon name="settings" className="h-3.5 w-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="end"
            className="z-50 min-w-44 rounded border border-border bg-raised p-1 text-[13px] shadow-widget"
          >
            <DropdownMenu.Label className="px-2 pt-1 pb-0.5 text-[10px] font-semibold tracking-wide text-muted uppercase">
              Rows per page
            </DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              value={String(paging.pageSize)}
              onValueChange={(value) => void view.setPageSize(Number(value))}
            >
              {PAGE_SIZES.map((size) => (
                <DropdownMenu.RadioItem
                  key={size}
                  value={String(size)}
                  className="relative flex cursor-default items-center rounded-sm py-1 pr-2 pl-7 tabular-nums outline-none data-[highlighted]:bg-list-active"
                >
                  <DropdownMenu.ItemIndicator className="absolute left-2 text-rust">
                    <Icon name="check" className="h-3.5 w-3.5" />
                  </DropdownMenu.ItemIndicator>
                  {formatCount(size)}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </nav>
  );
}

const VIEW_MODES: readonly ViewModeOption<ViewMode>[] = [
  { value: 'grid', label: 'Grid', icon: 'view-grid' },
  { value: 'form', label: 'Form', icon: 'view-form' },
  { value: 'json', label: 'JSON', icon: 'view-json' },
];

function Footer(props: {
  readonly view: TableView;
  readonly selection: GridSelection;
  readonly viewMode: ViewMode;
  readonly onViewMode: (mode: ViewMode) => void;
}) {
  const { view, selection } = props;
  const paging = useTableState(view, (s) => s.paging);
  const estimate = useTableState(view, (s) => s.estimate);
  const exactCount = useTableState(view, (s) => s.exactCount);
  const counting = useTableState(view, (s) => s.counting);
  const cellErrors = useTableState(view, (s) => s.cellErrors);
  const columns = useTableState(view, (s) => s.columns);
  const changes = useChanges(view);
  // The first page holds every row: the total is known without counting.
  const complete =
    paging.page === 1 && !paging.hasNext && !paging.loading && paging.error === undefined;
  const known = exactCount ?? (complete ? paging.rows.length : undefined);

  const layout = useTableState(view, (s) => s.layout);
  const stats = useMemo(() => {
    const rows = selectedRows(selection);
    const cols = selectedColumns(selection, view.display.order.length).flatMap(
      (display) => view.modelColumn(display) ?? [],
    );
    if (rows.length === 0 || cols.length === 0) return undefined;
    const cells = function* () {
      let n = 0;
      for (const row of rows) {
        const ref = view.rowAt(row);
        if (!ref) continue;
        for (const c of cols) {
          if (n++ >= MAX_STAT_CELLS) return;
          const column = columns[c];
          if (column) yield { value: view.valueAt(ref, c), column };
        }
      }
    };
    return selectionStats(cells(), rows.length);
    // Figures follow the rows and staged values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, columns, layout, view, paging.version, changes]);

  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-panel px-2 py-1 text-xs">
      <span data-testid="table-row-count" aria-live="polite">
        {formatRows(paging.rows.length)} loaded
      </span>
      {paging.loading && <span className="text-muted">· loading…</span>}
      <span className="text-muted" data-testid="table-total">
        ·{' '}
        {known !== undefined
          ? `${formatCount(known)} in total`
          : estimate === undefined
            ? 'estimating…'
            : estimate === null
              ? 'total unknown'
              : `≈ ${formatCount(estimate)} in total`}
      </span>
      {counting ? (
        <Button size="sm" variant="ghost" onClick={() => view.cancelCount()}>
          Counting… Cancel
        </Button>
      ) : (
        known === undefined && (
          <Button size="sm" variant="ghost" onClick={() => void view.countExactly()}>
            Count exactly
          </Button>
        )
      )}
      {paging.paging && (
        <span
          className="text-muted"
          title={paging.offsetReason ?? 'Pages continue after the last row read, by key'}
        >
          · {paging.paging === 'keyset' ? 'keyset paging' : 'offset paging'}
        </span>
      )}
      <span className="flex-1" />
      {(() => {
        const [col, row] = selection.current?.cell ?? [];
        const ref = row === undefined ? undefined : view.rowAt(row);
        const index = col === undefined ? undefined : view.modelColumn(col);
        const name = index === undefined ? undefined : columns[index]?.name;
        const error =
          ref?.key != null && name !== undefined
            ? cellErrors[cellErrorKey(ref.key, name)]
            : undefined;
        return error === undefined ? null : (
          <span className="text-danger" data-testid="cell-error">
            Not pasted: {error}
          </span>
        );
      })()}
      {stats && (
        <span data-testid="selection-stats" className="flex gap-3">
          <span>
            {formatCount(stats.cells)} {stats.cells === 1 ? 'cell' : 'cells'},{' '}
            {formatCount(stats.rows)} {stats.rows === 1 ? 'row' : 'rows'}
          </span>
          {stats.numeric && (
            <>
              <span>Sum {formatStat(stats.numeric.sum)}</span>
              <span>Avg {formatStat(stats.numeric.avg)}</span>
              <span>Min {formatStat(stats.numeric.min)}</span>
              <span>Max {formatStat(stats.numeric.max)}</span>
            </>
          )}
        </span>
      )}
      <Pager view={view} total={known} />
      <ViewModeSwitch options={VIEW_MODES} value={props.viewMode} onChange={props.onViewMode} />
    </footer>
  );
}
