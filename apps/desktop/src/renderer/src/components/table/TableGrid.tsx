import {
  CompactSelection,
  DataEditor,
  GridCellKind,
  GridColumnIcon,
  type DataEditorRef,
  type DrawCellCallback,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type ProvideEditorCallback,
  type ProvideEditorComponent,
  type TextCell,
  type Theme,
} from '@glideapps/glide-data-grid';
import {
  formatCell,
  isDefault,
  isLargeValue,
  parsePastedText,
  sameValue,
  type ChangeSet,
  type ColumnInfo,
  type EditValue,
} from '@joinery/table-data';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type Ref } from 'react';

import { moveColumn, setWidth } from '../../state/grid-layout';
import { cellErrorKey, displayCell, rowStatus } from '../../state/table/grid-model';
import { sortMark } from '../../state/table/sort';
import { useTableState, type TableView } from '../../state/table-view';
import { BISQUE, TENMOKU, withAlpha, type KilnPalette } from '../../lib/kiln';
import { DARK, LIGHT } from '../ResultGrid';
import { CellEditor, type Draft } from './CellEditor';
import { HeaderMenu, type HeaderMenuAt } from './ColumnMenus';
import { TableContextMenu, type MenuAt } from './TableContextMenu';

/**
 * The table data grid (spec §7) on Glide Data Grid: rows read straight from the view (loaded
 * rows, then staged inserts) with staged changes highlighted — edited cells tinted, inserted
 * rows green, deleted rows red and struck through — NULL, '' and DEFAULT drawn as distinct
 * muted states, foreign key values with a link to the referenced row. Header clicks sort on
 * the server; scrolling near the end loads the next page. Cells open the type-aware editor.
 * Columns follow the view's layout (hidden, reordered by dragging headers, pinned, resized):
 * grid positions are display positions, mapped to the model's columns through `view.display`.
 */

/** Staged changes in Kiln's diff colours: edits ochre, inserts celadon, deletes red. */
function stagedPalette(p: KilnPalette) {
  return {
    muted: p.faint,
    edited: withAlpha(p.ochre, 0.2),
    inserted: withAlpha(p.celadon, 0.14),
    deleted: withAlpha(p.red, 0.14),
    error: withAlpha(p.red, 0.45),
    strike: p.red,
    link: p.cobalt,
  };
}

const PALETTE = { dark: stagedPalette(TENMOKU), light: stagedPalette(BISQUE) } as const;

/** Typed edit values the overlay hands to `onCellEdited`, keyed by a token in the cell text. */
const TOKEN = '\u0000joinery-edit:';
const INVALID = `${TOKEN}invalid`;
const pendingEdits = new Map<string, EditValue>();
let nextToken = 1;

function tokenCell(cell: TextCell, value: EditValue): TextCell {
  const token = `${TOKEN}${nextToken++}`;
  pendingEdits.set(token, value);
  return { ...cell, data: token };
}

const ICONS: Partial<Record<ColumnInfo['kind'], GridColumnIcon>> = {
  integer: GridColumnIcon.HeaderNumber,
  bigint: GridColumnIcon.HeaderNumber,
  decimal: GridColumnIcon.HeaderNumber,
  float: GridColumnIcon.HeaderNumber,
  boolean: GridColumnIcon.HeaderBoolean,
  date: GridColumnIcon.HeaderDate,
  datetime: GridColumnIcon.HeaderDate,
  timestamp: GridColumnIcon.HeaderDate,
  time: GridColumnIcon.HeaderTime,
  json: GridColumnIcon.HeaderCode,
  array: GridColumnIcon.HeaderArray,
};

function initialWidth(column: ColumnInfo): number {
  const byKind: Partial<Record<ColumnInfo['kind'], number>> = {
    boolean: 80,
    integer: 100,
    bigint: 120,
    decimal: 120,
    float: 110,
    date: 110,
    time: 100,
    datetime: 180,
    timestamp: 210,
    uuid: 290,
    json: 240,
  };
  const base =
    byKind[column.kind] ?? (column.length !== undefined && column.length <= 20 ? 140 : 200);
  return Math.max(base, Math.min(320, column.name.length * 8 + 48));
}

/** The grid rows a selection covers: whole selected rows, and the rows of the cell range. */
export function selectedRows(selection: GridSelection): number[] {
  const rows = new Set<number>(selection.rows.toArray());
  const range = selection.current?.range;
  if (range) for (let r = range.y; r < range.y + range.height; r++) rows.add(r);
  return [...rows].sort((a, b) => a - b);
}

/** The columns a selection covers (all when whole rows are selected). */
export function selectedColumns(selection: GridSelection, count: number): number[] {
  if (selection.rows.length > 0 && !selection.current)
    return Array.from({ length: count }, (_, i) => i);
  const columns = new Set<number>(selection.columns.toArray());
  const range = selection.current?.range;
  if (range) for (let c = range.x; c < range.x + range.width; c++) columns.add(c);
  return [...columns].sort((a, b) => a - b);
}

export const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

export function TableGrid(props: {
  readonly view: TableView;
  readonly theme: 'dark' | 'light';
  readonly selection: GridSelection;
  readonly onSelectionChange: (selection: GridSelection) => void;
  readonly onOpenReferenced: (row: number, column: number) => void;
  /** Lets the panel scroll to and focus a cell (after Add row). */
  readonly gridRef?: Ref<DataEditorRef>;
}) {
  const { view } = props;
  const columns = useTableState(view, (s) => s.columns);
  const sort = useTableState(view, (s) => s.sort);
  const paging = useTableState(view, (s) => s.paging);
  const cellErrors = useTableState(view, (s) => s.cellErrors);
  const identity = useTableState(view, (s) => s.identity);
  const readOnlyProfile = useTableState(view, (s) => s.readOnlyProfile);
  const status = useTableState(view, (s) => s.status);
  const layout = useTableState(view, (s) => s.layout);
  const changes = useSyncExternalStore(view.changes.subscribe, view.changes.getSnapshot);
  // The view recomputes it only when the layout or the columns change (both read above).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const display = useMemo(() => view.display, [view, layout, columns]);
  // Stable while only widths change, so a resize does not rebuild the cell callbacks.
  const orderKey = display.order.join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const order = useMemo(() => display.order, [orderKey]);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuAt>();
  const palette = PALETTE[props.theme];
  const editable = status === 'ready' && identity.kind !== 'none' && !readOnlyProfile;
  const rows = paging.rows.length + changes.counts.inserted;

  const foreignKeyColumns = useMemo(() => {
    const names = new Set<string>();
    for (const fk of view.state.table?.foreignKeys ?? []) for (const c of fk.columns) names.add(c);
    return names;
    // The definition changes with the columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, view]);
  const keyColumns = useMemo(() => new Set(identity.columns), [identity]);

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      order.map((index, at) => {
        const column = columns[index]!;
        const mark = sortMark(sort, column.name);
        const key = keyColumns.has(column.name) && identity.kind !== 'all-columns';
        return {
          id: column.name,
          title: `${key ? '🔑 ' : ''}${column.name}${mark ? ` ${mark}` : ''}`,
          width: display.widths[at] ?? initialWidth(column),
          icon: foreignKeyColumns.has(column.name)
            ? GridColumnIcon.HeaderReference
            : (ICONS[column.kind] ?? GridColumnIcon.HeaderString),
          hasMenu: true,
        };
      }),
    [order, display, columns, sort, keyColumns, identity, foreignKeyColumns],
  );

  // The latest view and changes for callbacks Glide keeps (the overlay editor, drawCell).
  const latest = useRef({
    changes,
    columns,
    order,
    editable,
    readOnlyProfile,
    selection: props.selection,
  });
  latest.current = {
    changes,
    columns,
    order,
    editable,
    readOnlyProfile,
    selection: props.selection,
  };

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const index = order[col];
      const column = index === undefined ? undefined : columns[index];
      const ref = view.rowAt(row);
      if (!column || !ref || index === undefined) {
        return { kind: GridCellKind.Loading, allowOverlay: false };
      }
      const value = view.valueAt(ref, index);
      const display = displayCell(value);
      const status = rowStatus(changes, ref);
      const edited = ref.key !== null && changes.isEdited(ref.key, column.name);
      const error = ref.key !== null ? cellErrors[cellErrorKey(ref.key, column.name)] : undefined;
      const theme: Partial<Theme> = {};
      if (display.state !== 'value') {
        theme.textDark = palette.muted;
        theme.baseFontStyle = 'italic 12px';
      }
      if (status === 'deleted') theme.textDark = palette.muted;
      if (edited) theme.bgCell = palette.edited;
      if (error !== undefined) theme.bgCell = palette.error;
      return {
        kind: GridCellKind.Text,
        data: value === undefined || isDefault(value) || value === null ? '' : formatCell(value),
        displayData: display.text,
        allowOverlay: true,
        readonly: !editable || status === 'deleted' || column.readOnly !== undefined,
        ...(Object.keys(theme).length > 0 ? { themeOverride: theme } : {}),
        // Numbers align right, except where the foreign key link sits at the right edge.
        ...(['integer', 'bigint', 'decimal', 'float'].includes(column.kind) &&
        display.state === 'value' &&
        !foreignKeyColumns.has(column.name)
          ? { contentAlign: 'right' as const }
          : {}),
      };
    },
    // `paging.version` changes whenever loaded rows change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      view,
      columns,
      order,
      changes,
      cellErrors,
      palette,
      editable,
      foreignKeyColumns,
      paging.version,
    ],
  );

  const getRowThemeOverride = useCallback(
    (row: number): Partial<Theme> | undefined => {
      const ref = view.rowAt(row);
      if (!ref) return undefined;
      const status = rowStatus(changes, ref);
      if (status === 'inserted') return { bgCell: palette.inserted };
      if (status === 'deleted') return { bgCell: palette.deleted };
      return undefined;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, changes, palette, paging.version],
  );

  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      drawContent();
      const { ctx, rect, row, col } = args;
      const ref = view.rowAt(row);
      const index = order[col];
      const column = index === undefined ? undefined : columns[index];
      if (!ref || !column || index === undefined) return;
      if (rowStatus(changes, ref) === 'deleted') {
        const y = Math.round(rect.y + rect.height / 2) + 0.5;
        ctx.save();
        ctx.strokeStyle = palette.strike;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(rect.x + 4, y);
        ctx.lineTo(rect.x + rect.width - 4, y);
        ctx.stroke();
        ctx.restore();
      }
      if (foreignKeyColumns.has(column.name)) {
        const value = view.valueAt(ref, index);
        if (value !== null && value !== undefined && !isDefault(value)) {
          ctx.save();
          ctx.fillStyle = palette.link;
          ctx.font = '12px sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText('↗', rect.x + rect.width - 14, rect.y + rect.height / 2);
          ctx.restore();
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, columns, order, changes, palette, foreignKeyColumns, paging.version],
  );

  const provideEditor = useMemo<ProvideEditorCallback<GridCell>>(() => {
    const Editor: ProvideEditorComponent<TextCell> = (editorProps) => {
      // The cell being edited is the selected one; fixed for the life of the overlay.
      const [target] = useState(() => {
        const cell = latest.current.selection.current?.cell;
        if (!cell) return undefined;
        const [col, row] = cell;
        const ref = view.rowAt(row);
        const index = latest.current.order[col];
        const column = index === undefined ? undefined : latest.current.columns[index];
        return ref && column && index !== undefined
          ? { ref, column, col, value: view.valueAt(ref, index) }
          : undefined;
      });
      const [full, setFull] = useState(target?.value);
      const onChange = useRef(editorProps.onChange);
      onChange.current = editorProps.onChange;
      const cell = useRef(editorProps.value);
      const loadingFull = useRef(false);
      if (target && isLargeValue(full) && !loadingFull.current) {
        loadingFull.current = true;
        void view.fullValue(target.ref, target.column.name).then(setFull, () => undefined);
      }
      const onDraft = useCallback((draft: Draft) => {
        onChange.current(
          draft.ok ? tokenCell(cell.current, draft.value) : { ...cell.current, data: INVALID },
        );
      }, []);
      if (!target) return null;
      const { ref, column } = target;
      const status = rowStatus(latest.current.changes, ref);
      const locked = !latest.current.editable
        ? latest.current.readOnlyProfile
          ? 'This connection is read-only'
          : 'This table has no key, so it is read-only'
        : status === 'deleted'
          ? 'The row is marked for deletion'
          : column.readOnly;
      const fks = view.foreignKeysOf(column.name).filter((fk) => fk.columns.length === 1);
      const fk = fks[0];
      const pasteError =
        ref.key !== null ? view.state.cellErrors[cellErrorKey(ref.key, column.name)] : undefined;
      return (
        <CellEditor
          variant="overlay"
          column={column}
          value={full}
          canDefault={
            latest.current.editable &&
            status !== 'deleted' &&
            (ref.kind === 'insert' || column.hasDefault)
          }
          {...(locked !== undefined ? { locked } : {})}
          {...(fk ? { lookup: (search: string) => view.lookup(fk, search) } : {})}
          {...(editorProps.initialValue !== undefined
            ? { initialText: editorProps.initialValue }
            : {})}
          {...(pasteError !== undefined ? { note: `Not pasted: ${pasteError}` } : {})}
          onDraft={onDraft}
          onCommit={(value) =>
            editorProps.onFinishedEditing(tokenCell(cell.current, value), [0, 0])
          }
          onCancel={() => editorProps.onFinishedEditing(undefined, [0, 0])}
        />
      );
    };
    return (cell) =>
      cell.kind === GridCellKind.Text
        ? ({ editor: Editor, disablePadding: true, disableStyling: true } as ReturnType<
            ProvideEditorCallback<GridCell>
          >)
        : undefined;
    // One editor component for the grid's life; it reads current data through `latest`.
  }, [view]);

  const onCellEdited = useCallback(
    ([col, row]: Item, cell: EditableGridCell) => {
      if (cell.kind !== GridCellKind.Text) return;
      const value = pendingEdits.get(cell.data);
      pendingEdits.clear();
      const index = order[col];
      const column = index === undefined ? undefined : columns[index];
      const ref = view.rowAt(row);
      if (value === undefined || !column || !ref || index === undefined) return;
      if (sameValue(view.valueAt(ref, index), value)) return;
      view.setCell(ref, column.name, value);
    },
    [view, columns, order],
  );

  const openHeaderMenu = (col: number, x: number, y: number): void => {
    const index = order[col];
    const column = index === undefined ? undefined : columns[index];
    if (column) setHeaderMenu({ x, y, key: column.name });
  };

  const [menu, setMenu] = useState<MenuAt>();

  return (
    <div
      className="relative h-full w-full"
      data-testid="table-grid"
      // Paste from Excel or Sheets: the paste event carries the clipboard text, which needs no
      // clipboard permission (Glide's own paste reads the clipboard API, which the app denies).
      onPaste={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest('input, textarea, [data-testid="cell-editor"]')) return;
        const range = props.selection.current?.range;
        const text = event.clipboardData.getData('text/plain');
        if (!range || text === '') return;
        event.preventDefault();
        view.paste(range.y, range.x, parsePastedText(text));
      }}
    >
      <DataEditor
        ref={props.gridRef}
        width="100%"
        height="100%"
        columns={gridColumns}
        rows={rows}
        getCellContent={getCellContent}
        getCellsForSelection
        getRowThemeOverride={getRowThemeOverride}
        drawCell={drawCell}
        provideEditor={provideEditor}
        onCellEdited={onCellEdited}
        onFinishedEditing={() => pendingEdits.clear()}
        rowMarkers="clickable-number"
        smoothScrollX
        smoothScrollY
        theme={props.theme === 'dark' ? DARK : LIGHT}
        rowHeight={26}
        headerHeight={28}
        gridSelection={props.selection}
        onGridSelectionChange={props.onSelectionChange}
        onHeaderClicked={(col, event) => {
          const index = order[col];
          const column = index === undefined ? undefined : columns[index];
          if (column) void view.toggleSort(column.name, event.shiftKey);
        }}
        onHeaderMenuClick={(col, bounds) => openHeaderMenu(col, bounds.x, bounds.y + bounds.height)}
        onHeaderContextMenu={(col, event) => {
          event.preventDefault();
          openHeaderMenu(
            col,
            event.bounds.x + event.localEventX,
            event.bounds.y + event.localEventY,
          );
        }}
        freezeColumns={display.frozen}
        onColumnMoved={(from, to) => view.setLayout(moveColumn(view.state.layout, from, to))}
        onVisibleRegionChanged={(range) => view.onVisibleRows(range.y + range.height)}
        onColumnResize={(column, width) => {
          const id = column.id;
          if (id !== undefined) view.setLayout(setWidth(view.state.layout, id, width));
        }}
        onCellClicked={([col, row], event) => {
          const index = order[col];
          const column = index === undefined ? undefined : columns[index];
          if (!column || !foreignKeyColumns.has(column.name)) return;
          if (event.localEventX >= event.bounds.width - 20) props.onOpenReferenced(row, col);
        }}
        onCellContextMenu={([col, row], event) => {
          event.preventDefault();
          const inSelection =
            props.selection.rows.hasIndex(row) ||
            (props.selection.current !== undefined &&
              col >= props.selection.current.range.x &&
              col < props.selection.current.range.x + props.selection.current.range.width &&
              row >= props.selection.current.range.y &&
              row < props.selection.current.range.y + props.selection.current.range.height);
          const selection: GridSelection = inSelection
            ? props.selection
            : {
                ...EMPTY_SELECTION,
                current: {
                  cell: [col, row],
                  range: { x: col, y: row, width: 1, height: 1 },
                  rangeStack: [],
                },
              };
          if (!inSelection) props.onSelectionChange(selection);
          setMenu({
            x: event.bounds.x + event.localEventX,
            y: event.bounds.y + event.localEventY,
            col,
            row,
            selection,
          });
        }}
        keybindings={{ paste: false }}
        onDelete={(selection) => {
          if (selection.rows.length > 0) {
            const refs = selection.rows
              .toArray()
              .map((row) => view.rowAt(row))
              .filter((ref) => ref !== undefined);
            view.deleteRows(refs);
            return false;
          }
          const range = selection.current?.range;
          if (!range) return false;
          const cells = [];
          for (let r = range.y; r < range.y + range.height; r++) {
            const ref = view.rowAt(r);
            if (!ref) continue;
            for (let c = range.x; c < range.x + range.width; c++) {
              const index = order[c];
              const column = index === undefined ? undefined : columns[index];
              if (column?.nullable && column.readOnly === undefined) {
                cells.push({ ref, column: column.name, value: null });
              }
            }
          }
          if (cells.length > 0) view.setCells(cells);
          return false;
        }}
      />
      {menu && (
        <TableContextMenu
          view={view}
          at={menu}
          onClose={() => setMenu(undefined)}
          onOpenReferenced={props.onOpenReferenced}
        />
      )}
      {headerMenu && (
        <HeaderMenu
          at={headerMenu}
          layout={layout}
          label={headerMenu.key}
          onChange={(next) => view.setLayout(next)}
          onClose={() => setHeaderMenu(undefined)}
          onSort={(direction) => void view.sortBy(headerMenu.key, direction)}
        />
      )}
    </div>
  );
}

/** The ChangeSet a component renders with (re-exported for the panel's toolbar). */
export function useChanges(view: TableView): ChangeSet {
  return useSyncExternalStore(view.changes.subscribe, view.changes.getSnapshot);
}
