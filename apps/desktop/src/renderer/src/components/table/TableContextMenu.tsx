import type { GridSelection } from '@glideapps/glide-data-grid';
import { COPY_FORMATS, DEFAULT, isDefault, type CopyFormat } from '@querybara/table-data';
import { DropdownMenu } from 'radix-ui';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import type { RowRef } from '../../state/table/grid-model';
import { useTableState, type TableView } from '../../state/table-view';
import { formatCount } from '../../lib/format';
import { useWindowState } from '../../state/window';
import { MenuItem, MenuSub } from '../MenuItem';
import { PointerAnchor } from '../PointerAnchor';
import type { IconName } from '../ui';

/** Where the grid's context menu opened, and the selection it acts on (display positions). */
export interface MenuAt {
  readonly x: number;
  readonly y: number;
  readonly col: number;
  readonly row: number;
  readonly selection: GridSelection;
}

/** A glyph for each copy format. */
const COPY_ICONS: Readonly<Record<CopyFormat, IconName>> = {
  tsv: 'view-grid',
  csv: 'format',
  json: 'view-json',
  markdown: 'table',
  insert: 'table-new',
  update: 'edit',
};

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
 * The grid's right-click menu, at the pointer: the column it was opened on, NULL and DEFAULT for
 * the selected cells, the referenced row of a foreign key, copy (and copy as every format), and
 * the row actions, each with its glyph and its shortcut where one exists.
 */
export function TableContextMenu(props: {
  readonly view: TableView;
  readonly at: MenuAt;
  readonly onClose: () => void;
  readonly onOpenReferenced: (row: number, column: number) => void;
}) {
  const { view, at } = props;
  const platform = useWindowState((s) => s.platform);
  const columns = useTableState(view, (s) => s.columns);
  const identity = useTableState(view, (s) => s.identity);
  const index = view.modelColumn(at.col);
  const column = index === undefined ? undefined : columns[index];
  const refs = rowsOf(view, at.selection);
  // The selection counts visible columns in display order; copy and set work on the model's.
  const columnIndexes = columnsOf(at.selection, view.display.order.length).flatMap(
    (display) => view.modelColumn(display) ?? [],
  );
  const editable = view.editable;
  const cellRef = view.rowAt(at.row);
  const fkValue =
    column && cellRef && index !== undefined ? view.valueAt(cellRef, index) : undefined;
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

  const mac = platform === 'darwin';
  const rows = refs.length === 1 ? 'row' : `${formatCount(refs.length)} rows`;

  return (
    <DropdownMenu.Root open onOpenChange={(open) => !open && props.onClose()} modal={false}>
      <DropdownMenu.Trigger asChild>
        <PointerAnchor x={at.x} y={at.y} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={2}
          collisionPadding={8}
          aria-label="Row actions"
          className="z-50 max-h-[80vh] min-w-56 overflow-auto rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          {column && (
            <div className="flex items-baseline gap-2 px-2 pt-1 pb-1.5">
              <span className="truncate font-mono text-[12px] text-fg">{column.name}</span>
              <span className="truncate font-mono text-[11px] text-faint">{column.dataType}</span>
              {refs.length > 1 && (
                <span className="ml-auto text-[11px] whitespace-nowrap text-muted">
                  {formatCount(refs.length)} rows
                </span>
              )}
            </div>
          )}
          {editable && (
            <>
              <MenuItem icon="set-null" disabled={!column?.nullable} onSelect={() => setAll(null)}>
                Set NULL
              </MenuItem>
              <MenuItem
                icon="set-default"
                disabled={!column?.hasDefault}
                onSelect={() => setAll(DEFAULT)}
              >
                Set DEFAULT
              </MenuItem>
            </>
          )}
          {hasFk && (
            <MenuItem icon="link" onSelect={() => props.onOpenReferenced(at.row, at.col)}>
              Open referenced row
            </MenuItem>
          )}
          {(editable || hasFk) && <Separator />}
          <MenuItem icon="copy" shortcut={mac ? '⌘C' : 'Ctrl+C'} onSelect={() => copy('tsv')}>
            Copy
          </MenuItem>
          <MenuSub icon="export" label="Copy as">
            {COPY_FORMATS.map((format) => (
              <MenuItem
                key={format}
                icon={COPY_ICONS[format]}
                disabled={format === 'update' && identity.kind === 'none'}
                onSelect={() => copy(format)}
              >
                {COPY_LABELS[format]}
              </MenuItem>
            ))}
          </MenuSub>
          {editable && (
            <>
              <Separator />
              <MenuItem icon="plus" onSelect={() => view.addRow()}>
                Add row
              </MenuItem>
              <MenuItem icon="copy" onSelect={() => view.duplicateRows(refs)}>
                Duplicate {rows}
              </MenuItem>
              <MenuItem icon="restore" onSelect={() => view.revert(refs)}>
                Revert changes
              </MenuItem>
              <Separator />
              <MenuItem icon="trash" danger onSelect={() => view.deleteRows(refs)}>
                Delete {rows}
              </MenuItem>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Separator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}
