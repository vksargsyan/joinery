import { formatCell, isDefault, isLargeValue, type EditValue } from '@querybara/table-data';
import { useEffect, useMemo, useState } from 'react';

import { formatCount } from '../../lib/format';
import { copyToClipboard } from '../../lib/clipboard';
import { displayCell, rowStatus } from '../../state/table/grid-model';
import { useTableState, type TableView } from '../../state/table-view';
import { Button, Icon, cx } from '../ui';
import { CellEditor } from './CellEditor';
import { useChanges } from './TableGrid';

/**
 * The other two views of the same rows (spec §7): a form showing one record per page, where a
 * field opens the same type-aware editor as the grid, and the rows as JSON text.
 */

const STATUS_LABELS = {
  unchanged: '',
  edited: 'Edited',
  inserted: 'New row',
  deleted: 'Marked for deletion',
} as const;

export function FormView(props: {
  readonly view: TableView;
  readonly onOpenReferenced: (row: number, column: number) => void;
}) {
  const { view } = props;
  const index = useTableState(view, (s) => s.formIndex);
  const columns = useTableState(view, (s) => s.columns);
  const paging = useTableState(view, (s) => s.paging);
  const identity = useTableState(view, (s) => s.identity);
  const changes = useChanges(view);
  const [editing, setEditing] = useState<string>();
  const total = paging.rows.length + changes.counts.inserted;
  // Records count on from the pages before this one.
  const offset = (paging.page - 1) * paging.pageSize;
  const ref = view.rowAt(index);
  useEffect(() => setEditing(undefined), [index]);

  if (!ref) {
    return <p className="p-4 text-sm text-muted">{paging.loading ? 'Loading…' : 'No rows.'}</p>;
  }
  const status = rowStatus(changes, ref);
  const editable = view.editable && status !== 'deleted';
  return (
    <div className="flex h-full flex-col" data-testid="form-view">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs">
        <Button
          size="sm"
          variant="ghost"
          // The first record of a page goes on to the previous page's last.
          onClick={() =>
            index === 0
              ? void view
                  .goToPage('previous')
                  .then(() => view.setFormIndex(Number.MAX_SAFE_INTEGER))
              : view.setFormIndex(index - 1)
          }
          disabled={index === 0 && paging.page <= 1}
        >
          ‹ Previous
        </Button>
        <span aria-live="polite" data-testid="form-position">
          Record {formatCount(offset + index + 1)} of {formatCount(offset + total)}
          {paging.hasNext ? '+' : ''}
        </span>
        <Button
          size="sm"
          variant="ghost"
          // The last record of a page goes on to the next page.
          onClick={() =>
            index >= total - 1 ? void view.goToPage('next') : view.setFormIndex(index + 1)
          }
          disabled={index >= total - 1 && !paging.hasNext}
        >
          Next ›
        </Button>
        {status !== 'unchanged' && (
          <span
            className={cx(
              'rounded px-1.5 py-0.5 font-semibold',
              status === 'deleted'
                ? 'bg-danger/15 text-danger'
                : status === 'inserted'
                  ? 'bg-success/15 text-success'
                  : 'bg-warning/15 text-warning',
            )}
          >
            {STATUS_LABELS[status]}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <dl className="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-3 gap-y-1.5">
          {columns.map((column, c) => {
            const value = view.valueAt(ref, c);
            const edited = ref.key !== null && changes.isEdited(ref.key, column.name);
            const display = displayCell(value);
            const fks = view.foreignKeysOf(column.name);
            const fk = fks.find((f) => f.columns.length === 1);
            const isKey = identity.kind !== 'all-columns' && identity.columns.includes(column.name);
            return (
              <div key={column.name} className="contents">
                <dt className="pt-1.5 text-xs">
                  <span className="font-mono font-semibold">{column.name}</span>
                  {isKey && <span className="ml-1 text-[10px] text-warning">KEY</span>}
                  {fks.length > 0 && <span className="ml-1 text-[10px] text-accent">FK</span>}
                  <span className="block truncate text-[11px] text-muted">{column.dataType}</span>
                </dt>
                <dd className="min-w-0">
                  {editing === column.name ? (
                    <CellEditor
                      variant="form"
                      column={column}
                      value={value}
                      canDefault={ref.kind === 'insert' || column.hasDefault}
                      {...(column.readOnly !== undefined ? { locked: column.readOnly } : {})}
                      {...(fk ? { lookup: (search: string) => view.lookup(fk, search) } : {})}
                      onCommit={(next) => {
                        if (view.setCell(ref, column.name, next)) setEditing(undefined);
                      }}
                      onCancel={() => setEditing(undefined)}
                    />
                  ) : (
                    <div className="flex items-start gap-1.5">
                      <button
                        type="button"
                        aria-label={`${column.name}: ${display.text}`}
                        disabled={!editable && !display.truncated}
                        className={cx(
                          'min-h-8 min-w-0 flex-1 rounded border border-transparent px-2 py-1 text-left font-mono text-xs break-all whitespace-pre-wrap hover:border-border disabled:cursor-default',
                          display.state !== 'value' && 'text-muted italic',
                          edited && 'bg-warning/15',
                          status === 'deleted' && 'line-through',
                        )}
                        onClick={() => setEditing(column.name)}
                      >
                        {fullText(value)}
                      </button>
                      {fks.length > 0 &&
                        value !== null &&
                        value !== undefined &&
                        !isDefault(value) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="Open the referenced row"
                            onClick={() => props.onOpenReferenced(index, c)}
                          >
                            ↗
                          </Button>
                        )}
                    </div>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

/** The whole value as text for the form (the grid shows a preview). */
function fullText(value: EditValue | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  if (isDefault(value)) return 'DEFAULT';
  if (value === '') return "''";
  if (isLargeValue(value)) return `${value.preview}…`;
  return formatCell(value);
}

export function JsonView(props: { readonly view: TableView }) {
  const { view } = props;
  const version = useTableState(view, (s) => s.paging.version);
  const changes = useChanges(view);
  const text = useMemo(
    () => view.jsonText(),
    // Recomputed when rows load or staged changes move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, version, changes],
  );
  const rows = Math.min(view.rowCount(), 1000);
  return (
    <div className="flex h-full flex-col" data-testid="json-view">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs text-muted">
        <span>
          {formatCount(rows)} {rows === 1 ? 'row' : 'rows'} as JSON
          {view.rowCount() > rows ? ' (the first 1,000)' : ''}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => copyToClipboard(text)}>
          <Icon name="format" className="h-3 w-3" />
          Copy
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs select-text">{text}</pre>
    </div>
  );
}
