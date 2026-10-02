import type { DataRowAction, DataRowDiff, DataTableResult } from '@joinery/ipc';
import { useState } from 'react';
import { useStore } from 'zustand';

import { formatCount, formatDuration } from '../../lib/format';
import { differs, type DataCompare } from '../../state/sync/data';
import { appProfileLookup } from '../../state/sync/panels';
import { pairWarnings, sideTitle } from '../../state/sync/sides';
import { SelectField, TextField } from '../designer/fields';
import { Button, Icon, cx } from '../ui';
import { DataApplyDialog } from './ApplyDialogs';
import { Banner, Check, RunningBar, SaveComparison } from './parts';
import { SideFields } from './SideFields';

/**
 * The data compare panel (spec §13, data sync): the two sides and options, then counts per
 * table (inserts, updates, deletes, identical) with the tables left out and why, a paged row
 * grid with changed cells highlighted, and the sync script exported or applied.
 */

const ACTION_LABELS: Readonly<Record<DataRowAction, string>> = {
  insert: 'Inserts',
  update: 'Updates',
  delete: 'Deletes',
};

export function DataComparePanel(props: { readonly model: DataCompare }) {
  const { model } = props;
  const state = useStore(model.store);
  const [setupOpen, setSetupOpen] = useState(true);
  const [applying, setApplying] = useState(false);
  const busy = state.running !== undefined;
  const problem = model.problem();
  const showSetup = setupOpen || !state.result;
  const warnings = pairWarnings(state.source, state.target, appProfileLookup);
  const compare = async (): Promise<void> => {
    if (await model.compare()) setSetupOpen(false);
  };
  const title = `${sideTitle(state.source, appProfileLookup)} → ${sideTitle(state.target, appProfileLookup)}`;
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg text-fg" data-testid="data-compare">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5">
        <h2 className="text-sm font-semibold">Data compare</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-muted">{title}</span>
        {state.result && (
          <Button size="sm" variant="ghost" onClick={() => setSetupOpen(!setupOpen)}>
            {setupOpen ? 'Hide setup' : 'Change setup'}
          </Button>
        )}
        <SaveComparison saved={state.saved} suggested={title} onSave={(name) => model.save(name)} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {showSetup && (
          <section aria-label="Compare setup" className="flex flex-col gap-2">
            <div className="flex items-stretch gap-2">
              <SideFields
                role="source"
                draft={state.source}
                disabled={busy}
                onChange={(patch) => model.setSide('source', patch)}
              />
              <div className="flex items-center">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Swap source and target"
                  title="Swap source and target"
                  onClick={() => model.swapSides()}
                  disabled={busy}
                >
                  ⇄
                </Button>
              </div>
              <SideFields
                role="target"
                draft={state.target}
                disabled={busy}
                onChange={(patch) => model.setSide('target', patch)}
              />
            </div>
            <DataOptions model={model} disabled={busy} />
            {warnings.map((warning) => (
              <Banner key={warning} tone="warning">
                {warning}
              </Banner>
            ))}
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void compare()}
                disabled={busy || problem !== undefined}
                title={problem}
              >
                <Icon name="refresh" className="h-3.5 w-3.5" />
                {state.result ? 'Compare again' : 'Compare data'}
              </Button>
              {problem && <span className="text-xs text-muted">{problem}</span>}
              {state.stale && !busy && (
                <span className="text-xs text-warning">
                  Options changed: compare again for them to apply.
                </span>
              )}
            </div>
          </section>
        )}
        {state.running && (
          <RunningBar running={state.running} onCancel={() => void model.cancel()} />
        )}
        {state.error && (
          <Banner tone="error" testId="sync-error">
            {state.error}
          </Banner>
        )}
        {state.notice && (
          <Banner tone="notice" testId="sync-notice">
            {state.notice}
          </Banner>
        )}
        {state.result && (
          <Results
            model={model}
            onApply={() => setApplying(true)}
            onCompare={() => void compare()}
          />
        )}
      </div>
      {applying && state.result && (
        <DataApplyDialog model={model} onClose={() => setApplying(false)} />
      )}
    </div>
  );
}

function DataOptions(props: { readonly model: DataCompare; readonly disabled: boolean }) {
  const { model } = props;
  const options = useStore(model.store, (state) => state.options);
  const setAction = (action: DataRowAction, value: boolean): void =>
    model.setOptions({ actions: { ...options.actions, [action]: value } });
  return (
    <details className="rounded border border-border p-2" open>
      <summary className="cursor-pointer text-xs font-semibold">Options</summary>
      <div className="mt-2 grid grid-cols-3 gap-x-4 gap-y-2">
        <fieldset className="flex flex-col gap-1" disabled={props.disabled}>
          <legend className="text-[11px] text-muted">Sync these differences</legend>
          <Check
            label="Insert rows missing from the target"
            checked={options.actions.insert}
            onChange={(v) => setAction('insert', v)}
          />
          <Check
            label="Update rows that differ"
            checked={options.actions.update}
            onChange={(v) => setAction('update', v)}
          />
          <Check
            label="Delete rows only in the target"
            checked={options.actions.delete}
            onChange={(v) => setAction('delete', v)}
          />
        </fieldset>
        <div className="flex flex-col gap-1.5">
          <label className="flex flex-col gap-0.5 text-[11px] text-muted">
            Ignore columns (every table)
            <TextField
              value={options.ignoreColumns}
              placeholder="updated_at, version"
              disabled={props.disabled}
              onChange={(event) => model.setOptions({ ignoreColumns: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-muted">
            Float tolerance
            <TextField
              value={options.floatTolerance}
              placeholder="Exact"
              inputMode="decimal"
              disabled={props.disabled}
              onChange={(event) => model.setOptions({ floatTolerance: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-[11px] text-muted">
            Trim text
            <SelectField
              value={options.trim}
              disabled={props.disabled}
              onChange={(event) =>
                model.setOptions({ trim: event.target.value as 'none' | 'trailing' | 'both' })
              }
            >
              <option value="none">Compare as is</option>
              <option value="trailing">Trailing spaces (CHAR padding)</option>
              <option value="both">Leading and trailing spaces</option>
            </SelectField>
          </label>
        </div>
        <div className="flex flex-col gap-1.5">
          <Check
            label="Compare text case-insensitively"
            checked={options.caseInsensitive}
            disabled={props.disabled}
            onChange={(v) => model.setOptions({ caseInsensitive: v })}
          />
          <Check
            label="Disable foreign key checks while applying"
            hint="PostgreSQL needs superuser for this"
            checked={options.disableForeignKeyChecks}
            disabled={props.disabled}
            onChange={(v) => model.setOptions({ disableForeignKeyChecks: v })}
          />
          <Check
            label="Disable triggers while applying"
            hint="PostgreSQL; needs table ownership"
            checked={options.disableTriggers}
            disabled={props.disabled}
            onChange={(v) => model.setOptions({ disableTriggers: v })}
          />
        </div>
      </div>
    </details>
  );
}

function Results(props: {
  readonly model: DataCompare;
  readonly onApply: () => void;
  readonly onCompare: () => void;
}) {
  const { model } = props;
  const state = useStore(model.store);
  const result = state.result!;
  const busy = state.running !== undefined;
  const focused = result.tables.find((t) => t.index === state.focused);
  const pending = model.pendingTotal();
  const allChecked =
    result.tables.length > 0 &&
    result.tables.filter((t) => !t.error).every((t) => state.checked.includes(t.index));
  return (
    <section aria-label="Comparison" className="flex flex-col gap-2" data-testid="sync-results">
      <div className="overflow-auto rounded border border-border bg-panel">
        <table className="w-full text-xs" aria-label="Compared tables">
          <thead className="bg-panel-2 text-left text-[11px] text-muted">
            <tr>
              <th className="w-8 px-2 py-1">
                <input
                  type="checkbox"
                  aria-label="Sync every table"
                  checked={allChecked}
                  onChange={(event) => {
                    for (const t of result.tables) {
                      if (!t.error) model.toggleTable(t.index, event.target.checked);
                    }
                  }}
                />
              </th>
              <th className="px-2 py-1 font-medium">Table</th>
              <th className="px-2 py-1 font-medium">Key</th>
              <th className="px-2 py-1 text-right font-medium">Inserts</th>
              <th className="px-2 py-1 text-right font-medium">Updates</th>
              <th className="px-2 py-1 text-right font-medium">Deletes</th>
              <th className="px-2 py-1 text-right font-medium">Identical</th>
              <th className="px-2 py-1 font-medium">Compared</th>
            </tr>
          </thead>
          <tbody>
            {result.tables.map((table) => (
              <TableRow
                key={table.index}
                table={table}
                checked={state.checked.includes(table.index)}
                focused={state.focused === table.index}
                onCheck={(checked) => model.toggleTable(table.index, checked)}
                onFocus={() => void model.focus(table.index)}
              />
            ))}
            {result.tables.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-3 text-center text-muted">
                  No table pairs with a key both sides share.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {result.skipped.length > 0 && (
        <details className="rounded border border-border p-2 text-xs" data-testid="skipped-tables">
          <summary className="cursor-pointer">
            {result.skipped.length} {result.skipped.length === 1 ? 'table' : 'tables'} not compared
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {result.skipped.map((skip) => (
              <li key={skip.name}>
                <span className="font-mono">{skip.name}</span>
                <span className="text-muted"> — {skip.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {focused && <TableDetails model={model} table={focused} onCompare={props.onCompare} />}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          onClick={() => void model.exportScript()}
          disabled={busy || state.checked.length === 0}
        >
          Export sync script…
        </Button>
        <span className="flex-1" />
        <span className="text-xs text-muted">
          {formatCount(pending)} {pending === 1 ? 'change' : 'changes'} in {state.checked.length}{' '}
          {state.checked.length === 1 ? 'table' : 'tables'}
        </span>
        <Button variant="primary" onClick={props.onApply} disabled={busy || pending === 0}>
          Apply…
        </Button>
      </div>
    </section>
  );
}

function TableRow(props: {
  readonly table: DataTableResult;
  readonly checked: boolean;
  readonly focused: boolean;
  readonly onCheck: (checked: boolean) => void;
  readonly onFocus: () => void;
}) {
  const { table } = props;
  const count = (value: number, tone: string) => (
    <td className={cx('px-2 py-1 text-right tabular-nums', value > 0 ? tone : 'text-muted')}>
      {formatCount(value)}
    </td>
  );
  return (
    <tr
      className={cx('border-t border-border/60', props.focused ? 'bg-hover' : 'hover:bg-hover')}
      data-testid="data-table-row"
      aria-current={props.focused ? 'true' : undefined}
    >
      <td className="px-2 py-1">
        <input
          type="checkbox"
          aria-label={`Sync ${table.name}`}
          checked={props.checked}
          disabled={table.error !== undefined}
          onChange={(event) => props.onCheck(event.target.checked)}
        />
      </td>
      <td className="px-2 py-1">
        <button type="button" className="font-mono hover:underline" onClick={props.onFocus}>
          {table.name}
        </button>
        {table.error && <span className="block text-[11px] text-danger">{table.error}</span>}
      </td>
      <td className="px-2 py-1 font-mono text-muted">{table.keyColumns.join(', ')}</td>
      {count(table.counts.inserts, 'text-success')}
      {count(table.counts.updates, 'text-warning')}
      {count(table.counts.deletes, 'text-danger')}
      <td className="px-2 py-1 text-right text-muted tabular-nums">
        {formatCount(table.counts.equal)}
      </td>
      <td className="px-2 py-1 text-[11px] text-muted">
        {table.checksums
          ? `${table.matchedRanges} of ${table.ranges} ranges matched by checksum`
          : 'rows streamed'}{' '}
        · {formatDuration(table.durationMs)}
      </td>
    </tr>
  );
}

function TableDetails(props: {
  readonly model: DataCompare;
  readonly table: DataTableResult;
  readonly onCompare: () => void;
}) {
  const { model, table } = props;
  const state = useStore(model.store);
  const [editing, setEditing] = useState(false);
  const subset = state.tableColumns[table.name];
  const nonKey = table.commonColumns.filter(
    (c) => !table.keyColumns.some((k) => k.toLowerCase() === c.toLowerCase()),
  );
  const rows = state.rows;
  const pageSize = state.result?.pageSize ?? 1;
  return (
    <section
      aria-label={`Rows of ${table.name}`}
      className="flex flex-col gap-1.5 rounded border border-border bg-panel p-2"
      data-testid="data-rows"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <h3 className="font-semibold">
          <span className="font-mono">{table.name}</span>
        </h3>
        <span className="text-muted">
          Compares {table.compared.length > 0 ? table.compared.join(', ') : 'the key only'}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
          {editing ? 'Done' : 'Columns…'}
        </Button>
        <span className="flex-1" />
        <div role="tablist" aria-label="Differences" className="flex gap-1">
          {(['insert', 'update', 'delete'] as const).map((action) => {
            const n =
              action === 'insert'
                ? table.counts.inserts
                : action === 'update'
                  ? table.counts.updates
                  : table.counts.deletes;
            return (
              <button
                key={action}
                type="button"
                role="tab"
                aria-selected={state.rowAction === action}
                className={cx(
                  'rounded px-2 py-0.5',
                  state.rowAction === action ? 'bg-badge text-fg' : 'hover:bg-hover',
                )}
                onClick={() => void model.showRows(action, 0)}
              >
                {ACTION_LABELS[action]} ({formatCount(n)})
              </button>
            );
          })}
        </div>
      </div>
      {editing && (
        <div className="flex flex-col gap-1 rounded border border-border p-2 text-xs">
          <p className="text-muted">
            Columns to compare besides the key ({table.keyColumns.join(', ')}). Takes effect on the
            next compare.
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {nonKey.map((column) => (
              <Check
                key={column}
                label={<span className="font-mono">{column}</span>}
                checked={subset === undefined || subset.includes(column)}
                onChange={(checked) => {
                  const current = subset ?? nonKey;
                  const next = checked
                    ? nonKey.filter((c) => c === column || current.includes(c))
                    : current.filter((c) => c !== column);
                  model.setTableColumns(
                    table.name,
                    next.length === nonKey.length ? undefined : next,
                  );
                }}
              />
            ))}
          </div>
          {state.stale && (
            <span>
              <Button size="sm" onClick={props.onCompare} disabled={state.running !== undefined}>
                Compare again
              </Button>
            </span>
          )}
        </div>
      )}
      <RowGrid
        columns={table.columns}
        keyCount={table.keyColumns.length}
        rows={rows?.rows ?? []}
        loading={state.rowsLoading}
      />
      <div className="flex items-center gap-2 text-[11px] text-muted">
        {rows && rows.total > 0 ? (
          <span>
            Rows {formatCount(rows.page * pageSize + 1)}–
            {formatCount(rows.page * pageSize + rows.rows.length)} of {formatCount(rows.total)}
            {rows.total < countFor(table, state.rowAction)
              ? ` (the first ${formatCount(rows.total)} of ${formatCount(countFor(table, state.rowAction))} are kept for viewing; the script has them all)`
              : ''}
          </span>
        ) : (
          <span>{state.rowsLoading ? 'Loading…' : 'No rows'}</span>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!rows || rows.page === 0 || state.rowsLoading}
          onClick={() => void model.showRows(state.rowAction, (rows?.page ?? 1) - 1)}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!rows || rows.page + 1 >= rows.pageCount || state.rowsLoading}
          onClick={() => void model.showRows(state.rowAction, (rows?.page ?? 0) + 1)}
        >
          Next
        </Button>
      </div>
      {!differs(table) && !table.error && (
        <p className="text-xs text-muted">The rows of this table are identical.</p>
      )}
    </section>
  );
}

function countFor(table: DataTableResult, action: DataRowAction): number {
  return action === 'insert'
    ? table.counts.inserts
    : action === 'update'
      ? table.counts.updates
      : table.counts.deletes;
}

/** The row differences: inserts show the source row, deletes the target row, updates both. */
function RowGrid(props: {
  readonly columns: readonly string[];
  readonly keyCount: number;
  readonly rows: readonly DataRowDiff[];
  readonly loading: boolean;
}) {
  const cell = (value: string | null | undefined) =>
    value === null || value === undefined ? <span className="text-muted">NULL</span> : value;
  return (
    <div className="max-h-80 overflow-auto rounded border border-border">
      <table className="w-full text-[11px]" data-testid="data-row-grid">
        <thead className="sticky top-0 bg-panel text-left text-muted">
          <tr>
            {props.columns.map((column, index) => (
              <th
                key={column}
                className={cx('px-1.5 py-0.5 font-medium', index < props.keyCount && 'text-fg')}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="font-mono">
          {props.rows.map((row, r) => (
            <tr key={r} className="border-t border-border/60 align-top" data-action={row.action}>
              {props.columns.map((column, c) => {
                const changed = row.changed?.includes(column) === true;
                const values = row.action === 'delete' ? row.target : row.source;
                return (
                  <td
                    key={column}
                    className={cx(
                      'max-w-72 px-1.5 py-0.5 break-words',
                      changed && 'bg-warning/15',
                      row.action === 'insert' && 'bg-success/5',
                      row.action === 'delete' && 'bg-danger/5 text-muted line-through',
                    )}
                    data-changed={changed || undefined}
                  >
                    {changed ? (
                      <>
                        <span className="block text-muted line-through">
                          {cell(row.target?.[c])}
                        </span>
                        <span className="block">{cell(row.source?.[c])}</span>
                      </>
                    ) : (
                      cell(values?.[c])
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
          {props.rows.length === 0 && !props.loading && (
            <tr>
              <td colSpan={props.columns.length} className="px-2 py-2 text-center text-muted">
                Nothing to show for this action.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
