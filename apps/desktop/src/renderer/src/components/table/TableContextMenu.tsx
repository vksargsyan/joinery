import type { GridSelection } from '@glideapps/glide-data-grid';
import { COPY_FORMATS, DEFAULT, isDefault, type CopyFormat } from '@joinery/table-data';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import type { RowRef } from '../../state/table/grid-model';
import { useTableState, type TableView } from '../../state/table-view';
import { cx } from '../ui';

/** Where the grid's context menu opened, and the selection it acts on. */
export interface MenuAt {
  readonly x: number;
  readonly y: number;
  readonly col: number;
  readonly row: number;
  readonly selection: GridSelection;
}

export const COPY_LABELS: Readonly<Record<CopyFormat, string>> = {
  tsv: 'TSV (Excel, Sheets)',
  csv: 'CSV',
  json: 'JSON',
  markdown: 'Markdown table',
  insert: 'INSERT statements',
  update: 'UPDATE statements',
};

function rowsOf(view: TableView, selection: GridSelection): RowRef[] {
  const rows = new Set<number>(selection.rows.toArray());
  const range = selection.current?.range;
  if (range) for (let r = range.y; r < range.y + range.height; r++) rows.add(r);
  return [...rows]
    .sort((a, b) => a - b)
    .map((r) => view.rowAt(r))
    .filter((ref): ref is RowRef => ref !== undefined);
}

function columnsOf(selection: GridSelection, count: number): number[] {
  const range = selection.current?.range;
  if (!range || selection.rows.length > 0) return Array.from({ length: count }, (_, i) => i);
  return Array.from({ length: range.width }, (_, i) => range.x + i);
}

/**
 * The grid's right-click menu: NULL and DEFAULT for the selected cells, the referenced row of a
 * foreign key, copy in every format, and the row actions.
 */
export function TableContextMenu(props: {
  readonly view: TableView;
  readonly at: MenuAt;
  readonly onClose: () => void;
  readonly onOpenReferenced: (row: number, column: number) => void;
}) {
  const { view, at } = props;
  const columns = useTableState(view, (s) => s.columns);
  const identity = useTableState(view, (s) => s.identity);
  const column = columns[at.col];
  const refs = rowsOf(view, at.selection);
  const columnIndexes = columnsOf(at.selection, columns.length);
  const editable = view.editable;
  const cellRef = view.rowAt(at.row);
  const fkValue = column && cellRef ? view.valueAt(cellRef, at.col) : undefined;
  const hasFk =
    column !== undefined &&
    view.foreignKeysOf(column.name).length > 0 &&
    fkValue !== null &&
    fkValue !== undefined &&
    !isDefault(fkValue);

  const setAll = (value: typeof DEFAULT | null): void => {
    const cells = refs.flatMap((ref) =>
      columnIndexes
        .map((i) => columns[i])
        .filter((c) => c !== undefined && (value !== null || c.nullable))
        .map((c) => ({ ref, column: c!.name, value })),
    );
    view.setCells(cells);
  };
  const copy = (format: CopyFormat): void => {
    try {
      copyToClipboard(view.copyText(format, refs, columnIndexes));
    } catch (error) {
      view.store.setState({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  };

  return (
    <DropdownMenu.Root open onOpenChange={(open) => !open && props.onClose()} modal={false}>
      <DropdownMenu.Trigger asChild>
        <span
          aria-hidden="true"
          style={{ position: 'fixed', left: at.x, top: at.y, width: 1, height: 1 }}
        />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          aria-label="Row actions"
          className="z-50 max-h-[80vh] min-w-52 overflow-auto rounded border border-border bg-panel p-1 text-[13px] shadow-xl"
        >
          {editable && (
            <>
              <Item disabled={!column?.nullable} onSelect={() => setAll(null)}>
                Set NULL
              </Item>
              <Item onSelect={() => setAll(DEFAULT)}>Set DEFAULT</Item>
            </>
          )}
          {hasFk && (
            <Item onSelect={() => props.onOpenReferenced(at.row, at.col)}>Open referenced row</Item>
          )}
          <Separator />
          <DropdownMenu.Label className="px-2 py-1 text-[11px] text-muted">
            Copy as
          </DropdownMenu.Label>
          {COPY_FORMATS.map((format) => (
            <Item
              key={format}
              disabled={format === 'update' && identity.kind === 'none'}
              onSelect={() => copy(format)}
            >
              {COPY_LABELS[format]}
            </Item>
          ))}
          {editable && (
            <>
              <Separator />
              <Item onSelect={() => view.addRow()}>Add row</Item>
              <Item onSelect={() => view.duplicateRows(refs)}>
                Duplicate {refs.length === 1 ? 'row' : `${refs.length} rows`}
              </Item>
              <Item danger onSelect={() => view.deleteRows(refs)}>
                Delete {refs.length === 1 ? 'row' : `${refs.length} rows`}
              </Item>
              <Item onSelect={() => view.revert(refs)}>Revert changes</Item>
            </>
          )}
          <p className="px-2 pt-1 text-[11px] text-muted">Paste with Ctrl/Cmd+V</p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item(props: {
  readonly children: ReactNode;
  readonly onSelect: () => void;
  readonly danger?: boolean;
  readonly disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item
      disabled={props.disabled}
      onSelect={props.onSelect}
      className={cx(
        'cursor-default rounded px-2 py-1.5 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-hover',
        props.danger && 'text-danger',
      )}
    >
      {props.children}
    </DropdownMenu.Item>
  );
}

function Separator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}
